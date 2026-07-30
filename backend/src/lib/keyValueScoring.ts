import { cosineSimilarity } from '../utils/cosine.js'
import { valuesMatch } from './valueCompare.js'

function normalize(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export type KeyValueScoringRow = {
  indicator: string
  valueRaw: string
  embedding: number[]
}

export type KeyValueRowMatchResult = {
  indicatorSimilarity: number
  indicatorOk: boolean
  aliasPair: boolean
  unitsMatch: boolean
  valueMatch: boolean
  valueReason: string
  rowMatched: boolean
}

/** Not compared between query and library (business rule). */
export function isExcludedFromParameterMatch(indicator: string): boolean {
  const n = normalize(indicator ?? '')
  return n.includes('код ктру')
}

/** «Количество тестов» в ТЗ закупки ↔ «комплектация / варианты определений» в ТХ поставщика (разные формулировки, эмбеддинги часто ниже порога). */
function queryLooksLikeExecutableTestCount(indicator: string): boolean {
  const q = normalize(indicator ?? '')
  if (!q.includes('количество')) return false
  return (
    q.includes('тест') ||
    q.includes('выполняем') ||
    q.includes('определен') /* «количество … определений» в ТЗ */
  )
}

function libLooksLikeKittingLine(indicator: string): boolean {
  const l = normalize(indicator ?? '')
  // «комплектация», опечатки «комлектация», «комлектаця», блоки про варианты наборов
  if (/комплект|комлектац|комплектац/.test(l)) return true
  if (l.includes('различ') && (l.includes('комлекта') || l.includes('комплект'))) return true
  if (l.includes('различ') && l.includes('определен')) return true
  return false
}

function looksLikeCompositionIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  return s.includes('состав') || s.includes('комплектац') || s.includes('описан')
}

function looksLikePurposeOrDescriptionIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  return s.includes('назначен') || s.includes('описан')
}

function looksLikeInfectionMarkersIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  const hasCore = s.includes('выявлен') || s.includes('маркер') || s.includes('антител') || s.includes('антиген')
  const hasDisease =
    s.includes('вич') || s.includes('hiv') || s.includes('гепат') || s.includes('hbsag') || s.includes('сифил') || s.includes('treponema')
  return hasCore && hasDisease
}

export function compositionLongTextFallbackMatch(queryValueRaw: string, libValueRaw: string): boolean {
  const q = normalize(queryValueRaw ?? '')
  const l = normalize(libValueRaw ?? '')
  return q.length >= 80 && l.length >= 80
}

function looksLikePackQuantity(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  if (!s.includes('колич')) return false
  return (
    s.includes('упаков') ||
    s.includes('упак') ||
    s.includes('устройств') ||
    s.includes('набор') ||
    s.includes('комплект')
  )
}

function looksLikePhRangeIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  const hasRange = s.includes('диапазон') || s.includes('предел')
  const hasPh = s.includes('ph') || s.includes('рн')
  const hasMeasured = s.includes('определя') || s.includes('концентрац') || s.includes('значен')
  return hasRange && hasPh && hasMeasured
}

function looksLikePhColorScaleIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  const hasScale = s.includes('шкал') && (s.includes('цвет') || s.includes('пол'))
  const hasPh = s.includes('ph') || s.includes('рн')
  return hasScale && hasPh
}

function looksLikeAnalyticalSensitivityIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  const hasConcentration = s.includes('концентрац') || s.includes('нг мл') || s.includes('ng ml')
  const hasSensitivity = s.includes('чувствител') || s.includes('аналитическ') || s.includes('минимальн')
  if (hasConcentration && hasSensitivity) return true
  // Some TЗ/PDF rows are truncated to just "концентрация, нг/мл".
  if (hasConcentration && (s.includes('равно') || s.includes('больше') || s.includes('менее'))) return true
  return false
}

function looksLikeResearchMaterialIndicator(indicator: string): boolean {
  const s = normalize(indicator ?? '')
  if (s.includes('исследуем') && s.includes('материал')) return true
  if (s.includes('материал') && s.includes('исследован')) return true
  if (s.includes('биологическ') && s.includes('материал')) return true
  return false
}

