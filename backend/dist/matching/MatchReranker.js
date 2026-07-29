function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
export class MatchReranker {
    async rerankIfNeeded(params) {
        const low = Number(process.env.MATCH_RERANK_LOW ?? 0.45);
        const high = Number(process.env.MATCH_RERANK_HIGH ?? 0.75);
        const aggregate = params.scores.semantic * 0.45 +
            params.scores.lexical * 0.2 +
            params.scores.structural * 0.15 +
            params.scores.exactFields * 0.2;
        if (aggregate < low || aggregate > high)
            return params.initialDecision;
        const ollamaUrl = String(process.env.OLLAMA_URL ?? '').trim();
        if (!ollamaUrl)
            return params.initialDecision;
        const queryTopChunks = params.query.chunks.slice(0, 5).map((x) => ({ heading: x.sectionHeading, text: x.text.slice(0, 800) }));
        const candidateTopChunks = params.candidate.chunks
            .slice(0, 5)
            .map((x) => ({ heading: x.sectionHeading, text: x.text.slice(0, 800) }));
        const prompt = `Ты валидируешь сопоставление двух документов.
Верни строго JSON:
{
  "sameDocument": boolean,
  "confidence": number,
  "explanation": string,
  "criticalConflicts": string[]
}
scores=${JSON.stringify(params.scores)}
queryKeyFields=${JSON.stringify(params.query.exactFields)}
candidateKeyFields=${JSON.stringify(params.candidate.exactFields)}
queryChunks=${JSON.stringify(queryTopChunks)}
candidateChunks=${JSON.stringify(candidateTopChunks)}`;
        const model = String(process.env.OLLAMA_RERANK_MODEL ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:latest');
        const resp = await fetch(ollamaUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                options: { temperature: 0, num_predict: Number(process.env.OLLAMA_RERANK_NUM_PREDICT ?? 240) },
            }),
        }).catch(() => null);
        if (!resp || !resp.ok)
            return params.initialDecision;
        const json = await resp.json().catch(() => null);
        const payload = (json ?? {});
        const content = String(payload?.message?.content ?? payload?.response ?? '').trim();
        if (!content)
            return params.initialDecision;
        const cleaned = content.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
        const first = cleaned.indexOf('{');
        const last = cleaned.lastIndexOf('}');
        if (first < 0 || last <= first)
            return params.initialDecision;
        const parsed = JSON.parse(cleaned.slice(first, last + 1));
        if (typeof parsed.sameDocument !== 'boolean')
            return params.initialDecision;
        const rerankConfidence = clamp01(Number(parsed.confidence));
        const next = {
            ...params.initialDecision,
            isMatch: parsed.sameDocument,
            confidence: Math.max(params.initialDecision.confidence, rerankConfidence),
            matchType: parsed.sameDocument ? params.initialDecision.matchType : 'not_match',
            explanation: typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
                ? parsed.explanation.trim()
                : params.initialDecision.explanation,
            conflictingFields: Array.isArray(parsed.criticalConflicts)
                ? parsed.criticalConflicts.map((x) => String(x)).filter(Boolean)
                : params.initialDecision.conflictingFields,
        };
        return next;
    }
}
