/**
 * Veyra's own spell check (English, British and American), so suggestions
 * work the same on every computer, offline, whatever Windows has installed.
 * A word is fine if either dictionary knows it, or you added it.
 */
import NSpell from 'nspell'

type Speller = { correct(w: string): boolean; suggest(w: string): string[]; add(w: string): void }
let spellers: Speller[] = []
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

const WORDS_KEY = 'veyra.spell.words'
function ownWords(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORDS_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** Loads the dictionaries (once). */
export function loadSpelling(): Promise<void> {
  loading ??= import('./spell-data').then(({ DICTIONARIES }) => {
    spellers = DICTIONARIES.map((d) => NSpell(d.aff, d.dic) as Speller)
    for (const w of ownWords()) spellers.forEach((s) => s.add(w))
    listeners.forEach((l) => l())
  })
  return loading
}
export const spellingReady = () => spellers.length > 0

/** Runs when the dictionaries load or a word is added (to check pages again). */
export function onSpellingChange(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

const clean = (w: string) => w.replace(/’/g, "'")
export function isWord(word: string): boolean {
  if (!spellers.length) return true
  const w = clean(word)
  return spellers.some((s) => s.correct(w))
}

/** Up to five fixes, British first. */
export function suggestions(word: string): string[] {
  const w = clean(word)
  const out: string[] = []
  for (const s of spellers) for (const x of s.suggest(w)) if (!out.includes(x)) out.push(x)
  return out.slice(0, 5)
}

/** "Add to dictionary": known from now on, on this computer. */
export function learnWord(word: string): void {
  const w = clean(word)
  spellers.forEach((s) => s.add(w))
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify([...new Set([...ownWords(), w])]))
  } catch {
    /* known until Veyra restarts */
  }
  listeners.forEach((l) => l())
}
