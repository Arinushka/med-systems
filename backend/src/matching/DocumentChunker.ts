import type { DocumentChunk, DocumentSection } from './types.js'

export interface IDocumentChunker {
  chunk(sections: DocumentSection[]): DocumentChunk[]
}

export class DocumentChunker implements IDocumentChunker {
  constructor(
    private readonly chunkSizeTokens: number,
    private readonly chunkOverlapPercent: number,
  ) {}

  private estimateTokens(text: string): number {
    const words = String(text ?? '')
      .split(/\s+/)
      .filter(Boolean).length
    return Math.max(1, Math.ceil(words * 1.35))
  }

  chunk(sections: DocumentSection[]): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    let idx = 0

    for (const section of sections) {
      const lines = String(section.text ?? '')
        .split(/\n+/)
        .map((x) => x.trim())
        .filter(Boolean)
      if (lines.length === 0) continue

      const words = lines.join(' ').split(/\s+/).filter(Boolean)
      if (words.length === 0) continue

      const step = Math.max(1, Math.floor(this.chunkSizeTokens * (1 - this.chunkOverlapPercent / 100)))
      const size = Math.max(100, this.chunkSizeTokens)

      for (let i = 0; i < words.length; i += step) {
        const slice = words.slice(i, i + size)
        if (slice.length === 0) continue
        if (slice.length < 40 && i > 0 && i + size < words.length) continue
        const text = `${section.heading}\n${slice.join(' ')}`
        chunks.push({
          id: `chunk-${idx++}`,
          sectionHeading: section.heading,
          text,
          tokensEstimate: this.estimateTokens(text),
        })
        if (i + size >= words.length) break
      }
    }

    return chunks
  }
}
