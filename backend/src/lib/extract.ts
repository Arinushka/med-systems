import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'

import { normalizeText } from '../utils/text'

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

  throw new Error(`Unsupported file type: ${filename}`)
}

