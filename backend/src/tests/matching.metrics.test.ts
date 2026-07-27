import test from 'node:test'
import assert from 'node:assert/strict'
import { CandidateRetriever } from '../matching/CandidateRetriever.js'
import { DocumentChunker } from '../matching/DocumentChunker.js'
import { DocumentScorer } from '../matching/DocumentScorer.js'
import type { IEmbeddingProvider } from '../matching/EmbeddingProvider.js'
import { ExactFieldMatcher } from '../matching/ExactFieldMatcher.js'
import { LexicalMatcher } from '../matching/LexicalMatcher.js'
import { MatchExplanationBuilder } from '../matching/MatchExplanationBuilder.js'
import { MatchPipeline } from '../matching/MatchPipeline.js'
import { MatchReranker } from '../matching/MatchReranker.js'
import { SemanticMatcher } from '../matching/SemanticMatcher.js'
import { StructuralMatcher } from '../matching/StructuralMatcher.js'
import { InMemoryVectorRepository } from '../matching/VectorRepository.js'
import type { MatchPipelineConfig, ParsedDocument } from '../matching/types.js'
import { KeyFieldExtractor } from '../matching/KeyFieldExtractor.js'
import { MetadataExtractor } from '../matching/MetadataExtractor.js'
import { TextNormalizer } from '../matching/TextNormalizer.js'

class TestEmbeddingProvider implements IEmbeddingProvider {
  modelId(): string {
    return 'test-hash-v1'
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const dim = 128
      const v = new Array<number>(dim).fill(0)
      const tokens = text
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter((x) => x.length > 1)
      for (const t of tokens) {
        let h = 2166136261
        for (let i = 0; i < t.length; i++) {
          h ^= t.charCodeAt(i)
          h = Math.imul(h, 16777619)
        }
        const idx = Math.abs(h) % dim
        v[idx] += 1
      }
      let norm = 0
      for (const x of v) norm += x * x
      norm = Math.sqrt(norm) || 1
      return v.map((x) => x / norm)
    })
  }
}

function buildDoc(id: string, filename: string, text: string): ParsedDocument {
  const normalizer = new TextNormalizer()
  const metadata = new MetadataExtractor().extract(filename, Buffer.byteLength(text, 'utf8'))
  const normalizedText = normalizer.normalize(text)
  const lines = normalizedText.split(/\n+/).filter(Boolean)
  const sections = [{ heading: 'main', text: lines.join('\n') }]
  const chunker = new DocumentChunker(300, 15)
  const chunks = chunker.chunk(sections)
  const keyFieldExtractor = new KeyFieldExtractor()
  const exactFields = keyFieldExtractor.extract(normalizedText)
  const rows = lines
    .map((line) => {
      const idx = line.indexOf(':')
      if (idx <= 0) return null
      return { indicator: line.slice(0, idx).trim(), valueRaw: line.slice(idx + 1).trim() }
    })
    .filter((x): x is { indicator: string; valueRaw: string } => Boolean(x))

  return {
    id,
    metadata,
    rawText: text,
    normalizedText,
    sections,
    rows,
    chunks,
    exactFields,
    keyTerms: rows.map((r) => r.indicator),
  }
}

type PairCase = {
  id: string
  query: ParsedDocument
  candidate: ParsedDocument
  expectedMatch: boolean
}

function createPipeline(): MatchPipeline {
  const config: MatchPipelineConfig = {
    chunkSizeTokens: 450,
    chunkOverlapPercent: 15,
    semanticWeight: 0.5,
    lexicalWeight: 0.2,
    structuralWeight: 0.1,
    exactFieldsWeight: 0.15,
    metadataWeight: 0.05,
    documentMatchThreshold: 0.62,
    llmRerankThresholdLow: 0.45,
    llmRerankThresholdHigh: 0.75,
    topKChunkMatches: 4,
  }
  const lexical = new LexicalMatcher()
  return new MatchPipeline(
    config,
    new TestEmbeddingProvider(),
    new InMemoryVectorRepository(),
    new CandidateRetriever(lexical),
    lexical,
    new SemanticMatcher(4),
    new StructuralMatcher(),
    new ExactFieldMatcher(),
    new DocumentScorer(config),
    new MatchReranker(),
    new MatchExplanationBuilder(),
  )
}

