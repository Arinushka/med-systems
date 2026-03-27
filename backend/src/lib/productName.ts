export function normalizeText(s: string): string {
  return (s ?? '')
    .toString()
    .normalize('NFKC')
    .replace(/\uFEFF/g, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .toLowerCase()
    .replace(/[“”"']/g, '')
    // Normalize dash-like characters to a space.
    .replace(/[–—-]/g, ' ')
    // Keep only letters/digits from Russian/Latin; everything else -> space.
    .replace(/[^a-z0-9а-яё]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeIndicator(indicator: string): string {
  return normalizeText(indicator)
}

/** Row belongs to the product-name column (templates vary: «Наименование товара», «… наименование … товара …»). */
function indicatorIsProductNameColumn(normalizedIndicator: string): boolean {
  if (normalizedIndicator.includes('наименование товара')) return true
  if (normalizedIndicator.includes('наименование изделия')) return true
  if (normalizedIndicator.includes('наименование') && normalizedIndicator.includes('товар')) return true
  // OCR/typo: «товра»
  if (normalizedIndicator.includes('наименование') && normalizedIndicator.includes('товра')) return true
  return false
}

/** For row-parser: allow text-only values in cells under this column (DOCX line pairing). */
export function indicatorLooksLikeProductNameColumn(indicator: string): boolean {
  return indicatorIsProductNameColumn(normalizeIndicator(indicator))
}

function looksNumericOnly(valueRaw: string): boolean {
  const v = (valueRaw ?? '').toString().trim()
  if (!v) return true
  // Allow digits, spaces, dots/commas, plus/minus
  return /^[\d.,\s/+-]+$/.test(v)
}

/**
 * Rejects unit labels and table headers that DOCX text extraction often places
 * right after "Наименование товара" instead of the real product title.
 */
export function couldBeProductNameValue(valueRaw: string): boolean {
  const v = (valueRaw ?? '').toString().trim()
  if (!v) return false
  const n = normalizeText(v)
  if (n.length < 3) return false
  if (/^[0-9]+([.,][0-9]+)?$/.test(n)) return false

  const bannedPhrases = [
    'ед изм',
    'единица измерения',
    'наименование показателя',
    'содержание показателя',
    'содержание значение показателя',
    'обоснование использования',
    'описание объекта закупки',
    'количество выполняемых',
    'код ктру',
    'специфичность',
    'чувствительность',
    'аналитическая чувствительность',
    'диагностическая специфичность',
    'диагностическая чувствительность',
    'время получения результата',
    'материал для исследования',
    'интерферирующие вещества',
    'возможность использования',
    'форма выпуска теста',
    'состав набора',
    'проведение исследования',
    'проведения анализа',
    'измерен',
    'показател',
    'значен',
    'метод',
    'требован',
    'формула',
    'в соответствии с контрактом',
    'наименование адресата',
    'адрес поставки товара',
    'срок дата поставки',
    'на основании контракта',
    'подпись',
    'ответственного лица',
    'телефон',
    'дата время',
    'заказчика',
  ]
  for (const b of bannedPhrases) {
    if (n.includes(b)) return false
  }

  if (n.length <= 12) {
    const shortOnly = new Set([
      'набор',
      'шт',
      'наличие',
      'кол во',
      'количество',
      'показатели',
      'показатель',
      'значение',
      'да',
      'нет',
      'объем',
      'поставка',
    ])
    if (shortOnly.has(n)) return false
  }

  return true
}

function extractNameCandidates(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const pushIfValid = (v: string) => {
    if (!couldBeProductNameValue(v)) return
    const n = normalizeText(v)
    if (!n || n.length < 3) return
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }

  pushIfValid(raw)

  // Some specs list several possible names in one cell separated by commas/semicolons.
  const parts = (raw ?? '')
    .toString()
    .split(/[;,|\n]+/g)
    .map((x) => x.trim())
    .filter(Boolean)

  for (const p of parts) pushIfValid(p)
  return out
}

/**
 * In many templates the product name is the first table column,
 * while the second column stores unit/count/service marks.
 */
export function looksLikeAuxValueForFirstColumnProduct(valueRaw: string): boolean {
  const n = normalizeText(valueRaw ?? '')
  if (!n) return false
  if (/^[0-9]+([.,][0-9]+)?$/.test(n)) return true
  if (/^\d{2}\.\d{2}\.\d{2}\.\d{3}-\d+$/.test((valueRaw ?? '').toString().trim())) return true

  const aux = new Set([
    'ед изм',
    'единица измерения',
    'ед',
    'шт',
    'набор',
    'комплект',
    'уп',
    'упак',
    'упаковка',
    'наличие',
    'да',
    'нет',
  ])
  if (aux.has(n)) return true
  if (n.length <= 14 && (n.includes('шт') || n.includes('набор') || n.includes('ед изм'))) return true
  return false
}

/**
 * All normalized product titles from rows marked as «наименование товара» (or close variants).
 * Several rows may qualify; the gate matches if any query name equals any library name.
 */
export function extractNormalizedProductNamesFromRows(
  rows: Array<{ indicator: string; valueRaw: string }>,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const r of rows) {
    const ind = normalizeIndicator(r.indicator)
    if (!indicatorIsProductNameColumn(ind)) continue

    const valueRaw = (r.valueRaw ?? '').toString()
    if (!valueRaw || looksNumericOnly(valueRaw)) continue
    if (!couldBeProductNameValue(valueRaw)) continue

    const candidates = extractNameCandidates(valueRaw)
    for (const value of candidates) {
      if (/^[0-9]+([.,][0-9]+)?$/.test(value)) continue
      if (!seen.has(value)) {
        seen.add(value)
        out.push(value)
      }
    }
  }

  if (out.length > 0) return out

  // Fallback: first-column templates (product title in "indicator", service value in second column).
  for (const r of rows.slice(0, 40)) {
    const indicatorRaw = (r.indicator ?? '').toString()
    const valueRaw = (r.valueRaw ?? '').toString()
    if (!indicatorRaw || !valueRaw) continue
    const indNorm = normalizeText(indicatorRaw)
    if (indNorm.includes('техническое задание') || indNorm.includes('объект закупки')) continue
    if (!/(ивд|тест|наркот|реагент|издел|анализ|кассет|полоск|панел|контейнер)/.test(indNorm)) continue
    if (!couldBeProductNameValue(indicatorRaw)) continue
    if (!looksLikeAuxValueForFirstColumnProduct(valueRaw)) continue

    const candidates = extractNameCandidates(indicatorRaw)
    for (const candidate of candidates) {
      if (!candidate || candidate.length < 3) continue
      if (!seen.has(candidate)) {
        seen.add(candidate)
        out.push(candidate)
      }
    }
  }

  if (out.length > 0) return out

  // Fallback: some TЗ templates place the actual product name in narrative rows
  // like "Объект закупки" / "Техническое задание".
  for (const r of rows.slice(0, 80)) {
    const indicatorRaw = (r.indicator ?? '').toString()
    const valueRaw = (r.valueRaw ?? '').toString()
    if (!indicatorRaw || !valueRaw) continue
    const indNorm = normalizeText(indicatorRaw)
    if (
      !indNorm.includes('объект закупки') &&
      !indNorm.includes('техническое задание') &&
      !indNorm.includes('предмет закупки')
    ) {
      continue
    }

    const candidates = extractNameCandidates(valueRaw)
    for (const c of candidates) {
      // Narrative fallback may contain lots of generic text; keep only likely product-title candidates.
      if (!/(ивд|тест|наркот|панел|кассет|контейнер|индикатор|полоск)/.test(c)) continue
      if (!seen.has(c)) {
        seen.add(c)
        out.push(c)
      }
    }
  }

  return out
}

export function productNameListsMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const setB = new Set(b)
  return a.some((x) => setB.has(x))
}

/** Longest normalized title (for display / backward compatibility). */
export function extractProductNameFromRows(rows: Array<{ indicator: string; valueRaw: string }>): string | null {
  const names = extractNormalizedProductNamesFromRows(rows)
  if (names.length === 0) return null
  return names.reduce((best, n) => (n.length >= best.length ? n : best))
}

