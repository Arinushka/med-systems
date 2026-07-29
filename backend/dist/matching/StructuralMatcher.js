function normalizeHeading(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
export class StructuralMatcher {
    score(query, candidate) {
        const q = query.sections.map((s) => normalizeHeading(s.heading)).filter((x) => x.length > 0);
        const c = candidate.sections.map((s) => normalizeHeading(s.heading)).filter((x) => x.length > 0);
        if (q.length === 0 || c.length === 0)
            return { structural: 0, matchedSections: [], unmatchedSections: [] };
        const cSet = new Set(c);
        const matchedSections = [];
        const unmatchedSections = [];
        for (const section of q) {
            if (cSet.has(section))
                matchedSections.push(section);
            else
                unmatchedSections.push(section);
        }
        const structural = matchedSections.length / Math.max(1, q.length);
        return { structural, matchedSections, unmatchedSections };
    }
}
