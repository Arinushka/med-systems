import { CandidateRetriever } from './CandidateRetriever.js'
import { DocumentChunker } from './DocumentChunker.js'
import { DocumentScorer } from './DocumentScorer.js'
import { DefaultEmbeddingProvider } from './EmbeddingProvider.js'
import { ExactFieldMatcher } from './ExactFieldMatcher.js'
import { FileParser } from './FileParser.js'
import { KeyFieldExtractor } from './KeyFieldExtractor.js'
import { LexicalMatcher } from './LexicalMatcher.js'
import { MatchExplanationBuilder } from './MatchExplanationBuilder.js'
import { MatchPipeline } from './MatchPipeline.js'
import { MatchReranker } from './MatchReranker.js'
import { MetadataExtractor } from './MetadataExtractor.js'
import { SemanticMatcher } from './SemanticMatcher.js'
import { StructuralMatcher } from './StructuralMatcher.js'
import { TextNormalizer } from './TextNormalizer.js'
import { InMemoryVectorRepository } from './VectorRepository.js'
import type { MatchPipelineConfig } from './types.js'

export function readMatchPipelineConfig(): MatchPipelineConfig {
  return {
    chunkSizeTokens: Math.max(300, Number(process.env.MATCH_CHUNK_SIZE_TOKENS ?? 600)),
    chunkOverlapPercent: Math.max(5, Number(process.env.MATCH_CHUNK_OVERLAP_PERCENT ?? 15)),
    semanticWeight: Number(process.env.MATCH_WEIGHT_SEMANTIC ?? 0.5),
    lexicalWeight: Number(process.env.MATCH_WEIGHT_LEXICAL ?? 0.2),
    structuralWeight: Number(process.env.MATCH_WEIGHT_STRUCTURAL ?? 0.1),
    exactFieldsWeight: Number(process.env.MATCH_WEIGHT_EXACT ?? 0.15),
    metadataWeight: Number(process.env.MATCH_WEIGHT_METADATA ?? 0.05),
    documentMatchThreshold: Number(process.env.DOCUMENT_MATCH_THRESHOLD ?? 0.62),
    llmRerankThresholdLow: Number(process.env.MATCH_RERANK_LOW ?? 0.45),
    llmRerankThresholdHigh: Number(process.env.MATCH_RERANK_HIGH ?? 0.75),
    topKChunkMatches: Math.max(1, Number(process.env.MATCH_TOP_K_CHUNK_MATCHES ?? 5)),
  }
}

export function createMatchingRuntime() {
  const config = readMatchPipelineConfig()
  const textNormalizer = new TextNormalizer()
  const metadataExtractor = new MetadataExtractor()
  const keyFieldExtractor = new KeyFieldExtractor()
  const chunker = new DocumentChunker(config.chunkSizeTokens, config.chunkOverlapPercent)
  const fileParser = new FileParser(metadataExtractor, textNormalizer, chunker, keyFieldExtractor)
  const embeddings = new DefaultEmbeddingProvider()
  const vectors = new InMemoryVectorRepository()
  const lexicalMatcher = new LexicalMatcher()
  const semanticMatcher = new SemanticMatcher(config.topKChunkMatches)
  const structuralMatcher = new StructuralMatcher()
  const exactFieldMatcher = new ExactFieldMatcher()
  const scorer = new DocumentScorer(config)
  const reranker = new MatchReranker()
  const explanationBuilder = new MatchExplanationBuilder()
  const retriever = new CandidateRetriever(lexicalMatcher)
  const pipeline = new MatchPipeline(
    config,
    embeddings,
    vectors,
    retriever,
    lexicalMatcher,
    semanticMatcher,
    structuralMatcher,
    exactFieldMatcher,
    scorer,
    reranker,
    explanationBuilder,
  )

  return { config, fileParser, pipeline, embeddings }
}
