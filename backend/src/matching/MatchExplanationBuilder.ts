import type { MatchDecision } from './types.js'

export interface IMatchExplanationBuilder {
  build(decision: MatchDecision): string
}

export class MatchExplanationBuilder implements IMatchExplanationBuilder {
  build(decision: MatchDecision): string {
    const s = decision.scores
    return [
      `Тип: ${decision.matchType}`,
      `confidence=${decision.confidence.toFixed(3)}`,
      `semantic=${s.semantic.toFixed(3)}, lexical=${s.lexical.toFixed(3)}, structural=${s.structural.toFixed(3)}, exact=${s.exactFields.toFixed(3)}`,
      `coverage A->B=${s.coverageAByB.toFixed(3)}, B->A=${s.coverageBByA.toFixed(3)}`,
      decision.conflictingFields.length > 0 ? `конфликты: ${decision.conflictingFields.join(', ')}` : 'критических конфликтов не найдено',
    ].join(' | ')
  }
}