export function tenderAliasesAllowValueCompare(queryIndicator: string, libIndicator: string): boolean {
  return (
    (queryLooksLikeExecutableTestCount(queryIndicator) && libLooksLikeKittingLine(libIndicator)) ||
    (queryLooksLikeExecutableTestCount(libIndicator) && libLooksLikeKittingLine(queryIndicator)) ||
    (queryLooksLikeExecutableTestCount(queryIndicator) && looksLikePackQuantity(libIndicator)) ||
    (queryLooksLikeExecutableTestCount(libIndicator) && looksLikePackQuantity(queryIndicator)) ||
    (looksLikePackQuantity(queryIndicator) && looksLikePackQuantity(libIndicator)) ||
    (looksLikePhRangeIndicator(queryIndicator) && looksLikePhRangeIndicator(libIndicator)) ||
    (looksLikePhColorScaleIndicator(queryIndicator) && looksLikePhColorScaleIndicator(libIndicator)) ||
    (looksLikeAnalyticalSensitivityIndicator(queryIndicator) && looksLikeAnalyticalSensitivityIndicator(libIndicator)) ||
    (looksLikeResearchMaterialIndicator(queryIndicator) && looksLikeResearchMaterialIndicator(libIndicator)) ||
    (looksLikeCompositionIndicator(queryIndicator) && looksLikeCompositionIndicator(libIndicator)) ||
    (looksLikePurposeOrDescriptionIndicator(queryIndicator) && looksLikePurposeOrDescriptionIndicator(libIndicator)) ||
    (looksLikeInfectionMarkersIndicator(queryIndicator) && looksLikeInfectionMarkersIndicator(libIndicator))
  )
}

function unitTokensMatch(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)

  // Avoid matching "проц" inside unrelated words like "процедурами".
  const aHasPercent = na.includes('%') || /\bpercent\b/.test(na) || na.includes('процент')
  const bHasPercent = nb.includes('%') || /\bpercent\b/.test(nb) || nb.includes('процент')
  if (aHasPercent || bHasPercent) return aHasPercent === bHasPercent

  const aHasNgMl = /ng\/?ml|нг\/?мл/.test(na)
  const bHasNgMl = /ng\/?ml|нг\/?мл/.test(nb)
  if (aHasNgMl || bHasNgMl) return aHasNgMl === bHasNgMl

  const timeUnitFamilies = (raw: string): Set<'seconds' | 'minutes' | 'hours' | 'days'> => {
    const value = normalize(raw)
    const hasUnit = (pattern: string): boolean =>
      new RegExp(`(?:^|[\\s\\d.,;:()[\\]])(?:${pattern})(?=$|[\\s.,;:()[\\]])`, 'i').test(value)
    const families = new Set<'seconds' | 'minutes' | 'hours' | 'days'>()
    if (hasUnit('секунд(?:а|ы)?|сек|seconds?|secs?') || /\d\s*с(?:\.|\s|$)/i.test(value)) {
      families.add('seconds')
    }
    if (hasUnit('минут(?:а|ы)?|мин|minutes?|mins?')) families.add('minutes')
    if (hasUnit('час(?:а|ов)?|ч|hours?|hrs?|h')) families.add('hours')
    if (hasUnit('день|дня|дней|сутк(?:и|а|ок)?|дн|days?|d')) families.add('days')
    return families
  }
  const aTimeUnits = timeUnitFamilies(na)
  const bTimeUnits = timeUnitFamilies(nb)
  if (aTimeUnits.size > 0 || bTimeUnits.size > 0) {
    return aTimeUnits.size === bTimeUnits.size && [...aTimeUnits].every((unit) => bTimeUnits.has(unit))
  }

  return true
}

function valueLooksLikeConstraint(raw: string): boolean {
  const n = normalize(raw)
  if (/[0-9]/.test(n)) return true
  // Also handle phrases with comparisons.
  return /(\bболее\b|\bменее\b|\bравно\b|\bдо\b|\bот\b|\bне более\b|\bне менее\b|>=|<=|≥|≤|<|>)/i.test(raw)
}

function indicatorLooksLikeTextCriterion(indicator: string): boolean {
  const n = normalize(indicator ?? '')
  if (n.includes('выявляем') && n.includes('веществ')) return true
  if (n.includes('перечень') && n.includes('выявляем')) return true
  if (n.includes('состав')) return true
  if (n.includes('назначен')) return true
  if (n.includes('комплектац')) return true
  if (n.includes('описан')) return true
  if ((n.includes('выявлен') || n.includes('маркер')) && (n.includes('вич') || n.includes('гепат') || n.includes('сифил'))) return true
  if (n.includes('камера смешивания образца')) return true
  if (looksLikeAnalyticalSensitivityIndicator(n)) return true
  if (looksLikeResearchMaterialIndicator(n)) return true
  if (n.includes('биологич') && n.includes('материал')) return true
  if (n.includes('материал') && n.includes('исследован')) return true
  return false
}

