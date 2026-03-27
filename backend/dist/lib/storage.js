import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, } from '@aws-sdk/client-s3';
function makeStoredName(id, originalFilename) {
    return `${id}-${originalFilename}`;
}
class LocalLibraryStorage {
    libDir;
    constructor(libDir) {
        this.libDir = libDir;
    }
    async save(params) {
        await fs.mkdir(this.libDir, { recursive: true });
        const name = makeStoredName(params.id, params.originalFilename);
        const storedPath = path.join(this.libDir, name);
        await fs.writeFile(storedPath, params.buffer);
        return storedPath;
    }
    async read(storedPath) {
        return await fs.readFile(storedPath);
    }
    async remove(storedPath) {
        await fs.rm(storedPath, { force: true });
    }
    async list() {
        await fs.mkdir(this.libDir, { recursive: true });
        const names = await fs.readdir(this.libDir);
        return names.map((name) => ({ name, storedPath: path.join(this.libDir, name) }));
    }
    async clearAll() {
        await fs.rm(this.libDir, { recursive: true, force: true });
    }
    toName(storedPath) {
        return path.basename(storedPath);
    }
}
function toBool(v, fallback) {
    if (v == null)
        return fallback;
    const n = v.trim().toLowerCase();
    if (n === '1' || n === 'true' || n === 'yes' || n === 'on')
        return true;
    if (n === '0' || n === 'false' || n === 'no' || n === 'off')
        return false;
    return fallback;
}
async function bodyToBuffer(body) {
    if (!body)
        return Buffer.alloc(0);
    if (Buffer.isBuffer(body))
        return body;
    if (body instanceof Uint8Array)
        return Buffer.from(body);
    if (body instanceof Readable) {
        const chunks = [];
        for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    if (typeof body.transformToByteArray === 'function') {
        const arr = await body.transformToByteArray();
        return Buffer.from(arr);
    }
    throw new Error('Unsupported S3 body type');
}
class S3LibraryStorage {
    bucket;
    prefix;
    client;
    constructor() {
        const bucket = process.env.S3_BUCKET;
        if (!bucket)
            throw new Error('S3_BUCKET is required when STORAGE_PROVIDER=s3');
        this.bucket = bucket;
        const rawPrefix = process.env.S3_PREFIX ?? 'library/';
        this.prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
        this.client = new S3Client({
            region: process.env.S3_REGION ?? 'us-east-1',
            endpoint: process.env.S3_ENDPOINT || undefined,
            forcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, false),
            credentials: process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
                ? {
                    accessKeyId: process.env.S3_ACCESS_KEY_ID,
                    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
                }
                : undefined,
        });
    }
    makeKey(id, originalFilename) {
        return `${this.prefix}${makeStoredName(id, originalFilename)}`;
    }
    keyToStoredPath(key) {
        return `s3://${this.bucket}/${key}`;
    }
    parseKey(storedPath) {
        const prefix = `s3://${this.bucket}/`;
        if (storedPath.startsWith(prefix))
            return storedPath.slice(prefix.length);
        if (storedPath.startsWith('s3://')) {
            const firstSlash = storedPath.indexOf('/', 5);
            return firstSlash >= 0 ? storedPath.slice(firstSlash + 1) : storedPath;
        }
        return storedPath;
    }
    async save(params) {
        const key = this.makeKey(params.id, params.originalFilename);
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: params.buffer,
        }));
        return this.keyToStoredPath(key);
    }
    async read(storedPath) {
        const key = this.parseKey(storedPath);
        const obj = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
        return await bodyToBuffer(obj.Body);
    }
    async remove(storedPath) {
        const key = this.parseKey(storedPath);
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
        }));
    }
    async list() {
        const out = [];
        let token;
        do {
            const resp = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: this.prefix,
                ContinuationToken: token,
            }));
            for (const obj of resp.Contents ?? []) {
                if (!obj.Key)
                    continue;
                out.push({
                    storedPath: this.keyToStoredPath(obj.Key),
                    name: path.basename(obj.Key),
                });
            }
            token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (token);
        return out;
    }
    async clearAll() {
        let token;
        do {
            const resp = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: this.prefix,
                ContinuationToken: token,
            }));
            const objects = (resp.Contents ?? []).filter((x) => Boolean(x.Key)).map((x) => ({ Key: x.Key }));
            if (objects.length > 0) {
                await this.client.send(new DeleteObjectsCommand({
                    Bucket: this.bucket,
                    Delete: { Objects: objects, Quiet: true },
                }));
            }
            token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (token);
    }
    toName(storedPath) {
        const key = this.parseKey(storedPath);
        return path.basename(key);
    }
}
export function createLibraryStorage(libDir) {
    const provider = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
    if (provider === 's3')
        return new S3LibraryStorage();
    return new LocalLibraryStorage(libDir);
}
