import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'
import JSZip from 'jszip'
import WordExtractor from 'word-extractor'

import { normalizeText } from '../utils/text.js'
import {
  couldBeProductNameValue,
  indicatorLooksLikeProductNameColumn,
  looksLikeAuxValueForFirstColumnProduct,
} from './productName.js'

export type ParsedRow = {
  indicator: string
  valueRaw: string
  // Optional extra fields if they can be inferred.
  unit?: string
  // Embedding can be attached later.
  embedding?: number[]
}

function cleanCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  return normalizeText(s)
}

/** Row values are normally numeric; text-only values allowed for explicit product-name columns. */
function indicatorAllowsNonNumericValue(indicator: string): boolean {
  const n = indicator.toLowerCase()
  if (indicatorLooksLikeProductNameColumn(indicator)) return true
  // Textual criterion in many specs: list of analytes/drugs.
  if (n.includes('выявляем') && n.includes('веществ')) return true
  if (n.includes('перечень') && n.includes('выявляем')) return true
  // Tender / TZ blobs (often one cell with “Назначение: …; Состав: …”).
  if (n.includes('назначение')) return true
  if (n.includes('состав') && !n.includes('код ктру')) return true
  if (n.includes('комплектац')) return true
  if (n.includes('описание')) return true
  if (n.includes('биологич') && n.includes('материал')) return true
  if (n.includes('материал') && n.includes('исследован')) return true
  return false
}

/** “Количество устройств 40 штук”, “Объем устройства 15мл” (без двоеточия). */
function tryLabelNumberFragment(raw: string): { indicator: string; valueRaw: string } | null {
  const s = raw.trim()
  if (!s || s.length < 4) return null
  const m = s.match(/^(.+?)\s+(\d[\d\s,./]*.*)$/)
  if (!m) return null
  const left = m[1].trim()
  const right = m[2].trim()
  if (left.length < 3 || right.length < 1) return null
  if (!/\d/.test(right)) return null
  if (/^0+$/.test(right.replace(/\s/g, ''))) return null
  return { indicator: left, valueRaw: right }
}

function extractPackQty(valueRaw: string): { indicator: string; valueRaw: string } | null {
  const s = (valueRaw ?? '').toString()
  const nums: number[] = []
  const rxPrimary = /(?:упак(?:овк[аеуи])?|в упаковке|№)\s*[№#]?\s*(\d{1,4})\b/gi
  for (const m of s.matchAll(rxPrimary)) {
    const n = Number(m[1] ?? '')
    if (Number.isFinite(n) && n > 0) nums.push(n)
  }
  const rxUnits = /(\d{1,4})\s*(?:шт|штук)\b/gi
  for (const m of s.matchAll(rxUnits)) {
    const n = Number(m[1] ?? '')
    if (Number.isFinite(n) && n > 0) nums.push(n)
  }
  if (nums.length === 0) return null
  const qty = Math.max(...nums)
  if (!Number.isFinite(qty) || qty <= 0) return null
  return { indicator: 'Количество в упаковке', valueRaw: `${qty} шт.` }
}

function extractPackQtyPairsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const emit = (qtyRaw: string) => {
    const qty = Number(String(qtyRaw ?? '').replace(/[^\d]/g, ''))
    if (!Number.isFinite(qty) || qty <= 0) return
    pushParsedRowUnique(out, seen, { indicator: 'Количество в упаковке', valueRaw: `${qty} шт.` })
  }

  const rxForward =
    /колич(?:ество)?\s*(?:товара|набор(?:а|ов)?|устройств)?\s*(?:в\s*)?упаков[кч][а-яё]*[\s\S]{0,80}?(?:>=|≥|не\s*менее|не\s*более|=)?\s*(\d{1,4})\s*(?:шт|штук)?\b/gi
  for (const m of raw.matchAll(rxForward)) emit(m[1] ?? '')

  const rxBackward =
    /(?:>=|≥|не\s*менее|не\s*более|=)?\s*(\d{1,4})\s*(?:шт|штук)\b[\s\S]{0,80}?колич(?:ество)?\s*(?:товара|набор(?:а|ов)?|устройств)?\s*(?:в\s*)?упаков[кч][а-яё]*/gi
  for (const m of raw.matchAll(rxBackward)) emit(m[1] ?? '')

  return out
}

function extractProductNameRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const lines = raw
    .split(/\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== '\\')

  const stopRx =
    /^(описани[ея]|назначени[ея]|колич|определя|исследуем|время|материал|наименование показателя|содержание)/i
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    if (!/наименование\s+товар/i.test(cur)) continue
    for (let j = i + 1; j < Math.min(lines.length, i + 20); j++) {
      const candidate = lines[j]
      if (!candidate) continue
      if (stopRx.test(candidate)) break
      if (!couldBeProductNameValue(candidate)) continue
      const n = normalizeText(candidate)
      if (n.length < 6) continue
      pushParsedRowUnique(out, seen, { indicator: 'Наименование товара', valueRaw: candidate })
    }
  }

  return out
}

function extractPurposeRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const lines = raw
    .split(/\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== '\\')

  const pushPurpose = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v) return
    const n = normalizeText(v)
    if (!n.includes('предназнач')) return
    if (!/(анализатор|визуал|моч[аи]|тест|полоск|использован)/.test(n)) return
    if (!valueAcceptableForRow('Назначение', v)) return
    pushParsedRowUnique(out, seen, { indicator: 'Назначение', valueRaw: v })
  }

  for (const line of lines) {
    if (line.length < 20) continue
    if (/^(описани[ея]|наименование товара|колич|время|состав|хранить)/i.test(line)) continue
    if (/(предназначен[аыо]?)/i.test(line)) pushPurpose(line)
  }
  return out
}

function extractMaterialRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const pushMaterial = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v) return
    const n = normalizeText(v)
    if (!/(кров|сыворот|плазм)/.test(n)) return
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: v })
  }
  const pushMaterialAny = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v) return
    const n = normalizeText(v)
    if (!/(моч|слюн|кров|сыворот|плазм)/.test(n)) return
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: v })
  }

  // Case 1: dedicated block under "Исследуемый материал".
  const lines = raw
    .split(/\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== '\\')
  for (let i = 0; i < lines.length; i++) {
    if (!/^исследуем[а-яё\s]+материал/i.test(lines[i])) continue
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const s = lines[j]
      if (/^(время|описани[ея]|назначени[ея]|состав|колич|наименование)/i.test(s)) break
      pushMaterialAny(s)
    }
  }

  // Case 2: inline mention "... в цельной крови, сыворотке или плазме ...".
  const rxInline = /в\s+цельн[а-яё\s]*кров[аи],?\s*сыворот[к\w\s]*\s*(?:или|и)\s*плазм[а-яё\w\s]*/gi
  for (const m of raw.matchAll(rxInline)) {
    const seg = (m[0] ?? '').toLowerCase()
    if (seg.includes('цельн') && seg.includes('кров')) pushMaterial('Цельная кровь')
    if (seg.includes('сыворот')) pushMaterial('Сыворотка крови')
    if (seg.includes('плазм')) pushMaterial('Плазма крови')
  }

  // Fallback: dense DOC text can collapse punctuation/tabs; detect by keyword co-occurrence.
  const n = normalizeText(raw)
  const hasBloodTriplet =
    /цельн/.test(n) && /кров/.test(n) && /сыворот/.test(n) && /плазм/.test(n)
  if (hasBloodTriplet) {
    pushMaterial('Цельная кровь')
    pushMaterial('Сыворотка крови')
    pushMaterial('Плазма крови')
  }

  // Additional common materials in tender texts.
  if (/\bв\s+моч[еёи]\b/i.test(raw) || /\bмоч[аеи]\b/i.test(n)) pushMaterialAny('Моча')
  if (/\bв\s+слюн[еы]\b/i.test(raw) || /\bслюн[аеи]\b/i.test(n)) pushMaterialAny('Слюна')

  return out
}

function extractInfectionMarkerRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out
  const n = normalizeText(raw).toLowerCase()

  const hasHepB = /(?:гепатит[а-яё\s]*в|hbsag|hbv)/i.test(n)
  const hasHepC = /(?:гепатит[а-яё\s]*с|hcv)/i.test(n)
  const hasHiv1 = /(?:вич[\s\-_/]*1|hiv[\s\-_/]*1|вич[\s\-_/]*1[\s,.;:/-]*2|hiv[\s\-_/]*1[\s,.;:/-]*2)/i.test(n)
  const hasHiv2 = /(?:вич[\s\-_/]*2|hiv[\s\-_/]*2|вич[\s\-_/]*1[\s,.;:/-]*2|hiv[\s\-_/]*1[\s,.;:/-]*2)/i.test(n)
  const hasSyph = /(?:сифил|treponema\s*pallidum|tp\b)/i.test(n)

  const markers: string[] = []
  if (hasHepB) markers.push('гепатит B')
  if (hasHepC) markers.push('гепатит C')
  if (hasHiv1) markers.push('ВИЧ 1')
  if (hasHiv2) markers.push('ВИЧ 2')
  if (hasSyph) markers.push('сифилис')

  if (markers.length >= 2) {
    pushParsedRowUnique(out, seen, {
      indicator: 'Выявление маркеров инфекционных заболеваний',
      valueRaw: markers.join('; '),
    })
  }
  return out
}

function extractDescriptionRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const pushDesc = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v) return
    if (!valueAcceptableForRow('Описание', v)) return
    pushParsedRowUnique(out, seen, { indicator: 'Описание', valueRaw: v })
  }

  // Case 1: inline row fragments "... Описание <text>" from DOC/DOCX tables.
  const rxInline = /(?:^|[\t|;,\n\r ])описани[ея]\s*[:\-]?\s*([^\n\r]{20,400})/gi
  for (const m of raw.matchAll(rxInline)) {
    const tail = (m[1] ?? '').trim()
    if (!tail) continue
    const stopIdx = tail.search(
      /\b(?:чувствительн|специфич|достоверност|регистрац|колич|инструкц|индивидуальн(?:ая|ой)?\s+упаковк)\b/i,
    )
    const cleaned = stopIdx >= 0 ? tail.slice(0, stopIdx).trim() : tail
    if (cleaned.length >= 20) pushDesc(cleaned)
  }

  // Case 2: lines that are effectively descriptive sentences without explicit "Описание" label.
  const lines = raw
    .split(/\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== '\\')
  for (const line of lines) {
    const n = normalizeText(line).toLowerCase()
    if (n.length < 20) continue
    const looksCoreDescription =
      (n.includes('выявля') && n.includes('наркот') && n.includes('слюн')) ||
      (n.includes('снабжен') && n.includes('устройств') && (n.includes('биоматериал') || n.includes('сбор'))) ||
      (n.includes('одновремен') && n.includes('определен') && n.includes('наркот'))
    if (!looksCoreDescription) continue
    pushDesc(line)
  }

  return out
}

function extractLabelValueRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out
  const lines = raw
    .split(/\n/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x !== '\\')

  const labels = new Set([
    'назначение',
    'описание',
    'определяемые параметры',
    'исследуемый материал',
    'состав набора',
  ])

  for (let i = 0; i < lines.length - 1; i++) {
    const label = lines[i]
    const labelNorm = normalizeText(label).toLowerCase()
    if (!labels.has(labelNorm)) continue
    const value = lines[i + 1]
    if (!value) continue
    if (/^(наименование|значение|ед\.?\s*изм|количество|№|п\/п)$/i.test(value)) continue
    if (!valueAcceptableForRow(label, value)) continue
    pushParsedRowUnique(out, seen, { indicator: label, valueRaw: value })
  }

  return out
}

function extractColorScaleRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const emit = (qtyRaw: string) => {
    const qty = Number(String(qtyRaw ?? '').replace(/[^\d]/g, ''))
    if (!Number.isFinite(qty) || qty <= 0) return
    pushParsedRowUnique(out, seen, {
      indicator: 'Количество цветовых полей на шкале определяемых значений pH, шт',
      valueRaw: String(qty),
    })
  }

  const rx1 = /цветн[а-яё\s]*шкал[а-яё\s]*содерж[а-яё\s]*?(\d{1,3})\s*цветов[а-яё\s]*пол/i
  const m1 = raw.match(rx1)
  if (m1) emit(m1[1] ?? '')

  const rx2 =
    /колич[а-яё\s]*цветов[а-яё\s]*пол[а-яё\s]*шкал[а-яё\s]*(?:определяем[а-яё\s]*значени[а-яё\s]*ph)?[^\d]{0,20}(\d{1,3})/i
  const m2 = raw.match(rx2)
  if (m2) emit(m2[1] ?? '')

  return out
}

function extractAnalyticalSensitivityRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const emit = (indicator: string, numRaw: string, unitRaw?: string) => {
    const n = Number(String(numRaw ?? '').replace(',', '.').replace(/[^\d.]/g, ''))
    if (!Number.isFinite(n) || n <= 0) return
    const unit = (unitRaw ?? 'нг/мл').toLowerCase().replace(/\s+/g, '')
    const valueRaw = `${n} ${unit}`
    if (!valueAcceptableForRow(indicator, valueRaw)) return
    pushParsedRowUnique(out, seen, { indicator, valueRaw })
  }

  const rxAnalytic =
    /аналитическ[а-яё\s]*чувствительн[а-яё\s]*(?:\(\s*концентрац[а-яё\s]*\))?[^\d]{0,24}(\d{1,6}(?:[.,]\d+)?)\s*(нг\/?\s*мл|ng\/?\s*ml)?/gi
  for (const m of raw.matchAll(rxAnalytic)) emit('Аналитическая чувствительность (концентрация)', m[1] ?? '', m[2] ?? '')

  const rxMinimum =
    /минимальн[а-яё\s]*определя[а-яё\s]*концентрац[а-яё\s]*[^\d]{0,24}(\d{1,6}(?:[.,]\d+)?)\s*(нг\/?\s*мл|ng\/?\s*ml)?/gi
  for (const m of raw.matchAll(rxMinimum)) emit('Минимальная определяемая концентрация', m[1] ?? '', m[2] ?? '')

  return out
}

function extractNeedleGaugeRowsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out

  const emit = (gRaw: string) => {
    const g = Number(String(gRaw ?? '').replace(/[^\d]/g, ''))
    if (!Number.isFinite(g) || g <= 0) return
    pushParsedRowUnique(out, seen, {
      indicator: 'Размер иглы, G',
      valueRaw: `${g} G`,
    })
  }

  // "Игла 21G", "Игла 21 G", "needle 21g"
  const rx = /(?:игл[аы]|needle)[^\d]{0,12}(\d{1,2})\s*g\b/gi
  for (const m of raw.matchAll(rx)) emit(m[1] ?? '')

  return out
}

