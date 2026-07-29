import OpenAI from 'openai';
import { embedTextsLocal } from './localEmbeddings.js';
import { createProxiedOpenaiFetch } from './openaiFetchProxy.js';
function normalizeVector(v) {
    let sum = 0;
    for (const x of v)
        sum += x * x;
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm <= 1e-12)
        return v;
    return v.map((x) => x / norm);
}
async function embedTextsOllama(texts) {
    const baseUrl = String(process.env.OLLAMA_BASE_URL ?? '').trim() || '';
    const chatUrl = String(process.env.OLLAMA_URL ?? '').trim();
    const endpoint = baseUrl
        ? `${baseUrl.replace(/\/+$/, '')}/api/embeddings`
        : chatUrl
            ? `${chatUrl.replace(/\/api\/chat.*$/i, '').replace(/\/+$/, '')}/api/embeddings`
            : 'http://127.0.0.1:11434/api/embeddings';
    const model = String(process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text').trim();
    const timeoutMs = Number(process.env.OLLAMA_EMBEDDING_TIMEOUT_MS ?? 30000);
    const batchSize = Math.max(1, Number(process.env.OLLAMA_EMBEDDING_BATCH_SIZE ?? 16));
    const retries = Math.max(0, Number(process.env.OLLAMA_EMBEDDING_RETRY_COUNT ?? 2));
    const vectors = [];
    let expectedDim = null;
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        for (const text of batch) {
            let lastErr = '';
            for (let attempt = 0; attempt <= retries; attempt++) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const resp = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal,
                        body: JSON.stringify({ model, prompt: text }),
                    });
                    if (!resp.ok) {
                        const body = await resp.text().catch(() => '');
                        throw new Error(`Ollama embeddings HTTP ${resp.status}: ${body.slice(0, 300)}`);
                    }
                    const payload = await resp.json();
                    const emb = Array.isArray(payload?.embedding) ? payload.embedding : null;
                    if (!emb || emb.length === 0)
                        throw new Error('Empty embedding from Ollama');
                    if (expectedDim == null)
                        expectedDim = emb.length;
                    if (expectedDim !== emb.length) {
                        throw new Error(`Embedding dimension mismatch from Ollama: expected ${expectedDim}, got ${emb.length}`);
                    }
                    vectors.push(normalizeVector(emb.map((x) => Number(x))));
                    lastErr = '';
                    break;
                }
                catch (e) {
                    lastErr = e instanceof Error ? e.message : String(e);
                    if (attempt >= retries)
                        break;
                    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
                }
                finally {
                    clearTimeout(timer);
                }
            }
            if (lastErr)
                throw new Error(`Ollama embeddings failed for model "${model}": ${lastErr}`);
        }
    }
    return vectors;
}
export async function embedTexts(texts) {
    const provider = String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase();
    if (provider === 'ollama') {
        return embedTextsOllama(texts);
    }
    if (provider === 'local') {
        return embedTextsLocal(texts);
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return embedTextsLocal(texts);
    }
    const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
    const openai = new OpenAI({
        apiKey,
        fetch: createProxiedOpenaiFetch(),
    });
    const batchSize = 64;
    const results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        let resp;
        try {
            resp = await openai.embeddings.create({
                model: embeddingModel,
                input: batch,
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.toLowerCase().includes('not supported') || msg.includes('403')) {
                const force = process.env.OPENAI_FORCE === 'true';
                if (force) {
                    throw new Error(`OpenAI blocked (403/not supported). VPN/proxy to supported region required. Original error: ${msg}`);
                }
                return embedTextsLocal(texts);
            }
            throw e;
        }
        const vectors = resp.data.map((d) => normalizeVector(d.embedding.map((x) => Number(x))));
        results.push(...vectors);
    }
    return results;
}
