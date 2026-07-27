import type { ParsedDocument } from './types.js'
import type { ILexicalMatcher } from './LexicalMatcher.js'

export interface ICandidateRetriever {
  retrieve(query: ParsedDocument, candidates: ParsedDocument[], limit: number): ParsedDocument[]
}

export class CandidateRetriever implements ICandidateRetriever {
  constructor(private readonly lexicalMatcher: ILexicalMatcher) {}

  retrieve(query: ParsedDocument, candidates: ParsedDocument[], limit: number): ParsedDocument[] {
    const scored = candidates
      .map((doc) => ({
        doc,
        lexical: this.lexicalMatcher.score(query, doc),
      }))
      .sort((a, b) => b.lexical - a.lexical)
    return scored.slice(0, Math.max(1, limit)).map((x) => x.doc)
  }
}
