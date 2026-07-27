import path from 'node:path'
import type { ExtractedMetadata } from './types.js'

export interface IMetadataExtractor {
  extract(filename: string, sizeBytes: number): ExtractedMetadata
}

export class MetadataExtractor implements IMetadataExtractor {
  extract(filename: string, sizeBytes: number): ExtractedMetadata {
    const base = path.basename(filename)
    const extension = path.extname(base).toLowerCase()
    return {
      filename: base,
      extension,
      sizeBytes: Math.max(0, Number(sizeBytes) || 0),
    }
  }
}
