import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'
import WordExtractor from 'word-extractor'

import { normalizeText } from '../utils/text.js'

export async function extractTextFromFile(params: {
  buffer: Buffer
  filename: string
}): Promise<string> {
  const { buffer, filename } = params
  const lower = filename.toLowerCase()

  if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer })
    return normalizeText(result.value)
  }

  if (lower.endsWith('.doc')) {
    const extractor = new WordExtractor()
    const doc: any = await extractor.extract(buffer as any)
    const body = typeof doc?.getBody === 'function' ? String(doc.getBody() ?? '') : ''
    return normalizeText(body)
  }

  if (lower.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer })
    const parsed = await parser.getText()
    await parser.destroy()
    return normalizeText(parsed.text || '')
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const firstSheetName = workbook.SheetNames[0]
    const sheet = workbook.Sheets[firstSheetName]

    // header:1 returns array-of-arrays; convert to lines.
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][]
    const lines: string[] = []
    for (const row of rows) {
      if (!row || row.length === 0) continue
      const cleaned = row.map((cell) => (cell == null ? '' : String(cell))).filter(Boolean)
      if (cleaned.length === 0) continue
      lines.push(cleaned.join(' | '))
    }
    return normalizeText(lines.join('\n\n'))
  }

  if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.json') || lower.endsWith('.xml')) {
    const raw = buffer.toString('utf8')

    if (lower.endsWith('.txt')) {
      return normalizeText(raw)
    }

    if (lower.endsWith('.csv')) {
      try {
        const rows = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const parts: string[] = []
            let current = ''
            let inQuotes = false
            for (let i = 0; i < line.length; i++) {
              const ch = line[i]
              if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') {
                  current += '"'
                  i++
                } else {
                  inQuotes = !inQuotes
                }
              } else if (ch === ',' && !inQuotes) {
                parts.push(current)
                current = ''
              } else {
                current += ch
              }
            }
            parts.push(current)
            return parts
          })
        const lines = rows.map((r) => r.map((c) => String(c ?? '').trim()).filter(Boolean).join(' | ')).filter(Boolean)
        return normalizeText(lines.join('\n'))
      } catch {
        return normalizeText(raw)
      }
    }

    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      const stripped = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
      return normalizeText(stripped)
    }

    if (lower.endsWith('.json')) {
      try {
        const parsed = JSON.parse(raw)
        const chunks: string[] = []
        const walk = (value: unknown, prefix = '') => {
          if (value == null) return
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            chunks.push(prefix ? `${prefix}: ${String(value)}` : String(value))
            return
          }
          if (Array.isArray(value)) {
            value.forEach((item, idx) => walk(item, `${prefix}[${idx}]`))
            return
          }
          if (typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              walk(v, prefix ? `${prefix}.${k}` : k)
            }
          }
        }
        walk(parsed)
        return normalizeText(chunks.join('\n'))
      } catch {
        return normalizeText(raw)
      }
    }

    if (lower.endsWith('.xml')) {
      const stripped = raw
        .replace(/<\?xml[\s\S]*?\?>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
      return normalizeText(stripped)
    }
  }

  throw new Error(`Unsupported file type: ${filename}`)
}

