export class MatchPipeline {
    embeddings;
    vectors;
    candidateRetriever;
    lexicalMatcher;
    semanticMatcher;
    structuralMatcher;
    exactFieldMatcher;
    scorer;
    reranker;
    explanationBuilder;
    constructor(_config, embeddings, vectors, candidateRetriever, lexicalMatcher, semanticMatcher, structuralMatcher, exactFieldMatcher, scorer, reranker, explanationBuilder) {
        this.embeddings = embeddings;
        this.vectors = vectors;
        this.candidateRetriever = candidateRetriever;
        this.lexicalMatcher = lexicalMatcher;
        this.semanticMatcher = semanticMatcher;
        this.structuralMatcher = structuralMatcher;
        this.exactFieldMatcher = exactFieldMatcher;
        this.scorer = scorer;
        this.reranker = reranker;
        this.explanationBuilder = explanationBuilder;
    }
    async ensureChunkEmbeddings(document) {
        const missing = document.chunks.filter((c) => !Array.isArray(c.embedding) || c.embedding.length === 0);
        if (missing.length === 0) {
            this.vectors.ensureFromDocument(document, this.embeddings.modelId());
            return;
        }
        const vectors = await this.embeddings.embed(missing.map((x) => x.text));
        for (let i = 0; i < missing.length; i++)
            missing[i].embedding = vectors[i];
        this.vectors.ensureFromDocument(document, this.embeddings.modelId());
    }
    metadataScore(a, b) {
        const extScore = a.metadata.extension === b.metadata.extension ? 1 : 0.4;
        const sizeA = Math.max(1, a.metadata.sizeBytes);
        const sizeB = Math.max(1, b.metadata.sizeBytes);
        const ratio = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
        return Math.max(0, Math.min(1, extScore * 0.35 + ratio * 0.65));
    }
    buildInitialDecision(signals, matchedSections, unmatchedSections, conflictingFields) {
        const { finalScore, matchType, isMatch } = this.scorer.score(signals);
        return {
            isMatch,
            confidence: finalScore,
            matchType,
            scores: signals,
            matchedSections,
            unmatchedSections,
            conflictingFields,
            explanation: '',
        };
    }
    async compare(query, library) {
        if (library.length === 0)
            return null;
        await this.ensureChunkEmbeddings(query);
        for (const doc of library)
            await this.ensureChunkEmbeddings(doc);
        const preselected = this.candidateRetriever.retrieve(query, library, Math.max(2, Number(process.env.MATCH_HYBRID_CANDIDATES ?? 12)));
        let best = null;
        for (const candidate of preselected) {
            const semanticRes = this.semanticMatcher.score(query, candidate);
            const lexical = this.lexicalMatcher.score(query, candidate);
            const structuralRes = this.structuralMatcher.score(query, candidate);
            const exactRes = this.exactFieldMatcher.score(query, candidate);
            const metadata = this.metadataScore(query, candidate);
            const signals = {
                semantic: semanticRes.semantic,
                lexical,
                structural: structuralRes.structural,
                exactFields: exactRes.exactFields,
                metadata,
                coverageAByB: semanticRes.coverageAByB,
                coverageBByA: semanticRes.coverageBByA,
                containmentScore: semanticRes.containmentScore,
            };
            let decision = this.buildInitialDecision(signals, structuralRes.matchedSections, structuralRes.unmatchedSections, exactRes.conflictingFields);
            decision = await this.reranker.rerankIfNeeded({
                query,
                candidate,
                scores: signals,
                initialDecision: decision,
            });
            decision.explanation = this.explanationBuilder.build(decision);
            if (!best || decision.confidence > best.decision.confidence) {
                best = { document: candidate, decision };
            }
        }
        return best;
    }
}
