import { cosineSimilarity } from '../utils/cosine.js'
import type { ParsedDocument } from './types.js'

export type SemanticResult = {
  semantic: number
  coverageAByB: number
  coverageBByA: number
  containmentScore: number
}

export interface ISemanticMatcher {
  score(query: ParsedDocument, candidate: ParsedDocument): SemanticResult
}

function safeCosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0
  return Math.max(-1, Math.min(1, cosineSimilarity(a, b)))
}

function bestMatches(source: Array<{ embedding?: number[] }>, target: Array<{ embedding?: number[] }>): number[] {
  const out: number[] = []
  for (const s of source) {
    let best = -1
    for (const t of target) {
      const c = safeCosine(s.embedding, t.embedding)
      if (c > best) best = c
    }
    if (best >= -1) out.push(best)
  }
  return out
}

function avgTopK(values: number[], k: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => b - a)
  const top = sorted.slice(0, Math.max(1, Math.min(sorted.length, k)))
  return top.reduce((acc, x) => acc + x, 0) / top.length
}

export class SemanticMatcher implements ISemanticMatcher {
  constructor(private readonly topKChunkMatches: number) {}

  score(query: ParsedDocument, candidate: ParsedDocument): SemanticResult {
    const qChunks = query.chunks.filter((c) => Array.isArray(c.embedding))
    const cChunks = candidate.chunks.filter((c) => Array.isArray(c.embedding))
    if (qChunks.length === 0 || cChunks.length === 0) {
      return {
        semantic: 0,
        coverageAByB: 0,
        coverageBByA: 0,
        containmentScore: 0,
      }
    }

    const aToB = bestMatches(qChunks, cChunks)
    const bToA = bestMatches(cChunks, qChunks)

    const coverageThreshold = Number(process.env.MATCH_SEMANTIC_COVERAGE_THRESHOLD ?? 0.62)
    const coverageAByB = aToB.filter((x) => x >= coverageThreshold).length / Math.max(1, aToB.length)
    const coverageBByA = bToA.filter((x) => x >= coverageThreshold).length / Math.max(1, bToA.length)
    const containmentScore = Math.min(coverageAByB, coverageBByA)

    const semanticForward = avgTopK(aToB, this.topKChunkMatches)
    const semanticBackward = avgTopK(bToA, this.topKChunkMatches)
    const semantic = Math.max(0, Math.min(1, (semanticForward + semanticBackward) / 2))

    return {
      semantic,
      coverageAByB,
      coverageBByA,
      containmentScore,
    }
  }
}
