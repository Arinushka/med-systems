import crypto from 'node:crypto'
import type { IDocumentChunker } from './DocumentChunker.js'
import type { IKeyFieldExtractor } from './KeyFieldExtractor.js'
import type { IMetadataExtractor } from './MetadataExtractor.js'
import type { ITextNormalizer } from './TextNormalizer.js'
import type { DocumentSection, ParsedDocument, StructuredRow } from './types.js'
import { extractTextFromFile } from '../lib/extract.js'
import { extractRowsFromFile } from '../lib/rows.js'

export interface IFileParser {
  parse(params: { filename: string; sizeBytes: number; buffer: Buffer }): Promise<ParsedDocument>
}

export class FileParser implements IFileParser {
  constructor(
    private readonly metadataExtractor: IMetadataExtractor,
    private readonly textNormalizer: ITextNormalizer,
    private readonly chunker: IDocumentChunker,
    private readonly keyFieldExtractor: IKeyFieldExtractor,
  ) {}

  private buildSections(normalizedText: string): DocumentSection[] {
    const rawLines = String(normalizedText ?? '')
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean)

    if (rawLines.length === 0) return []

    const sections: DocumentSection[] = []
    let currentHeading = 'main'
    let buffer: string[] = []

    const flush = () => {
      const text = buffer.join('\n').trim()
      if (text.length > 0) {
        sections.push({ heading: currentHeading, text })
      }
      buffer = []
    }

    for (const line of rawLines) {
      const isHeading =
        /^(\d+(\.\d+)*)[\)\.]?\s+[^\d].{2,120}$/i.test(line) ||
        /^(статья|раздел|section|chapter)\s+\d+/i.test(line) ||
        (/^[a-zа-яё0-9\s\-:]{3,120}$/i.test(line) && line.length <= 80 && !/[,.]/.test(line))
      if (isHeading && buffer.length > 0) {
        flush()
        currentHeading = line
      } else {
        buffer.push(line)
      }
    }
    flush()

    return sections.length > 0 ? sections : [{ heading: 'main', text: rawLines.join('\n') }]
  }

  async parse(params: { filename: string; sizeBytes: number; buffer: Buffer }): Promise<ParsedDocument> {
    const metadata = this.metadataExtractor.extract(params.filename, params.sizeBytes)
    const rawText = await extractTextFromFile({ buffer: params.buffer, filename: params.filename }).catch(() => '')
    const normalizedText = this.textNormalizer.normalize(rawText)
    const sections = this.buildSections(normalizedText)
    const rowsRaw = await extractRowsFromFile({ buffer: params.buffer, filename: params.filename }).catch(() => [])
    const rows: StructuredRow[] = rowsRaw.map((r) => ({ indicator: String(r.indicator ?? ''), valueRaw: String(r.valueRaw ?? '') }))

    const exactFields = this.keyFieldExtractor.extract(`${normalizedText}\n${rows.map((r) => `${r.indicator}: ${r.valueRaw}`).join('\n')}`)
    const chunks = this.chunker.chunk(sections)
    const keyTerms = [
      ...rows.map((r) => r.indicator),
      ...exactFields.identifiers,
      ...exactFields.contractNumbers,
      ...exactFields.organizationNames,
    ]
      .map((x) => this.textNormalizer.normalize(x))
      .filter((x) => x.length >= 3)

    const id = crypto.createHash('sha256').update(params.buffer).digest('hex')

    return {
      id,
      metadata,
      rawText,
      normalizedText,
      sections,
      rows,
      chunks,
      exactFields,
      keyTerms: [...new Set(keyTerms)],
    }
  }
}
