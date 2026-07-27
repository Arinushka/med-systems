export type StructuredRow = {
  indicator: string
  valueRaw: string
}

export type DocumentSection = {
  heading: string
  text: string
}

export type DocumentChunk = {
  id: string
  sectionHeading: string
  text: string
  tokensEstimate: number
  embedding?: number[]
}

export type ExtractedMetadata = {
  filename: string
  extension: string
  sizeBytes: number
}

export type ExactFields = {
  contractNumbers: string[]
  identifiers: string[]
  dates: string[]
  emails: string[]
  phones: string[]
  organizationNames: string[]
}

export type ParsedDocument = {
  id: string
  metadata: ExtractedMetadata
  rawText: string
  normalizedText: string
  sections: DocumentSection[]
  rows: StructuredRow[]
  chunks: DocumentChunk[]
  exactFields: ExactFields
  keyTerms: string[]
}

export type SimilaritySignals = {
  semantic: number
  lexical: number
  structural: number
  exactFields: number
  metadata: number
  coverageAByB: number
  coverageBByA: number
  containmentScore: number
}

export type MatchType =
  | 'exact_duplicate'
  | 'near_duplicate'
  | 'same_document_modified'
  | 'same_entity_different_document'
  | 'partial_match'
  | 'related'
  | 'not_match'
  | 'uncertain'

export type MatchDecision = {
  isMatch: boolean
  confidence: number
  matchType: MatchType
  scores: SimilaritySignals
  matchedSections: string[]
  unmatchedSections: string[]
  conflictingFields: string[]
  explanation: string
}

export type MatchPipelineConfig = {
  chunkSizeTokens: number
  chunkOverlapPercent: number
  semanticWeight: number
  lexicalWeight: number
  structuralWeight: number
  exactFieldsWeight: number
  metadataWeight: number
  documentMatchThreshold: number
  llmRerankThresholdLow: number
  llmRerankThresholdHigh: number
  topKChunkMatches: number
}
