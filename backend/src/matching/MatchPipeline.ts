import type { IEmbeddingProvider } from './EmbeddingProvider.js'
import type { IVectorRepository } from './VectorRepository.js'
import type { ICandidateRetriever } from './CandidateRetriever.js'
import type { ILexicalMatcher } from './LexicalMatcher.js'
import type { ISemanticMatcher } from './SemanticMatcher.js'
import type { IStructuralMatcher } from './StructuralMatcher.js'
import type { IExactFieldMatcher } from './ExactFieldMatcher.js'
import type { IDocumentScorer } from './DocumentScorer.js'
import type { IMatchReranker } from './MatchReranker.js'
import type { IMatchExplanationBuilder } from './MatchExplanationBuilder.js'
import type { MatchDecision, MatchPipelineConfig, ParsedDocument, SimilaritySignals } from './types.js'

type CandidateScore = {
  document: ParsedDocument
  decision: MatchDecision
}

export class MatchPipeline {
  constructor(
    _config: MatchPipelineConfig,
    private readonly embeddings: IEmbeddingProvider,
    private readonly vectors: IVectorRepository,
    private readonly candidateRetriever: ICandidateRetriever,
    private readonly lexicalMatcher: ILexicalMatcher,
    private readonly semanticMatcher: ISemanticMatcher,
    private readonly structuralMatcher: IStructuralMatcher,
    private readonly exactFieldMatcher: IExactFieldMatcher,
    private readonly scorer: IDocumentScorer,
    private readonly reranker: IMatchReranker,
    private readonly explanationBuilder: IMatchExplanationBuilder,
  ) {}

  private async ensureChunkEmbeddings(document: ParsedDocument): Promise<void> {
    const missing = document.chunks.filter((c) => !Array.isArray(c.embedding) || c.embedding.length === 0)
    if (missing.length === 0) {
      this.vectors.ensureFromDocument(document, this.embeddings.modelId())
      return
    }
    const vectors = await this.embeddings.embed(missing.map((x) => x.text))
    for (let i = 0; i < missing.length; i++) missing[i].embedding = vectors[i]
    this.vectors.ensureFromDocument(document, this.embeddings.modelId())
  }

  private metadataScore(a: ParsedDocument, b: ParsedDocument): number {
    const extScore = a.metadata.extension === b.metadata.extension ? 1 : 0.4
    const sizeA = Math.max(1, a.metadata.sizeBytes)
    const sizeB = Math.max(1, b.metadata.sizeBytes)
    const ratio = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB)
    return Math.max(0, Math.min(1, extScore * 0.35 + ratio * 0.65))
  }

  private buildInitialDecision(signals: SimilaritySignals, matchedSections: string[], unmatchedSections: string[], conflictingFields: string[]): MatchDecision {
    const { finalScore, matchType, isMatch } = this.scorer.score(signals)
    return {
      isMatch,
      confidence: finalScore,
      matchType,
      scores: signals,
      matchedSections,
      unmatchedSections,
      conflictingFields,
      explanation: '',
    }
  }

  async compare(query: ParsedDocument, library: ParsedDocument[]): Promise<CandidateScore | null> {
    if (library.length === 0) return null
    await this.ensureChunkEmbeddings(query)
    for (const doc of library) await this.ensureChunkEmbeddings(doc)

    const preselected = this.candidateRetriever.retrieve(
      query,
      library,
      Math.max(2, Number(process.env.MATCH_HYBRID_CANDIDATES ?? 12)),
    )

    let best: CandidateScore | null = null
    for (const candidate of preselected) {
      const semanticRes = this.semanticMatcher.score(query, candidate)
      const lexical = this.lexicalMatcher.score(query, candidate)
      const structuralRes = this.structuralMatcher.score(query, candidate)
      const exactRes = this.exactFieldMatcher.score(query, candidate)
      const metadata = this.metadataScore(query, candidate)

      const signals: SimilaritySignals = {
        semantic: semanticRes.semantic,
        lexical,
        structural: structuralRes.structural,
        exactFields: exactRes.exactFields,
        metadata,
        coverageAByB: semanticRes.coverageAByB,
        coverageBByA: semanticRes.coverageBByA,
        containmentScore: semanticRes.containmentScore,
      }

      let decision = this.buildInitialDecision(signals, structuralRes.matchedSections, structuralRes.unmatchedSections, exactRes.conflictingFields)
      decision = await this.reranker.rerankIfNeeded({
        query,
        candidate,
        scores: signals,
        initialDecision: decision,
      })
      decision.explanation = this.explanationBuilder.build(decision)

      if (!best || decision.confidence > best.decision.confidence) {
        best = { document: candidate, decision }
      }
    }

    return best
  }
}