function extractMaterialRowsFromRows(rows: ParsedRow[]): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const joined = rows
    .map((r) => `${r.indicator ?? ''} ${r.valueRaw ?? ''}`)
    .join('\n')
    .toLowerCase()
  if (/(^|[\s,.;:])моч[аеиы]?($|[\s,.;:])/.test(joined) || /\bв\s+моч[еёи]\b/.test(joined)) {
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: 'Моча' })
  }
  if (/(^|[\s,.;:])слюн[аеиы]?($|[\s,.;:])/.test(joined) || /\bв\s+слюн[еы]\b/.test(joined)) {
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: 'Слюна' })
  }
  if (/(^|[\s,.;:])плазм[аеиы]?($|[\s,.;:])/.test(joined)) {
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: 'Плазма крови' })
  }
  if (/(^|[\s,.;:])сыворот[кч][аеиы]?($|[\s,.;:])/.test(joined)) {
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: 'Сыворотка крови' })
  }
  if (/(^|[\s,.;:])кров[ьи]?($|[\s,.;:])/.test(joined) && !/моч/.test(joined)) {
    pushParsedRowUnique(out, seen, { indicator: 'Исследуемый материал', valueRaw: 'Цельная кровь' })
  }
  return out
}

function pushParsedRowUnique(out: ParsedRow[], seen: Set<string>, row: ParsedRow) {
  const key = `${row.indicator}\n${row.valueRaw}`
  if (seen.has(key)) return
  seen.add(key)
  out.push(row)
}

/** Split tender spec cells: “A: b; C: d; Количество … 40 шт.” */
function extractRowsFromSpecBlob(blob: string, out: ParsedRow[], seen: Set<string>) {
  const parts = blob
    .split(/[;\n\r]+/g)
    .map((p) => p.trim())
    .filter(Boolean)

  for (const part of parts) {
    const colonIdx = part.indexOf(':')
    if (colonIdx > 0 && colonIdx < 120) {
      const left = part.slice(0, colonIdx).trim()
      const right = part.slice(colonIdx + 1).trim()
      if (left && right && valueAcceptableForRow(left, right)) {
        pushParsedRowUnique(out, seen, { indicator: cleanCell(left) || left, valueRaw: cleanCell(right) || right })
        continue
      }
    }
    const q = tryLabelNumberFragment(part)
    if (q && valueAcceptableForRow(q.indicator, q.valueRaw)) {
      pushParsedRowUnique(out, seen, { indicator: cleanCell(q.indicator) || q.indicator, valueRaw: cleanCell(q.valueRaw) || q.valueRaw })
    }
  }

  // Also scan whole blob for core numeric specs embedded in dot-separated text.
  const qtyMatch = blob.match(/(колич[а-яёa-z\s]{0,40})(\d{1,4})\s*(шт|штук)/i)
  if (qtyMatch) {
    const indicator = qtyMatch[1].trim()
    const valueRaw = `${qtyMatch[2]} ${qtyMatch[3]}`.trim()
    if (valueAcceptableForRow(indicator, valueRaw)) {
      pushParsedRowUnique(out, seen, {
        indicator: cleanCell(indicator) || indicator,
        valueRaw: cleanCell(valueRaw) || valueRaw,
      })
    }
  }
  const volMatch = blob.match(/(об[ъь]?[её]м[а-яёa-z\s]{0,30})(\d{1,4}(?:[.,]\d+)?)\s*(мл|мм|см|мкм|г)/i)
  if (volMatch) {
    const indicator = volMatch[1].trim()
    const valueRaw = `${volMatch[2]} ${volMatch[3]}`.trim()
    if (valueAcceptableForRow(indicator, valueRaw)) {
      pushParsedRowUnique(out, seen, {
        indicator: cleanCell(indicator) || indicator,
        valueRaw: cleanCell(valueRaw) || valueRaw,
      })
    }
  }
}

/**
 * Широкие строки закупки: A=№ строки, B=наименование, C+=характеристики в одной ячейке или по колонкам.
 */
function extractRowsFromWideExcelRow(row: unknown[], out: ParsedRow[], seen: Set<string>) {
  if (!row || row.length < 3) return
  const c0 = String(row[0] ?? '')
    .trim()
    .replace(/\s+/g, '')
  if (!/^\d{1,4}$/.test(c0)) return

  const nameCell = row[1]
  if (nameCell != null && String(nameCell).trim().length > 20) {
    const rawName = String(nameCell)
    if (valueAcceptableForRow('Наименование товара', rawName)) {
      pushParsedRowUnique(out, seen, {
        indicator: cleanCell('Наименование товара'),
        valueRaw: cleanCell(rawName) || rawName.trim(),
      })
    }
  }

  for (let j = 2; j < row.length; j++) {
    const cell = row[j]
    if (cell == null) continue
    const s = String(cell).trim()
    if (!s || /^0+$/.test(s.replace(/\s/g, ''))) continue
    if (s.length === 1) continue
    extractRowsFromSpecBlob(s, out, seen)
  }
}

