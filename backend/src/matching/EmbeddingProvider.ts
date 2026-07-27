import { embedTexts } from '../lib/openaiEmbeddings.js'

export interface IEmbeddingProvider {
  modelId(): string
  embed(texts: string[]): Promise<number[][]>
}

function normalizeVector(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm <= 1e-12) return v
  return v.map((x) => x / norm)
}

export class DefaultEmbeddingProvider implements IEmbeddingProvider {
  modelId(): string {
    const provider = String(process.env.EMBEDDINGS_PROVIDER ?? 'local').toLowerCase()
    if (provider === 'ollama') return `ollama:${process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text'}`
    if (provider === 'openai') return `openai:${process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'}`
    return `local:${process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`
  }

  private async embedWithOllama(texts: string[]): Promise<number[][]> {
    const baseUrl = String(process.env.OLLAMA_BASE_URL ?? '').trim() || ''
    const chatUrl = String(process.env.OLLAMA_URL ?? '').trim()
    const endpoint = baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/api/embeddings`
      : chatUrl
        ? `${chatUrl.replace(/\/api\/chat.*$/i, '').replace(/\/+$/, '')}/api/embeddings`
        : 'http://127.0.0.1:11434/api/embeddings'
    const model = String(process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text').trim()
    const timeoutMs = Number(process.env.OLLAMA_EMBEDDING_TIMEOUT_MS ?? 30000)
    const batchSize = Math.max(1, Number(process.env.OLLAMA_EMBEDDING_BATCH_SIZE ?? 16))
    const retryCount = Math.max(0, Number(process.env.OLLAMA_EMBEDDING_RETRY_COUNT ?? 2))

    const result: number[][] = []
    let expectedDim: number | null = null

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      for (const text of batch) {
        let lastError: string | null = null
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const resp = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: controller.signal,
              body: JSON.stringify({
                model,
                prompt: text,
              }),
            })
            if (!resp.ok) {
              const body = await resp.text().catch(() => '')
              throw new Error(`Ollama embeddings HTTP ${resp.status}: ${body.slice(0, 300)}`)
            }
            const json: unknown = await resp.json()
            const emb = Array.isArray((json as { embedding?: unknown } | null)?.embedding)
              ? ((json as { embedding: unknown[] }).embedding as number[])
              : null
            if (!emb || emb.length === 0) throw new Error('Ollama embeddings payload has no vector')
            if (!emb.every((x) => Number.isFinite(Number(x)))) throw new Error('Ollama embeddings contains non-numeric values')
            if (expectedDim == null) expectedDim = emb.length
            if (expectedDim !== emb.length) {
              throw new Error(`Ollama embeddings dimension mismatch: expected ${expectedDim}, got ${emb.length}`)
            }
            result.push(normalizeVector(emb.map((x) => Number(x))))
            lastError = null
            break
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e)
            if (attempt >= retryCount) break
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
          } finally {
            clearTimeout(timer)
          }
        }
        if (lastError) {
          throw new Error(`Failed to embed with Ollama model "${model}": ${lastError}`)
        }
      }
    }

    return result
  }

  async embed(texts: string[]): Promise<number[][]> {
    const provider = String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase()
    if (provider === 'ollama') return await this.embedWithOllama(texts)
    const vectors = await embedTexts(texts)
    return vectors.map((v) => normalizeVector(v.map((x) => Number(x))))
  }
}
