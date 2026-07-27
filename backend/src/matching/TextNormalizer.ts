export interface ITextNormalizer {
  normalize(input: string): string
}

export class TextNormalizer implements ITextNormalizer {
  normalize(input: string): string {
    return String(input ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[“”«»]/g, '"')
      .replace(/[’‘]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .toLowerCase()
  }
}