function valueAcceptableForRow(indicator: string, valueRaw: string): boolean {
  if (/[0-9]/.test(valueRaw)) {
    // Prevent table row indices like "1" from being treated as product name value.
    if (indicatorLooksLikeProductNameColumn(indicator) && !/[a-zа-яё]/i.test(valueRaw)) return false
    return true
  }
  const vTrim = (valueRaw ?? '').toString().trim().toLowerCase()
  if (/^(наличие|есть|да|имеется|присутствует)$/i.test(vTrim)) {
    const indTrim = (indicator ?? '').toString().trim()
    if (/[a-zа-яё]/i.test(indTrim) && indTrim.length >= 5) return true
  }
  if (couldBeProductNameValue(indicator) && looksLikeAuxValueForFirstColumnProduct(valueRaw)) return true
  if (!indicatorAllowsNonNumericValue(indicator)) return false
  const ind = indicator.toLowerCase()
  if (
    (ind.includes('выявляем') && ind.includes('веществ')) ||
    (ind.includes('перечень') && ind.includes('выявляем'))
  ) {
    const v = (valueRaw ?? '').toString().trim()
    return /[a-zа-яё]/i.test(v) && v.length >= 8
  }
  if (ind.includes('состав') || ind.includes('комплектац') || ind.includes('описание')) {
    const v = (valueRaw ?? '').toString().trim()
    return /[a-zа-яё]/i.test(v) && v.length >= 20
  }
  if ((ind.includes('биологич') && ind.includes('материал')) || (ind.includes('материал') && ind.includes('исследован'))) {
    const v = (valueRaw ?? '').toString().trim()
    return /[a-zа-яё]/i.test(v) && v.length >= 5
  }
  return couldBeProductNameValue(valueRaw)
}

function splitByDelimiters(line: string): string[] {
  // Prefer explicit delimiters.
  if (line.includes('|')) return line.split('|').map((s) => s.trim()).filter(Boolean)
  if (line.includes('\t')) return line.split('\t').map((s) => s.trim()).filter(Boolean)

  // Fallback: split by "big" whitespace gap, e.g. columns.
  const parts = line.split(/ {2,}/g).map((s) => s.trim()).filter(Boolean)
  return parts.length >= 2 ? parts : []
}

function stripHtml(s: string): string {
  return (s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractPresencePairsFromText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const raw = (text ?? '').toString()
  if (!raw) return out
  const rx = /([^\n\r;|]{3,180}?)\s+(наличие|есть|имеется|да)\b/gi
  for (const m of raw.matchAll(rx)) {
    let indicator = (m[1] ?? '').replace(/\s+/g, ' ').trim()
    const value = (m[2] ?? '').replace(/\s+/g, ' ').trim()
    if (!indicator || !value) continue
    // If a long merged row was captured, keep only nearest words before "наличие".
    const words = indicator.split(/\s+/g).filter(Boolean)
    if (words.length > 8) indicator = words.slice(-6).join(' ')
    const low = indicator.toLowerCase()
    if (
      low.includes('значение характеристики') ||
      low.includes('инструкция') ||
      low.includes('участник закупки') ||
      low.includes('наименование заказчика')
    ) {
      continue
    }
    if (!valueAcceptableForRow(indicator, value)) continue
    pushParsedRowUnique(out, seen, {
      indicator: cleanCell(indicator) || indicator,
      valueRaw: cleanCell(value) || value,
    })
  }
  return out
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function extractPresencePairsFromWordTokens(xml: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  const tokenRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/gi
  const tokens: string[] = []
  for (const m of xml.matchAll(tokenRe)) {
    const t = decodeXmlEntities((m[1] ?? '').replace(/\s+/g, ' ').trim())
    if (!t || t === '\\') continue
    tokens.push(t)
  }
  const isPresence = (s: string) => /^(наличие|есть|имеется|да)$/i.test(s.trim())
  const isNoise = (s: string) =>
    /(инструкция|значение характеристики|участник закупки|наименование заказчика)/i.test(s)

  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i]
    // case 1: token already contains both indicator and presence
    const inline = cur.match(/(.{4,180}?)\s+(наличие|есть|имеется|да)\b/i)
    if (inline) {
      const indicator = inline[1].trim()
      const value = inline[2].trim()
      if (!isNoise(indicator) && valueAcceptableForRow(indicator, value)) {
        pushParsedRowUnique(out, seen, {
          indicator: cleanCell(indicator) || indicator,
          valueRaw: cleanCell(value) || value,
        })
      }
      continue
    }
    // case 2: previous token is indicator, current token is presence value
    if (!isPresence(cur)) continue
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const indicator = tokens[j].trim()
      if (!indicator || isNoise(indicator)) continue
      if (valueAcceptableForRow(indicator, cur)) {
        pushParsedRowUnique(out, seen, {
          indicator: cleanCell(indicator) || indicator,
          valueRaw: cleanCell(cur) || cur,
        })
        break
      }
    }
  }
  return out
}

async function extractDocxXmlText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const chunks: string[] = []
  for (const name of Object.keys(zip.files)) {
    const lower = name.toLowerCase()
    if (!lower.startsWith('word/')) continue
    if (!lower.endsWith('.xml')) continue
    const file = zip.files[name]
    if (!file || file.dir) continue
    const xml = await file.async('string')
    const text = decodeXmlEntities(
      xml
        .replace(/<w:tab\/>/gi, '\t')
        .replace(/<w:br[^>]*\/>/gi, '\n')
        .replace(/<\/w:p>/gi, '\n')
        .replace(/<\/w:tr>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    )
    if (text.trim()) chunks.push(text)
  }
  return normalizeText(chunks.join('\n'))
}

