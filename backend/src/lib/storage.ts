import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export type StorageFileEntry = {
  storedPath: string
  name: string
}

export interface LibraryStorage {
  save(params: { id: string; originalFilename: string; buffer: Buffer }): Promise<string>
  read(storedPath: string): Promise<Buffer>
  remove(storedPath: string): Promise<void>
  list(): Promise<StorageFileEntry[]>
  clearAll(): Promise<void>
  toName(storedPath: string): string
}

function makeStoredName(id: string, originalFilename: string): string {
  return `${id}-${originalFilename}`
}

class LocalLibraryStorage implements LibraryStorage {
  constructor(private libDir: string) {}

  async save(params: { id: string; originalFilename: string; buffer: Buffer }): Promise<string> {
    await fs.mkdir(this.libDir, { recursive: true })
    const name = makeStoredName(params.id, params.originalFilename)
    const storedPath = path.join(this.libDir, name)
    await fs.writeFile(storedPath, params.buffer)
    return storedPath
  }

  async read(storedPath: string): Promise<Buffer> {
    return await fs.readFile(storedPath)
  }

  async remove(storedPath: string): Promise<void> {
    await fs.rm(storedPath, { force: true })
  }

  async list(): Promise<StorageFileEntry[]> {
    await fs.mkdir(this.libDir, { recursive: true })
    const names = await fs.readdir(this.libDir)
    return names.map((name) => ({ name, storedPath: path.join(this.libDir, name) }))
  }

  async clearAll(): Promise<void> {
    await fs.rm(this.libDir, { recursive: true, force: true })
  }

  toName(storedPath: string): string {
    return path.basename(storedPath)
  }
}

function toBool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback
  const n = v.trim().toLowerCase()
  if (n === '1' || n === 'true' || n === 'yes' || n === 'on') return true
  if (n === '0' || n === 'false' || n === 'no' || n === 'off') return false
  return fallback
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
  if (typeof (body as any).transformToByteArray === 'function') {
    const arr = await (body as any).transformToByteArray()
    return Buffer.from(arr)
  }
  throw new Error('Unsupported S3 body type')
}

class S3LibraryStorage implements LibraryStorage {
  private readonly bucket: string
  private readonly prefix: string
  private readonly client: S3Client

  constructor() {
    const bucket = process.env.S3_BUCKET
    if (!bucket) throw new Error('S3_BUCKET is required when STORAGE_PROVIDER=s3')
    this.bucket = bucket
    const rawPrefix = process.env.S3_PREFIX ?? 'library/'
    this.prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`

    this.client = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, false),
      credentials:
        process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    })
  }

  private makeKey(id: string, originalFilename: string): string {
    return `${this.prefix}${makeStoredName(id, originalFilename)}`
  }

  private keyToStoredPath(key: string): string {
    return `s3://${this.bucket}/${key}`
  }

  private parseKey(storedPath: string): string {
    const prefix = `s3://${this.bucket}/`
    if (storedPath.startsWith(prefix)) return storedPath.slice(prefix.length)
    if (storedPath.startsWith('s3://')) {
      const firstSlash = storedPath.indexOf('/', 5)
      return firstSlash >= 0 ? storedPath.slice(firstSlash + 1) : storedPath
    }
    return storedPath
  }

  async save(params: { id: string; originalFilename: string; buffer: Buffer }): Promise<string> {
    const key = this.makeKey(params.id, params.originalFilename)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: params.buffer,
      }),
    )
    return this.keyToStoredPath(key)
  }

  async read(storedPath: string): Promise<Buffer> {
    const key = this.parseKey(storedPath)
    const obj = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
    return await bodyToBuffer(obj.Body)
  }

  async remove(storedPath: string): Promise<void> {
    const key = this.parseKey(storedPath)
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
  }

  async list(): Promise<StorageFileEntry[]> {
    const out: StorageFileEntry[] = []
    let token: string | undefined
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: token,
        }),
      )
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue
        out.push({
          storedPath: this.keyToStoredPath(obj.Key),
          name: path.basename(obj.Key),
        })
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined
    } while (token)
    return out
  }

  async clearAll(): Promise<void> {
    let token: string | undefined
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.prefix,
          ContinuationToken: token,
        }),
      )
      const objects = (resp.Contents ?? []).filter((x) => Boolean(x.Key)).map((x) => ({ Key: x.Key! }))
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        )
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined
    } while (token)
  }

  toName(storedPath: string): string {
    const key = this.parseKey(storedPath)
    return path.basename(key)
  }
}

export function createLibraryStorage(libDir: string): LibraryStorage {
  const provider = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase()
  if (provider === 's3') return new S3LibraryStorage()
  return new LocalLibraryStorage(libDir)
}

