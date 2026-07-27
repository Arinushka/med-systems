import type { ParsedDocument } from './types.js'

export interface IExactFieldMatcher {
  score(query: ParsedDocument, candidate: ParsedDocument): { exactFields: number; conflictingFields: string[] }
}

function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const bSet = new Set(b.map((x) => x.toLowerCase()))
  let hit = 0
  for (const value of a) if (bSet.has(value.toLowerCase())) hit++
  return hit / a.length
}

export class ExactFieldMatcher implements IExactFieldMatcher {
  score(query: ParsedDocument, candidate: ParsedDocument): { exactFields: number; conflictingFields: string[] } {
    const q = query.exactFields
    const c = candidate.exactFields

    const contractHit = overlapRatio(q.contractNumbers, c.contractNumbers)
    const idHit = overlapRatio(q.identifiers, c.identifiers)
    const orgHit = overlapRatio(q.organizationNames, c.organizationNames)
    const dateHit = overlapRatio(q.dates, c.dates)
    const emailHit = overlapRatio(q.emails, c.emails)

    const score = Math.max(0, Math.min(1, contractHit * 0.35 + idHit * 0.35 + orgHit * 0.2 + dateHit * 0.05 + emailHit * 0.05))

    const conflictingFields: string[] = []
    if (q.contractNumbers.length > 0 && c.contractNumbers.length > 0 && contractHit === 0) conflictingFields.push('contractNumbers')
    if (q.identifiers.length > 0 && c.identifiers.length > 0 && idHit === 0) conflictingFields.push('identifiers')
    return { exactFields: score, conflictingFields }
  }
}
