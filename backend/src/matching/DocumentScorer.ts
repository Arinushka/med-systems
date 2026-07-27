import type { MatchPipelineConfig, MatchType, SimilaritySignals } from './types.js'

export interface IDocumentScorer {
  score(signals: SimilaritySignals): { finalScore: number; matchType: MatchType; isMatch: boolean }
}

export class DocumentScorer implements IDocumentScorer {
  constructor(private readonly config: MatchPipelineConfig) {}

  score(signals: SimilaritySignals): { finalScore: number; matchType: MatchType; isMatch: boolean } {
    const finalScore =
      signals.semantic * this.config.semanticWeight +
      signals.lexical * this.config.lexicalWeight +
      signals.structural * this.config.structuralWeight +
      signals.exactFields * this.config.exactFieldsWeight +
      signals.metadata * this.config.metadataWeight

    let matchType: MatchType = 'not_match'
    if (finalScore >= 0.93 && signals.coverageAByB >= 0.92 && signals.coverageBByA >= 0.92) matchType = 'exact_duplicate'
    else if (finalScore >= 0.88 && signals.coverageAByB >= 0.8 && signals.coverageBByA >= 0.8) matchType = 'near_duplicate'
    else if (finalScore >= 0.8 && (signals.coverageAByB >= 0.75 || signals.coverageBByA >= 0.75)) matchType = 'same_document_modified'
    else if (finalScore >= 0.7 && signals.exactFields >= 0.35) matchType = 'same_entity_different_document'
    else if (finalScore >= 0.62 && (signals.coverageAByB >= 0.55 || signals.coverageBByA >= 0.55)) matchType = 'partial_match'
    else if (finalScore >= 0.52) matchType = 'related'
    else if (finalScore >= 0.45) matchType = 'uncertain'

    const isMatch =
      finalScore >= this.config.documentMatchThreshold ||
      matchType === 'exact_duplicate' ||
      matchType === 'near_duplicate' ||
      matchType === 'same_document_modified'

    return { finalScore, matchType, isMatch }
  }
}
