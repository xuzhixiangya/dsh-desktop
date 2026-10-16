declare module 'katex/dist/katex.min.css'

declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string)
    readonly window: Window & typeof globalThis
  }
}
