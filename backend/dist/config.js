export const config = {
    port: Number(process.env.PORT ?? 3001),
    openaiApiKey: process.env.OPENAI_API_KEY,
    // Keep it small/cheap for embeddings. You can switch to a different model later.
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
};
