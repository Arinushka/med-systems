import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'

import { normalizeText } from '../utils/text'
import {
  couldBeProductNameValue,
  indicatorLooksLikeProductNameColumn,
  looksLikeAuxValueForFirstColumnProduct,
} from './productName'

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
  return false
}

function valueAcceptableForRow(indicator: string, valueRaw: string): boolean {
  if (/[0-9]/.test(valueRaw)) {
    // Prevent table row indices like "1" from being treated as product name value.
    if (indicatorLooksLikeProductNameColumn(indicator) && !/[a-zа-яё]/i.test(valueRaw)) return false
    return true
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
    const firstSheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[firstSheetName]

    // Get rows as array-of-arrays.
    const rowsAOA = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][]
    const parsed: ParsedRow[] = []
    for (const r of rowsAOA) {
      if (!r || r.length < 2) continue
      const indicator = cleanCell(r[0])
      const valueRaw = cleanCell(r[1])
      if (!indicator || !valueRaw) continue
      const rawInd = String(r[0] ?? '')
      const rawVal = String(r[1] ?? '')
      if (!valueAcceptableForRow(rawInd, rawVal)) continue
      parsed.push({ indicator, valueRaw })
      if (parsed.length >= 2000) break
    }
    return parsed
  }

  if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer })
    const text = normalizeText(result.value)
    return guessRowsFromText(text)
  }

  if (lower.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer })
    const parsed = await parser.getText()
    await parser.destroy()
    const text = normalizeText(parsed.text || '')
    return guessRowsFromText(text)
  }

  throw new Error(`Unsupported file type: ${filename}`)
}

