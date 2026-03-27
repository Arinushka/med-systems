import OpenAI from 'openai'
import { embedTextsLocal } from './localEmbeddings'
import { createProxiedOpenaiFetch } from './openaiFetchProxy'

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const provider = String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase()
  if (provider === 'local') {
    // Force local embeddings (free mode).
    return embedTextsLocal(texts)
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    // Fallback mode: no API key => use local embeddings via transformers.js.
    return embedTextsLocal(texts)
  }

  const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
  const openai = new OpenAI({
    apiKey,
    fetch: createProxiedOpenaiFetch(),
  })

  // Request embeddings in batches to avoid huge payloads.
  const batchSize = 64
  const results: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    let resp: any
    try {
      resp = await openai.embeddings.create({
        model: embeddingModel,
        input: batch,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // When OpenAI blocks by country/region, the SDK will throw (often with 403).
      if (msg.toLowerCase().includes('not supported') || msg.includes('403')) {
        const force = process.env.OPENAI_FORCE === 'true'
        if (force) {
          throw new Error(
            `OpenAI blocked (403/not supported). VPN/proxy to supported region required. Original error: ${msg}`,
          )
        }
        return embedTextsLocal(texts)
      }

      throw e
    }

    // Preserve order from OpenAI response.
    const vectors = resp.data.map((d: any) => d.embedding as number[])
    results.push(...vectors)
  }

  return results
}

