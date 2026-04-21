import { pipeline } from '@xenova/transformers'

let extractorPromise: Promise<any> | null = null

function hashToken(token: string): number {
  // Stable FNV-1a 32-bit hash for deterministic fallback vectors.
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function normalizeVec(v: number[]): number[] {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum)
  if (norm <= 1e-12) return v
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm
  return v
}

function simpleFallbackEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0)
  const tokens = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return vec
  for (const t of tokens) {
    const h = hashToken(t)
    const idx = h % dim
    const sign = (h & 1) === 0 ? 1 : -1
    vec[idx] = (vec[idx] ?? 0) + sign
  }
  return normalizeVec(vec)
}

async function getExtractor() {
  if (!extractorPromise) {
    const model = process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'
    extractorPromise = pipeline('feature-extraction', model)
  }
  return extractorPromise
}

export async function embedTextsLocal(texts: string[]): Promise<number[][]> {
  let extractor: any = null
  try {
    extractor = await getExtractor()
  } catch (e) {
    const allowFallback = String(process.env.LOCAL_EMBEDDING_FALLBACK_HASH ?? 'true') === 'true'
    if (!allowFallback) throw e
    const fallbackDim = Number(process.env.LOCAL_EMBEDDING_FALLBACK_DIM ?? 384)
    return texts.map((t) => simpleFallbackEmbedding(t ?? '', fallbackDim))
  }

  const batchSize = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE ?? 8)
  const results: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map((t) => t ?? '')
    const tensor = (await extractor(batch, { pooling: 'mean', normalize: true })) as any
    const data = tensor.data as Float32Array
    const dims = tensor.dims as number[] | undefined

    const dim =
      dims && dims.length > 0
        ? dims[dims.length - 1]
        : Math.floor(data.length / Math.max(1, batch.length))

    // tensor.data is flattened: [batch, dim]
    for (let j = 0; j < batch.length; j++) {
      const start = j * dim
      const end = start + dim
      const vec: number[] = []
      for (let k = start; k < end; k++) vec.push(data[k]!)
      results.push(vec)
    }
  }

  return results
}