test('hybrid matching quality metrics baseline', async () => {
  const pipeline = createPipeline()

  const base = buildDoc(
    'd-base',
    'base.docx',
    `Раздел 1. Описание
Наименование товара: Тест-набор для прокальцитонина
Артикул: PCT-100
Чувствительность: не менее 95%
Специфичность: не менее 96%
Дата: 12.05.2025`,
  )
  const expanded = buildDoc(
    'd-expanded',
    'expanded.pdf',
    `Раздел 1. Описание
Наименование товара: Тест набор для определения прокальцитонина
Артикул: PCT-100
Чувствительность: не менее 95%
Специфичность: не менее 96%
Дополнительные условия хранения: +2..+8`,
  )
  const unrelated = buildDoc(
    'd-unrelated',
    'unrelated.txt',
    `Наименование товара: Гематологический анализатор
Артикул: HEM-777
Чувствительность: 70%
Специфичность: 72%`,
  )
  const paraphrased = buildDoc(
    'd-para',
    'para.txt',
    `Продукт: Набор реагентов PCT
Идентификатор: PCT-100
Диагностическая чувствительность от 95 процентов
Диагностическая специфичность от 96 процентов`,
  )
  const sameNameDifferentData = buildDoc(
    'd-same-name',
    'base.docx',
    `Наименование товара: Тест-набор для прокальцитонина
Артикул: PCT-999
Чувствительность: не менее 80%
Специфичность: не менее 81%`,
  )
  const ruEn = buildDoc(
    'd-ru-en',
    'ru-en.docx',
    `Product name: Procalcitonin test kit
Part number: PCT-100
Sensitivity: at least 95%
Specificity: at least 96%`,
  )

  const cases: PairCase[] = [
    { id: 'exact_duplicate', query: base, candidate: base, expectedMatch: true },
    { id: 'same_document_modified', query: base, candidate: expanded, expectedMatch: true },
    { id: 'paraphrased', query: base, candidate: paraphrased, expectedMatch: true },
    { id: 'same_name_but_different_content', query: base, candidate: sameNameDifferentData, expectedMatch: false },
    { id: 'unrelated_topic', query: base, candidate: unrelated, expectedMatch: false },
    { id: 'multilingual_equivalent', query: base, candidate: ruEn, expectedMatch: true },
  ]

  let tp = 0
  let tn = 0
  let fp = 0
  let fn = 0

  for (const c of cases) {
    const res = await pipeline.compare(c.query, [c.candidate])
    assert.ok(res, `no result for case ${c.id}`)
    const predicted = Boolean(res!.decision.isMatch)
    if (predicted && c.expectedMatch) tp++
    else if (predicted && !c.expectedMatch) fp++
    else if (!predicted && c.expectedMatch) fn++
    else tn++
  }

  const precision = tp / Math.max(1, tp + fp)
  const recall = tp / Math.max(1, tp + fn)
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall)
  const fpr = fp / Math.max(1, fp + tn)
  const fnr = fn / Math.max(1, fn + tp)

  assert.ok(precision >= 0.6, `precision too low: ${precision.toFixed(3)}`)
  assert.ok(recall >= 0.5, `recall too low: ${recall.toFixed(3)}`)
  assert.ok(f1 >= 0.55, `f1 too low: ${f1.toFixed(3)}`)
  assert.ok(fpr <= 0.5, `fpr too high: ${fpr.toFixed(3)}`)
  assert.ok(fnr <= 0.5, `fnr too high: ${fnr.toFixed(3)}`)
})
