export class InMemoryVectorRepository {
    store = new Map();
    get(documentId) {
        return this.store.get(documentId) ?? null;
    }
    set(value) {
        this.store.set(value.documentId, value);
    }
    ensureFromDocument(document, modelId) {
        const current = this.store.get(document.id);
        if (current && current.modelId === modelId)
            return current;
        const available = document.chunks
            .filter((x) => Array.isArray(x.embedding) && x.embedding.length > 0)
            .map((x) => ({ chunkId: x.id, embedding: x.embedding }));
        if (available.length === 0)
            return null;
        const stored = {
            documentId: document.id,
            modelId,
            chunkEmbeddings: available,
            updatedAt: new Date().toISOString(),
        };
        this.store.set(document.id, stored);
        return stored;
    }
}
