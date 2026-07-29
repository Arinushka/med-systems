declare module 'tesseract.js' {
  export function recognize(
    image: Buffer | Uint8Array | ArrayBuffer | string,
    langs?: string,
    options?: Record<string, unknown>,
  ): Promise<{
    data?: {
      text?: string
    }
  }>
}
