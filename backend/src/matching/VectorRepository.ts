import type { ParsedDocument } from './types.js'

export type StoredDocumentVector = {
  documentId: string
  modelId: string
  chunkEmbeddings: Array<{ chunkId: string; embedding: number[] }>
  updatedAt: string
}

export interface IVectorRepository {
  get(documentId: string): StoredDocumentVector | null
  set(value: StoredDocumentVector): void
  ensureFromDocument(document: ParsedDocument, modelId: string): StoredDocumentVector | null
}

export class InMemoryVectorRepository implements IVectorRepository {
  private readonly store = new Map<string, StoredDocumentVector>()

  get(documentId: string): StoredDocumentVector | null {
    return this.store.get(documentId) ?? null
  }

  set(value: StoredDocumentVector): void {
    this.store.set(value.documentId, value)
  }

  ensureFromDocument(document: ParsedDocument, modelId: string): StoredDocumentVector | null {
    const current = this.store.get(document.id)
    if (current && current.modelId === modelId) return current
    const available = document.chunks
      .filter((x) => Array.isArray(x.embedding) && x.embedding.length > 0)
      .map((x) => ({ chunkId: x.id, embedding: x.embedding as number[] }))
    if (available.length === 0) return null
    const stored: StoredDocumentVector = {
      documentId: document.id,
      modelId,
      chunkEmbeddings: available,
      updatedAt: new Date().toISOString(),
    }
    this.store.set(document.id, stored)
    return stored
  }
}
