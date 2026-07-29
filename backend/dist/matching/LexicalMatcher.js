function tokenize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 3);
}
export class LexicalMatcher {
    score(query, candidate) {
        const q = tokenize(`${query.normalizedText}\n${query.keyTerms.join(' ')}`);
        const c = tokenize(`${candidate.normalizedText}\n${candidate.keyTerms.join(' ')}`);
        if (q.length === 0 || c.length === 0)
            return 0;
        const qSet = new Set(q);
        const cSet = new Set(c);
        let inter = 0;
        for (const t of qSet)
            if (cSet.has(t))
                inter++;
        const union = qSet.size + cSet.size - inter;
        if (union <= 0)
            return 0;
        const jaccard = inter / union;
        const recall = inter / qSet.size;
        const precision = inter / cSet.size;
        return Math.max(0, Math.min(1, 0.5 * jaccard + 0.3 * recall + 0.2 * precision));
    }
}