function rowContainsHtmlMarkup(row: Pick<KeyValueScoringRow, 'indicator' | 'valueRaw'>): boolean {
  return /<\/?[a-z][^>]*>/i.test(`${row.indicator ?? ''} ${row.valueRaw ?? ''}`)
}

function isNumericOrdinalIndicator(indicator: string): boolean {
  const n = normalize(indicator)
  return /^(?:№|n(?:o)?\.?)?\s*\d+(?:[.)])?$/.test(n)
}

function isHeaderLabel(raw: string): boolean {
  const n = normalize(raw)
    .replace(/[№:;,.()[\]{}]/g, ' ')
    .replace(/[-–—/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (
    /^(?:порядковый )?номер(?: п п)?$/.test(n) ||
    /^наименование (?:показателя|характеристики)$/.test(n) ||
    /^значение (?:показателя|характеристики)$/.test(n) ||
    /^(?:единица|единицы) измерения$/.test(n) ||
    /^(?:количество|кол во) товара$/.test(n) ||
    /^(?:требования|требование) заказчика$/.test(n) ||
    /^примечани[ея]$/.test(n) ||
    /^окпд ?2$/.test(n) ||
    /^код окпд ?2$/.test(n)
  )
}

function isRationaleOrInstructionIndicator(indicator: string): boolean {
  const n = normalize(indicator)
  return (
    n.includes('обоснован') ||
    n.includes('пояснен') ||
    n.includes('инструкц') ||
    n.includes('правил') && n.includes('заполнен')
  )
}

function isServiceIndicator(indicator: string): boolean {
  const n = normalize(indicator)
  const isTransportPackagingDimension =
    n.includes('упаковк') && /ширин|высот|габарит|размер|длин/.test(n)
  return (
    /^код (?:окпд|позици|товар)/.test(n) ||
    n.includes('начальная максимальная цена') ||
    n.includes('место поставки') ||
    n.includes('срок поставки') ||
    n.includes('условия поставки') ||
    isTransportPackagingDimension
  )
}

function isNoisyQueryRow(row: KeyValueScoringRow): boolean {
  const indicator = String(row.indicator ?? '').trim()
  const valueRaw = String(row.valueRaw ?? '').trim()
  if (!indicator || !valueRaw) return true
  if (rowContainsHtmlMarkup(row)) return true
  if (isNumericOrdinalIndicator(indicator)) return true
  if (isHeaderLabel(indicator) || isHeaderLabel(valueRaw)) return true
  if (isRationaleOrInstructionIndicator(indicator)) return true
  if (isServiceIndicator(indicator)) return true
  return false
}

function medicalCriterionPriority(row: KeyValueScoringRow): number {
  const indicator = normalize(row.indicator)
  if (indicatorLooksLikeTextCriterion(indicator) || queryLooksLikeExecutableTestCount(indicator)) return 300
  if (
    /чувствител|специфич|точност|диапазон|концентрац|реагент|образц|инкубац|стабил|срок годност|температур|метод|врем.*результ|результ.*врем/.test(
      indicator,
    )
  ) {
    return 250
  }
  return valueLooksLikeConstraint(row.valueRaw) ? 100 : 0
}

function isEligibleKeyValueCriterion(row: KeyValueScoringRow): boolean {
  return (
    valueLooksLikeConstraint(row.valueRaw) ||
    indicatorLooksLikeTextCriterion(row.indicator) ||
    medicalCriterionPriority(row) >= 250
  )
}

/**
 * Selects the query criteria used by every scoring stage.
 * The selection is stable within the same priority, so diagnostics retain source order.
 */
export function prepareKeyValueCriteria<T extends KeyValueScoringRow>(queryRows: T[], maxKeyRows?: number): T[] {
  const seen = new Set<string>()
  const candidates: Array<{ row: T; priority: number; sourceIndex: number }> = []

  for (let sourceIndex = 0; sourceIndex < queryRows.length; sourceIndex++) {
    const row = queryRows[sourceIndex]
    if (isExcludedFromParameterMatch(row.indicator) || isNoisyQueryRow(row)) continue
    if (!isEligibleKeyValueCriterion(row)) continue

    const key = `${normalize(row.indicator)}\u0000${normalize(row.valueRaw)}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ row, priority: medicalCriterionPriority(row), sourceIndex })
  }

  candidates.sort((a, b) => b.priority - a.priority || a.sourceIndex - b.sourceIndex)
  const selected = candidates.map((candidate) => candidate.row)
  return maxKeyRows != null && Number.isFinite(maxKeyRows) && maxKeyRows > 0
    ? selected.slice(0, maxKeyRows)
    : selected
}

export function calculateCappedMatchSummary(params: {
  scoredMatchedCount: number
  refinedMatchedCount: number
  totalCount: number
}): { matchedCount: number; matchPercent: number } {
  const totalCount = Number.isFinite(params.totalCount) ? Math.max(0, params.totalCount) : 0
  const scoredMatchedCount = Number.isFinite(params.scoredMatchedCount) ? Math.max(0, params.scoredMatchedCount) : 0
  const refinedMatchedCount = Number.isFinite(params.refinedMatchedCount) ? Math.max(0, params.refinedMatchedCount) : 0
  const matchedCount = Math.min(totalCount, Math.max(scoredMatchedCount, refinedMatchedCount))
  return {
    matchedCount,
    matchPercent: totalCount > 0 ? (matchedCount / totalCount) * 100 : 0,
  }
}

export function matchKeyValueRowPair(params: {
  queryRow: KeyValueScoringRow
  libraryRow: KeyValueScoringRow
  indicatorSimilarityThreshold: number
  valueToleranceRel: number
  valueToleranceAbs: number
}): KeyValueRowMatchResult {
  const indicatorSimilarity = cosineSimilarity(params.queryRow.embedding, params.libraryRow.embedding)
  const aliasPair = tenderAliasesAllowValueCompare(params.queryRow.indicator, params.libraryRow.indicator)
  const indicatorOk = indicatorSimilarity >= params.indicatorSimilarityThreshold || aliasPair
  const unitsMatch = unitTokensMatch(params.queryRow.valueRaw, params.libraryRow.valueRaw)

  if (!indicatorOk) {
    return {
      indicatorSimilarity,
      indicatorOk,
      aliasPair,
      unitsMatch,
      valueMatch: false,
      valueReason: 'indicator similarity below threshold',
      rowMatched: false,
    }
  }
  if (!unitsMatch) {
    return {
      indicatorSimilarity,
      indicatorOk,
      aliasPair,
      unitsMatch,
      valueMatch: false,
      valueReason: 'units mismatch',
      rowMatched: false,
    }
  }

  const valueResult = valuesMatch({
    queryValueRaw: params.queryRow.valueRaw,
    libraryValueRaw: params.libraryRow.valueRaw,
    toleranceRel: params.valueToleranceRel,
    toleranceAbs: params.valueToleranceAbs,
  })
  const longTextFallback =
    aliasPair &&
    ((
      looksLikeCompositionIndicator(params.queryRow.indicator) &&
      looksLikeCompositionIndicator(params.libraryRow.indicator)
    ) ||
      (looksLikePurposeOrDescriptionIndicator(params.queryRow.indicator) &&
        looksLikePurposeOrDescriptionIndicator(params.libraryRow.indicator))) &&
    compositionLongTextFallbackMatch(params.queryRow.valueRaw, params.libraryRow.valueRaw)
  const valueMatch = valueResult.match || longTextFallback

  return {
    indicatorSimilarity,
    indicatorOk,
    aliasPair,
    unitsMatch,
    valueMatch,
    valueReason: valueResult.match
      ? valueResult.reason
      : longTextFallback
        ? 'composition long-text fallback'
        : valueResult.reason,
    rowMatched: indicatorOk && valueMatch,
  }
}

export function scoreKeyValueIndicators(params: {
  queryRows: KeyValueScoringRow[]
  libraryRows: KeyValueScoringRow[]
  indicatorSimilarityThreshold: number
  valueToleranceRel: number
  valueToleranceAbs: number
  maxKeyRows?: number
}): { points: number; totalPossible: number; matchedIndicators: string[] } {
  const keyQueryRows = prepareKeyValueCriteria(params.queryRows, params.maxKeyRows)

  const totalPossible = keyQueryRows.length
  if (totalPossible === 0) return { points: 0, totalPossible: 0, matchedIndicators: [] }

  const libraryRows = params.libraryRows.filter((r) => !isExcludedFromParameterMatch(r.indicator))

  let points = 0
  const matchedIndicators: string[] = []

  for (const qRow of keyQueryRows) {
    let matched = false

    for (const lRow of libraryRows) {
      const rowMatch = matchKeyValueRowPair({
        queryRow: qRow,
        libraryRow: lRow,
        indicatorSimilarityThreshold: params.indicatorSimilarityThreshold,
        valueToleranceRel: params.valueToleranceRel,
        valueToleranceAbs: params.valueToleranceAbs,
      })
      if (rowMatch.rowMatched) {
        matched = true
        break
      }
    }

    if (matched) {
      points += 1
      matchedIndicators.push(qRow.indicator)
    }
  }

  return { points, totalPossible, matchedIndicators }
}
