import { pipeline } from '@xenova/transformers'

let extractorPromise: Promise<any> | null = null

async function getExtractor() {
  if (!extractorPromise) {
    const model = process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'
    extractorPromise = pipeline('feature-extraction', model)
  }
  return extractorPromise
}

export async function embedTextsLocal(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor()

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