function extractRowsFromDocxWordXml(xml: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  let prevIndicator: string | null = null
  const isPresenceValue = (s: string) => /^(наличие|есть|имеется|да)$/i.test((s ?? '').trim())
  const isNoiseIndicator = (s: string) =>
    /(инструкция|значение характеристики|участник закупки|наименование заказчика|описание объекта закупки)/i.test(
      s ?? '',
    )
  const emitPair = (indicatorRaw: string, valueRaw: string) => {
    const indicator = (indicatorRaw ?? '').trim()
    const value = (valueRaw ?? '').trim()
    if (!indicator || !value) return
    if (isNoiseIndicator(indicator)) return
    if (!valueAcceptableForRow(indicator, value)) return
    pushParsedRowUnique(out, seen, {
      indicator: cleanCell(indicator) || indicator,
      valueRaw: cleanCell(value) || value,
    })
  }
  const tableLike = decodeXmlEntities(
    (xml ?? '')
      .replace(/<w:tab\/>/gi, '\t')
      .replace(/<w:br[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, ' ')
      .replace(/<\/w:tc>/gi, ' | ')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' '),
  )
  const lines = tableLike.split(/\n/g).map((x) => x.trim()).filter(Boolean)
  for (const line of lines) {
    if (!line.includes('|')) continue
    const texts = line
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => t !== '\\')
    if (texts.length === 0) continue

    let indicatorRaw = texts[0] ?? ''
    let valueRaw = texts.slice(1).join(' \n ').trim()
    if ((!valueRaw || valueRaw.length < 2) && prevIndicator) {
      indicatorRaw = prevIndicator
      valueRaw = texts.join(' \n ').trim()
    }
    if (indicatorRaw && valueRaw) {
      prevIndicator = indicatorRaw
      emitPair(indicatorRaw, valueRaw)
    }

    // Additional normalization for merged table rows:
    // recover local pairs "<indicator cell>" + "<value cell>" inside one row.
    for (let i = 0; i < texts.length - 1; i++) {
      const left = texts[i]
      const right = texts[i + 1]
      if (!left || !right) continue
      emitPair(left, right)
      if (isPresenceValue(right)) emitPair(left, right)
    }
    // If a presence value appears alone, bind it to nearest previous non-noise cell.
    for (let i = 0; i < texts.length; i++) {
      const cur = texts[i]
      if (!isPresenceValue(cur)) continue
      for (let j = i - 1; j >= 0; j--) {
        const cand = texts[j]
        if (!cand || isNoiseIndicator(cand)) continue
        emitPair(cand, cur)
        break
      }
    }
  }
  return out
}

async function extractRowsFromDocxXmlTables(buffer: Buffer): Promise<ParsedRow[]> {
  const zip = await JSZip.loadAsync(buffer)
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  for (const name of Object.keys(zip.files)) {
    const lower = name.toLowerCase()
    if (!lower.startsWith('word/')) continue
    if (!lower.endsWith('.xml')) continue
    const file = zip.files[name]
    if (!file || file.dir) continue
    const xml = await file.async('string')
    for (const row of extractRowsFromDocxWordXml(xml)) {
      pushParsedRowUnique(out, seen, row)
    }
    for (const row of extractPresencePairsFromWordTokens(xml)) {
      pushParsedRowUnique(out, seen, row)
    }
  }
  return out
}

function extractRowsFromDocxHtmlTable(html: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const seen = new Set<string>()
  let prevIndicator: string | null = null
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  for (const tr of rows) {
    const cells = tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []
    if (cells.length === 0) continue

    const texts = cells
      .map((c) => stripHtml(c))
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => t !== '\\')
    if (texts.length === 0) continue

    // Prefer generic table parsing:
    // indicator = first meaningful cell, value = concatenation of the rest.
    let indicatorRaw = texts[0] ?? ''
    let valueRaw = texts.slice(1).join(' \n ').trim()

    // If row contains only value-like text, carry indicator from previous row
    // (common when table has merged cells and continuation rows).
    if ((!valueRaw || valueRaw.length < 2) && prevIndicator && texts.length >= 1) {
      indicatorRaw = prevIndicator
      valueRaw = texts.join(' \n ').trim()
    }

    if (!indicatorRaw || !valueRaw) continue
    prevIndicator = indicatorRaw
    if (!valueAcceptableForRow(indicatorRaw, valueRaw)) continue

    pushParsedRowUnique(out, seen, {
      indicator: cleanCell(indicatorRaw) || indicatorRaw,
      valueRaw: cleanCell(valueRaw) || valueRaw,
    })
  }
  return out
}

