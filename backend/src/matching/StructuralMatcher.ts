import type { ParsedDocument } from './types.js'

export interface IStructuralMatcher {
  score(query: ParsedDocument, candidate: ParsedDocument): { structural: number; matchedSections: string[]; unmatchedSections: string[] }
}

function normalizeHeading(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class StructuralMatcher implements IStructuralMatcher {
  score(query: ParsedDocument, candidate: ParsedDocument): { structural: number; matchedSections: string[]; unmatchedSections: string[] } {
    const q = query.sections.map((s) => normalizeHeading(s.heading)).filter((x) => x.length > 0)
    const c = candidate.sections.map((s) => normalizeHeading(s.heading)).filter((x) => x.length > 0)
    if (q.length === 0 || c.length === 0) return { structural: 0, matchedSections: [], unmatchedSections: [] }

    const cSet = new Set(c)
    const matchedSections: string[] = []
    const unmatchedSections: string[] = []
    for (const section of q) {
      if (cSet.has(section)) matchedSections.push(section)
      else unmatchedSections.push(section)
    }

    const structural = matchedSections.length / Math.max(1, q.length)
    return { structural, matchedSections, unmatchedSections }
  }
}
