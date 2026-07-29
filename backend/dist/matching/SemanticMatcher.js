import { cosineSimilarity } from '../utils/cosine.js';
function safeCosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0)
        return 0;
    return Math.max(-1, Math.min(1, cosineSimilarity(a, b)));
}
function bestMatches(source, target) {
    const out = [];
    for (const s of source) {
        let best = -1;
        for (const t of target) {
            const c = safeCosine(s.embedding, t.embedding);
            if (c > best)
                best = c;
        }
        if (best >= -1)
            out.push(best);
    }
    return out;
}
function avgTopK(values, k) {
    if (values.length === 0)
        return 0;
    const sorted = values.slice().sort((a, b) => b - a);
    const top = sorted.slice(0, Math.max(1, Math.min(sorted.length, k)));
    return top.reduce((acc, x) => acc + x, 0) / top.length;
}
export class SemanticMatcher {
    topKChunkMatches;
    constructor(topKChunkMatches) {
        this.topKChunkMatches = topKChunkMatches;
    }
    score(query, candidate) {
        const qChunks = query.chunks.filter((c) => Array.isArray(c.embedding));
        const cChunks = candidate.chunks.filter((c) => Array.isArray(c.embedding));
        if (qChunks.length === 0 || cChunks.length === 0) {
            return {
                semantic: 0,
                coverageAByB: 0,
                coverageBByA: 0,
                containmentScore: 0,
            };
        }
        const aToB = bestMatches(qChunks, cChunks);
        const bToA = bestMatches(cChunks, qChunks);
        const coverageThreshold = Number(process.env.MATCH_SEMANTIC_COVERAGE_THRESHOLD ?? 0.62);
        const coverageAByB = aToB.filter((x) => x >= coverageThreshold).length / Math.max(1, aToB.length);
        const coverageBByA = bToA.filter((x) => x >= coverageThreshold).length / Math.max(1, bToA.length);
        const containmentScore = Math.min(coverageAByB, coverageBByA);
        const semanticForward = avgTopK(aToB, this.topKChunkMatches);
        const semanticBackward = avgTopK(bToA, this.topKChunkMatches);
        const semantic = Math.max(0, Math.min(1, (semanticForward + semanticBackward) / 2));
        return {
            semantic,
            coverageAByB,
            coverageBByA,
            containmentScore,
        };
    }
}