function guessRowsFromText(text: string, maxRows = 2000): ParsedRow[] {
  // Heuristic: find lines that look like "indicator ... value ...".
  // This is not perfect for every PDF/DOCX, but it works for many lab/tech-spec tables.
  const rows: ParsedRow[] = []
  let pendingIndicator: string | null = null

  const lines = text
    .split(/\n/g)
    .map((l) => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    if (rows.length >= maxRows) break

    // Skip headers that are clearly not data lines.
    const lower = line.toLowerCase()
    if (lower.includes('наименование') && lower.includes('знач')) continue

    // If line looks like a generic header or empty noise, reset pending indicator.
    if (
      lower === 'наименование' ||
      lower === 'значение' ||
      lower === 'показатель' ||
      lower === 'показатели'
    ) {
      pendingIndicator = null
      continue
    }

    const hasDigits = /[0-9]/.test(line)

    // DOCX/KTRU tables: the cell under «Наименование товара» is usually the next non-empty line
    // in raw text (often after «Ед. изм.» / other column headers). We keep pendingIndicator until
    // a line passes couldBeProductNameValue (see productName.ts).
    if (pendingIndicator && !hasDigits && indicatorAllowsNonNumericValue(pendingIndicator)) {
      const vr = line.trim()
      if (vr && valueAcceptableForRow(pendingIndicator, vr)) {
        rows.push({ indicator: pendingIndicator, valueRaw: cleanCell(vr) || vr })
        pendingIndicator = null
        continue
      }
    }

    // 1) Try delimiter split (|, tabs, big whitespace).
    let parts = splitByDelimiters(line)

    // 2) Try split by colon.
    if (parts.length === 0 && line.includes(':')) {
      const [left, right] = line.split(/:/, 2)
      const a = cleanCell(left)
      const b = cleanCell(right)
      if (a && b && valueAcceptableForRow(left, right)) parts = [a, b]
    }

    if (parts.length >= 2) {
      const indicator = cleanCell(parts[0])
      const valueRaw = parts.slice(1).join(' ').trim()

      if (!indicator || !valueRaw) continue
      if (!valueAcceptableForRow(parts[0], valueRaw)) continue

      rows.push({ indicator, valueRaw })
      const qty = extractPackQty(valueRaw)
      if (qty && valueAcceptableForRow(qty.indicator, qty.valueRaw)) {
        rows.push({ indicator: cleanCell(qty.indicator), valueRaw: cleanCell(qty.valueRaw) || qty.valueRaw })
      }
      pendingIndicator = null
      continue
    }

    // 2) If this line contains digits and we have a pending indicator from previous line,
    //    pair them (common for DOCX/PDF where table cells are extracted as separate lines).
    if (hasDigits && pendingIndicator) {
      const valueRaw = line
      const indicator = pendingIndicator
      if (indicator && valueRaw && valueAcceptableForRow(indicator, valueRaw)) {
        rows.push({ indicator, valueRaw })
        const qty = extractPackQty(valueRaw)
        if (qty && valueAcceptableForRow(qty.indicator, qty.valueRaw)) {
          rows.push({ indicator: cleanCell(qty.indicator), valueRaw: cleanCell(qty.valueRaw) || qty.valueRaw })
        }
        pendingIndicator = null
      }
      continue
    }

    // 3) If this line has no digits, treat it as a possible indicator for the next value line.
    if (!hasDigits) {
      // Heuristic: indicator should be "meaningful" and not too short.
      const normalized = cleanCell(line)
      if (normalized.length >= 3 && !/^[\-\–—_]+$/.test(normalized)) {
        if (
          pendingIndicator &&
          indicatorAllowsNonNumericValue(pendingIndicator) &&
          !couldBeProductNameValue(line)
        ) {
          // Still waiting for a real product title; skip "Ед. изм.", column headers, etc.
        } else {
          pendingIndicator = normalized
        }
      }
    }
  }

  return rows
}

