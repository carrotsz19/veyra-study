/**
 * Veyra's own spell check (English, British and American), so suggestions
 * work the same on every computer, offline, whatever Windows has installed.
 * A word is fine if either dictionary knows it, or you added it.
 */
import NSpell from 'nspell'
import { matchSuggestionCase, normalizeApostrophe } from './spell-rules'

type Speller = { correct(w: string): boolean; suggest(w: string): string[]; add(w: string): void }
let spellers: Speller[] = []
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
const ignored = new Set<string>()

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

/** Runs when the dictionaries load or a word is added/ignored (to check pages again). */
export function onSpellingChange(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function isWord(word: string): boolean {
  if (!spellers.length) return true
  const w = normalizeApostrophe(word)
  if (ignored.has(w) || ignored.has(w.toLowerCase())) return true
  return spellers.some((s) => s.correct(w))
}

/** Up to five fixes, British first, matching the original word's capitalization. */
export function suggestions(word: string): string[] {
  const w = normalizeApostrophe(word)
  const lower = w.toLowerCase()
  const out: string[] = []
  const push = (raw: string) => {
    const cased = matchSuggestionCase(w, raw)
    if (cased !== w && !out.includes(cased)) out.push(cased)
  }
  for (const s of spellers) for (const x of s.suggest(w)) push(x)
  if (out.length < 5 && w !== lower) {
    for (const s of spellers) for (const x of s.suggest(lower)) push(x)
  }
  return out.slice(0, 5)
}

/** Ignore a word for this session without saving it permanently to the dictionary. */
export function ignoreWord(word: string): void {
  const w = normalizeApostrophe(word)
  ignored.add(w)
  listeners.forEach((l) => l())
}

/** "Add to dictionary": known from now on, on this computer. */
export function learnWord(word: string): void {
  const w = normalizeApostrophe(word)
  spellers.forEach((s) => s.add(w))
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify([...new Set([...ownWords(), w])]))
  } catch {
    /* known until Veyra restarts */
  }
  listeners.forEach((l) => l())
}
