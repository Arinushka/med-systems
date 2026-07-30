export type DiseaseMarker = 'treponema' | 'hiv' | 'hbv' | 'hcv'

export type DiseaseMarkerLabel =
  | 'гепатит B'
  | 'гепатит C'
  | 'ВИЧ 1'
  | 'ВИЧ 2'
  | 'сифилис'

type DiseaseMarkerRow = {
  indicator?: unknown
  valueRaw?: unknown
}

const MARKER_PATTERNS: ReadonlyArray<{
  marker: DiseaseMarker
  pattern: RegExp
}> = [
  {
    marker: 'treponema',
    pattern: /(?:\btreponema(?:\s+pallidum)?\b|сифил|\btp(?:ha)?\b)/iu,
  },
  {
    marker: 'hiv',
    pattern: /(?:вич|\bhiv\b)/iu,
  },
  {
    marker: 'hbv',
    pattern: /(?:\b[Hh][Bb][Ss][Aa][Gg]\b|\b[Hh][Bb][Vv]\b|[Гг][Ее][Пп][Аа][Тт][Ии][Тт][а-яёА-ЯЁ\s-]{0,12}[Bb](?=\s|$|[(),.;:])|[Гг][Ее][Пп][Аа][Тт][Ии][Тт][а-яёА-ЯЁ\s-]{0,12}В(?=\s|$|[(),.;:]))/u,
  },
  {
    marker: 'hcv',
    pattern: /(?:\b[Hh][Cc][Vv]\b|[Гг][Ее][Пп][Аа][Тт][Ии][Тт][а-яёА-ЯЁ\s-]{0,12}[Cc](?=\s|$|[(),.;:])|[Гг][Ее][Пп][Аа][Тт][Ии][Тт][а-яёА-ЯЁ\s-]{0,12}С(?=\s|$|[(),.;:]))/u,
  },
]

const NON_TARGET_CONTEXT_PATTERN =
  /(?:перекр[её]стн[а-яё\s-]*реактив|кросс[а-яё\s-]*реактив|cross[\s-]*reactiv)/iu

const HIV_1_PATTERN =
  /(?:вич|\bhiv)\s*[-_/]?\s*1(?=$|[^\d])/iu

const HIV_2_PATTERN =
  /(?:(?:вич|\bhiv)\s*[-_/]?\s*2|(?:вич|\bhiv)\s*[-_/]?\s*1\s*[-,/]\s*2)(?=$|[^\d])/iu

const DISEASE_MARKER_LABEL_ORDER: readonly DiseaseMarkerLabel[] = [
  'гепатит B',
  'гепатит C',
  'ВИЧ 1',
  'ВИЧ 2',
  'сифилис',
]

const PRODUCT_CONTEXT_PATTERN =
  /(?:набор|тест[\s-]*систем|издели|реагент)/iu

const PRODUCT_USAGE_PATTERN =
  /(?:предназнач|использу)/iu

const FOR_PURPOSE_PATTERN =
  /(?:^|[^\p{L}])для(?=$|[^\p{L}])/iu

const DIAGNOSTIC_INTENT_PATTERN =
  /(?:выявлен|определен|диагност|обнаружен|детекц)/iu

function splitIntoContextSegments(text: string): string[] {
  return text
    .replace(/\u0000/g, '')
    .split(/[\n\r]+|[.!?;]+(?:\s+|$)/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function isClearProductTargetClause(clause: string): boolean {
  return (
    PRODUCT_CONTEXT_PATTERN.test(clause) &&
    (PRODUCT_USAGE_PATTERN.test(clause) || FOR_PURPOSE_PATTERN.test(clause)) &&
    DIAGNOSTIC_INTENT_PATTERN.test(clause)
  )
}

function targetTextsFromSegment(segment: string): string[] {
  const nonTargetContext = NON_TARGET_CONTEXT_PATTERN.exec(segment)
  if (!nonTargetContext || nonTargetContext.index == null) return [segment]

  const beforeNonTargetContext = segment.slice(0, nonTargetContext.index).trim()
  const targetTexts = isClearProductTargetClause(beforeNonTargetContext)
    ? [beforeNonTargetContext]
    : []

  const afterNonTargetContext = segment.slice(
    nonTargetContext.index + nonTargetContext[0].length,
  )
  for (const clause of afterNonTargetContext.split(',')) {
    const candidate = clause.trim()
    if (isClearProductTargetClause(candidate)) targetTexts.push(candidate)
  }

  return targetTexts
}

function targetTextsFromText(text: string): string[] {
  return splitIntoContextSegments(String(text ?? ''))
    .flatMap((segment) => targetTextsFromSegment(segment))
}

function textHasMarker(text: string, marker: DiseaseMarker): boolean {
  return MARKER_PATTERNS.some(
    (entry) => entry.marker === marker && entry.pattern.test(text),
  )
}

export function extractDiseaseMarkersFromText(text: string): DiseaseMarker[] {
  const found = new Set<DiseaseMarker>()

  for (const targetText of targetTextsFromText(text)) {
    for (const { marker, pattern } of MARKER_PATTERNS) {
      if (pattern.test(targetText)) found.add(marker)
    }
  }

  return MARKER_PATTERNS
    .map(({ marker }) => marker)
    .filter((marker) => found.has(marker))
}

export function extractDiseaseMarkerLabelsFromText(text: string): DiseaseMarkerLabel[] {
  const found = new Set<DiseaseMarkerLabel>()

  for (const targetText of targetTextsFromText(text)) {
    if (textHasMarker(targetText, 'hbv')) found.add('гепатит B')
    if (textHasMarker(targetText, 'hcv')) found.add('гепатит C')
    if (HIV_1_PATTERN.test(targetText)) found.add('ВИЧ 1')
    if (HIV_2_PATTERN.test(targetText)) found.add('ВИЧ 2')
    if (textHasMarker(targetText, 'treponema')) found.add('сифилис')
  }

  return DISEASE_MARKER_LABEL_ORDER.filter((label) => found.has(label))
}

export function extractDiseaseMarkersFromRows(
  rows: ReadonlyArray<DiseaseMarkerRow>,
): DiseaseMarker[] {
  const found = new Set<DiseaseMarker>()

  for (const row of rows) {
    const text = `${String(row.indicator ?? '')} ${String(row.valueRaw ?? '')}`
    for (const marker of extractDiseaseMarkersFromText(text)) found.add(marker)
  }

  return MARKER_PATTERNS
    .map(({ marker }) => marker)
    .filter((marker) => found.has(marker))
}