export async function extractRowsFromFile(params: { buffer: Buffer; filename: string }): Promise<ParsedRow[]> {
  const { buffer, filename } = params
  const lower = filename.toLowerCase()

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const merged: ParsedRow[] = []
    const seen = new Set<string>()

    const processSheetRows = (rowsAOA: unknown[][]) => {
      for (const r of rowsAOA) {
        if (r && r.length >= 2) {
          const indicator = cleanCell(r[0])
          const valueRaw = cleanCell(r[1])
          const rawInd = String(r[0] ?? '')
          const rawVal = String(r[1] ?? '')
          if (indicator && valueRaw && valueAcceptableForRow(rawInd, rawVal)) {
            pushParsedRowUnique(merged, seen, { indicator, valueRaw })
          }
        }

        // Common procurement template (.xlsx):
        // C column = "Наименование характеристики", E column = "Значение характеристики".
        if (r && r.length >= 5) {
          const rawInd2 = String(r[2] ?? '').trim()
          const rawVal2 = String(r[4] ?? '').trim()
          if (rawInd2 && rawVal2 && rawInd2 !== '\\' && rawVal2 !== '\\') {
            const indicator2 = cleanCell(rawInd2)
            const valueRaw2 = cleanCell(rawVal2)
            if (indicator2 && valueRaw2 && valueAcceptableForRow(rawInd2, rawVal2)) {
              pushParsedRowUnique(merged, seen, { indicator: indicator2, valueRaw: valueRaw2 })
            }
          }
        }

        extractRowsFromWideExcelRow(r, merged, seen)

        if (r && r.length >= 2) {
          const a = r[0]
          const b = r[1]
          const aEmpty = a == null || String(a).trim() === ''
          const bText = b == null ? '' : String(b)
          if (aEmpty && bText.length > 400) {
            extractRowsFromSpecBlob(bText, merged, seen)
            for (const row of guessRowsFromText(bText)) {
              if (valueAcceptableForRow(row.indicator, row.valueRaw)) {
                pushParsedRowUnique(merged, seen, row)
              }
            }
          }
        }

        if (merged.length >= 2000) break
      }
    }

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue
      const rowsAOA = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][]
      processSheetRows(rowsAOA)
      if (merged.length >= 2000) break
    }

    if (merged.length === 0) {
      const lines: string[] = []
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        if (!sheet) continue
        const rowsAOA = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][]
        for (const r of rowsAOA) {
          if (!r || r.length === 0) continue
          const cleaned = r.map((cell) => (cell == null ? '' : String(cell))).filter(Boolean)
          if (cleaned.length === 0) continue
          lines.push(cleaned.join(' | '))
        }
      }
      const blob = lines.join('\n')
      for (const row of guessRowsFromText(blob)) {
        if (valueAcceptableForRow(row.indicator, row.valueRaw)) {
          pushParsedRowUnique(merged, seen, row)
        }
      }
    }

    return merged.slice(0, 2000)
  }

  if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer })
    const text = normalizeText(result.value)
    const guessed = guessRowsFromText(text)

    // Some DOCX tables lose row pairing in raw-text extraction.
    // Parse HTML table structure and merge indicator/value rows.
    const html = await mammoth.convertToHtml({ buffer })
    const fromHtml = extractRowsFromDocxHtmlTable(html.value ?? '')
    if (fromHtml.length === 0) return guessed
    const merged: ParsedRow[] = []
    const seen = new Set<string>()
    for (const r of guessed) pushParsedRowUnique(merged, seen, r)
    for (const r of fromHtml) pushParsedRowUnique(merged, seen, r)
    let xmlText = ''
    try {
      xmlText = await extractDocxXmlText(buffer)
      for (const r of guessRowsFromText(xmlText)) pushParsedRowUnique(merged, seen, r)
    } catch {
      // Ignore XML text fallback errors and keep extracted rows from mammoth.
    }
    try {
      for (const r of await extractRowsFromDocxXmlTables(buffer)) pushParsedRowUnique(merged, seen, r)
    } catch {
      // Ignore XML table fallback errors and keep extracted rows from mammoth.
    }
    const allDocxText = `${result.value}\n${html.value ?? ''}\n${xmlText}`
    for (const r of extractPresencePairsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    // Second pass: extract "<parameter> + presence" pairs from already merged rows.
    // This helps with DOCX tables where a whole section gets merged into one long row.
    const snapshot = [...merged]
    for (const r of snapshot) {
      for (const p of extractPresencePairsFromText(`${r.indicator}\n${r.valueRaw}`)) {
        pushParsedRowUnique(merged, seen, p)
      }
    }
    for (const r of extractPackQtyPairsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractProductNameRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractPurposeRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractInfectionMarkerRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractDescriptionRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractLabelValueRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractColorScaleRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractAnalyticalSensitivityRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractNeedleGaugeRowsFromText(allDocxText)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromRows(merged)) pushParsedRowUnique(merged, seen, r)
    return merged
  }

  if (lower.endsWith('.doc')) {
    const extractor = new WordExtractor()
    const doc: any = await extractor.extract(buffer as any)
    const body = typeof doc?.getBody === 'function' ? String(doc.getBody() ?? '') : ''
    const text = normalizeText(body)
    const guessed = guessRowsFromText(text)
    const merged: ParsedRow[] = []
    const seen = new Set<string>()
    for (const r of guessed) pushParsedRowUnique(merged, seen, r)
    // Use raw DOC text for structural fallbacks; normalization can remove delimiters.
    for (const r of extractPackQtyPairsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractProductNameRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractPurposeRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractInfectionMarkerRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractDescriptionRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractLabelValueRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractColorScaleRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractAnalyticalSensitivityRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractNeedleGaugeRowsFromText(body)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromRows(merged)) pushParsedRowUnique(merged, seen, r)
    return merged
  }

  if (lower.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer })
    const parsed = await parser.getText()
    await parser.destroy()
    const text = normalizeText(parsed.text || '')
    const guessed = guessRowsFromText(text)
    const merged: ParsedRow[] = []
    const seen = new Set<string>()
    for (const r of guessed) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromText(text)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractAnalyticalSensitivityRowsFromText(text)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractNeedleGaugeRowsFromText(text)) pushParsedRowUnique(merged, seen, r)
    for (const r of extractMaterialRowsFromRows(merged)) pushParsedRowUnique(merged, seen, r)
    return merged
  }

  throw new Error(`Unsupported file type: ${filename}`)
}

