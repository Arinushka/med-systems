import type { ExactFields } from './types.js'

export interface IKeyFieldExtractor {
  extract(text: string): ExactFields
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((x) => x.trim()).filter(Boolean))]
}

export class KeyFieldExtractor implements IKeyFieldExtractor {
  extract(text: string): ExactFields {
    const source = String(text ?? '')

    const contractNumbers = uniq(
      [...source.matchAll(/\b(?:№|no\.?|number)?\s*([a-zа-яё0-9-]{5,})\b/gi)].map((m) => String(m[1] ?? '')),
    )
    const identifiers = uniq([...source.matchAll(/\b[a-zа-яё]{1,8}-\d{2,8}(?:-\d{1,8})?\b/gi)].map((m) => String(m[0] ?? '')))
    const dates = uniq([...source.matchAll(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g)].map((m) => String(m[0] ?? '')))
    const emails = uniq(
      [...source.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => String(m[0] ?? '').toLowerCase()),
    )
    const phones = uniq(
      [...source.matchAll(/(?:\+?\d[\d()\-\s]{8,}\d)/g)].map((m) => String(m[0] ?? '').replace(/[^\d+]/g, '')),
    )
    const organizationNames = uniq(
      [...source.matchAll(/\b(?:ооо|ао|пао|гбуз|фгбу|ип)\s+["«]?[a-zа-яё0-9 .,-]{3,80}["»]?/gi)].map((m) =>
        String(m[0] ?? ''),
      ),
    )

    return {
      contractNumbers,
      identifiers,
      dates,
      emails,
      phones,
      organizationNames,
    }
  }
}
