export class CandidateRetriever {
    lexicalMatcher;
    constructor(lexicalMatcher) {
        this.lexicalMatcher = lexicalMatcher;
    }
    retrieve(query, candidates, limit) {
        const scored = candidates
            .map((doc) => ({
            doc,
            lexical: this.lexicalMatcher.score(query, doc),
        }))
            .sort((a, b) => b.lexical - a.lexical);
        return scored.slice(0, Math.max(1, limit)).map((x) => x.doc);
    }
}
