export function normalizeText(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function chunkText(text: string, opts?: { chunkChars?: number; overlapChars?: number }): string[] {
  const chunkChars = opts?.chunkChars ?? 3500
  const overlapChars = opts?.overlapChars ?? 400

  if (!text) return []

  // Simple paragraph-based chunking; helps keep embeddings aligned to semantic blocks.
  const paragraphs = text.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean)

  const chunks: string[] = []
  let current = ''

  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p
    if (candidate.length <= chunkChars) {
      current = candidate
      continue
    }

    if (current) chunks.push(current)

    // If a single paragraph is too large, fall back to sliding window.
    if (p.length > chunkChars) {
      for (let i = 0; i < p.length; i += (chunkChars - overlapChars)) {
        chunks.push(p.slice(i, i + chunkChars))
      }
      current = ''
    } else {
      current = p
    }
  }

  if (current) chunks.push(current)
  return chunks
}

