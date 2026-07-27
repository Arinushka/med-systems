# Backend Matching Pipeline

## Overview

The backend now uses a hybrid document-matching pipeline with modular components:

- `FileParser`
- `TextNormalizer`
- `DocumentChunker`
- `MetadataExtractor`
- `KeyFieldExtractor`
- `EmbeddingProvider`
- `VectorRepository`
- `CandidateRetriever`
- `LexicalMatcher`
- `SemanticMatcher`
- `StructuralMatcher`
- `ExactFieldMatcher`
- `DocumentScorer`
- `MatchReranker`
- `MatchExplanationBuilder`

This is integrated into the existing `/api/match` flow and does not replace public API contracts.

## Supported formats

- `PDF`, `DOC`, `DOCX`, `XLS`, `XLSX`
- `TXT`, `CSV`, `HTML`, `JSON`, `XML`

## Embeddings providers

Configure via `.env`:

- `EMBEDDINGS_PROVIDER=local|openai|ollama`
- `OPENAI_EMBEDDING_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_EMBEDDING_MODEL`

For Ollama embeddings, the backend uses `/api/embeddings` and validates vector dimensions.

## Matching configuration

Important options:

- `DOCUMENT_MATCH_THRESHOLD`
- `MATCH_CHUNK_SIZE_TOKENS`
- `MATCH_CHUNK_OVERLAP_PERCENT`
- `MATCH_WEIGHT_SEMANTIC`
- `MATCH_WEIGHT_LEXICAL`
- `MATCH_WEIGHT_STRUCTURAL`
- `MATCH_WEIGHT_EXACT`
- `MATCH_WEIGHT_METADATA`
- `MATCH_RERANK_LOW`
- `MATCH_RERANK_HIGH`
- `OLLAMA_RERANK_MODEL`

## Test commands

```bash
npm run typecheck
npm run test
```

Tests include:

- format extraction checks for `txt/csv/html/json/xml`
- hybrid matching quality metrics (`precision`, `recall`, `F1`, `FPR`, `FNR`) on synthetic regression pairs
