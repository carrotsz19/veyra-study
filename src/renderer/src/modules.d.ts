declare module '*?raw' {
  const text: string
  export default text
}

declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string): NSpell
  }
  export default function nspell(aff: string | Uint8Array, dic?: string | Uint8Array): NSpell
}
