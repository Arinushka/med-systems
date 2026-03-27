import fs from 'node:fs/promises'
import path from 'node:path'

function restoreUtf8FromLatin1(maybeMojibake: string): string {
  const looksMojibake = /[ÐÑÒÓÖ×ØÙÚÛÜÝÞßà-ÿ]/.test(maybeMojibake)
  if (!looksMojibake) return maybeMojibake

  const restored = Buffer.from(maybeMojibake, 'latin1').toString('utf8')
  if (/[\u0400-\u04FF]/.test(restored)) return restored
  return maybeMojibake
}

export type LibraryChunk = {
  text: string
  embedding?: number[]
}

export type LibraryDoc = {
  id: string
  originalFilename: string
  extension: string
  storedPath: string
  docEmbedding: number[]
  chunksCount?: number
  chunks?: LibraryChunk[]
  rowsCount?: number
  rows?: import('./rows').ParsedRow[]
  indexedAt: string
}

export type LibraryIndex = {
  version: 1
  createdAt: string
  docs: LibraryDoc[]
}

const DATA_DIR = path.join(process.cwd(), 'data')
const INDEX_PATH = path.join(DATA_DIR, 'library-index.json')

export function ensureDataDirPath(p: string): string {
  return path.join(DATA_DIR, p)
}

export async function loadIndex(): Promise<LibraryIndex> {
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as LibraryIndex
    if (!parsed || !Array.isArray(parsed.docs)) throw new Error('Invalid index')

    // Best-effort fix for filenames that were stored with mojibake encoding.
    // This affects display only; embeddings were computed from extracted content.
    for (const d of parsed.docs) {
      if (!d.originalFilename) continue
      const oldFilename = d.originalFilename
      const fixedFilename = restoreUtf8FromLatin1(oldFilename)
      if (fixedFilename === oldFilename) continue

      d.originalFilename = fixedFilename

      const oldSuffix = `${d.id}-${oldFilename}`
      const newSuffix = `${d.id}-${fixedFilename}`
      if (typeof d.storedPath === 'string' && d.storedPath.endsWith(oldSuffix)) {
        d.storedPath = d.storedPath.slice(0, -oldSuffix.length) + newSuffix
      }
    }

    return parsed
  } catch {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      docs: [],
    }
  }
}

export async function saveIndex(index: LibraryIndex): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8')
}

