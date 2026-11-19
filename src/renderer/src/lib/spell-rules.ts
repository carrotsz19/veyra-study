/**
 * Pure spellcheck filtering & suggestion casing rules.
 * Keeps spellchecking helpful without nagging about names, brands, tech/study words,
 * possessives, or hyphenated prefixes.
 */

export const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ɏ]+(?:['’][A-Za-zÀ-ÖØ-öø-ɏ]+)*/g

const HONORIFIC_RE = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Rev|Gen|Col|Lt|Capt|Sgt|Hon)\.$/i

const EXTRA_WORDS = new Set([
  'veyra', 'ironlog', 'cashline', 'pdf', 'pdfs', 'ui', 'ux', 'ai', 'api', 'apis', 'url', 'urls',
  'etc', 'eg', 'ie', 'vs', 'ok', 'okay', 'btw', 'idk', 'tbh', 'imo', 'fyi', 'asap', 'tl', 'dr',
  'todo', 'todos', 'checkbox', 'checkboxes', 'callout', 'callouts', 'flashcard', 'flashcards',
  'dropdown', 'dropdowns', 'sidebar', 'sidebars', 'toolbar', 'toolbars', 'navbar', 'scrollbar',
  'scrollbars', 'darkmode', 'offline', 'online', 'sync', 'synced', 'syncing', 'signup', 'signin',
  'login', 'logout', 'username', 'usernames', 'screenshot', 'screenshots', 'workflow', 'workflows',
  'checklist', 'checklists', 'subheading', 'subheadings', 'bookmark', 'bookmarks', 'markdown',
  'emoji', 'emojis', 'podcast', 'podcasts', 'playlist', 'playlists', 'voicemail', 'transcribe',
  'transcribed', 'transcribing', 'transcript', 'transcripts', 'homework', 'coursework', 'midterm',
  'midterms', 'finals', 'syllabus', 'quizlet', 'notion', 'anki', 'zoom', 'discord', 'whatsapp',
  'youtube', 'google', 'github', 'chatgpt', 'claude', 'gemini', 'openai', 'anthropic', 'python',
  'javascript', 'typescript', 'react', 'html', 'css', 'sql', 'json', 'wifi', 'bluetooth', 'email',
  'emails', 'emailed', 'emailing', 'app', 'apps', 'web', 'website', 'websites', 'laptop', 'laptops',
  'tablet', 'tablets', 'stylus', 'webcam', 'mic', 'mics', 'repo', 'repos', 'dev', 'devs', 'config',
  'configs', 'plugin', 'plugins', 'popup', 'popups', 'tooltip', 'tooltips', 'autosave',
  'autocorrect', 'spellcheck', 'spellchecker', 'dm', 'dms', 'pdf'
])

const HYPHEN_PREFIXES = new Set([
  'anti', 'auto', 'bio', 'co', 'counter', 'de', 'dis', 'electro', 'ex', 'extra', 'hyper', 'inter',
  'intra', 'macro', 'meta', 'micro', 'mid', 'mini', 'mis', 'mono', 'multi', 'neo', 'non', 'out',
  'over', 'para', 'poly', 'post', 'pre', 'pro', 'proto', 'pseudo', 're', 'self', 'semi', 'sub',
  'super', 'tele', 'thermo', 'trans', 'tri', 'ultra', 'un', 'under', 'uni', 'vice'
])

/** Strips curly apostrophes to straight ASCII apostrophes. */
export const normalizeApostrophe = (w: string): string => w.replace(/’/g, "'")

/** Strips a trailing possessive ('s) so names & nouns like "Garrett's" evaluate on their base word. */
export function stripPossessive(w: string): string {
  return normalizeApostrophe(w).replace(/'s$/i, '')
}

/** True for mixed-case / CamelCase names & identifiers like iPhone, IronLog, McDonald, JavaScript. */
export function isCamelOrMixedCase(w: string): boolean {
  return /[a-zà-öø-ÿ][A-ZÀ-ÖØ-Þ]/.test(w)
}

/** True for TitleCase words (including Irish/Scottish/apostrophe names like O'Connor, D'Angelo). */
export function isProperNounShape(w: string): boolean {
  const base = stripPossessive(w)
  return /^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ɏ]+)*$/.test(base) ||
    /^[A-ZÀ-ÖØ-Þ]['’][A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ]+$/.test(base)
}

/** True when `offset` in a text block begins a sentence (block start or after . ! ? …). */
export function isAtSentenceStart(blockText: string, offset: number): boolean {
  const before = blockText.slice(0, offset).replace(/[\s"'“‘(\[—–\-•*]+$/, '')
  if (!before) return true
  if (HONORIFIC_RE.test(before)) return false
  return /[.!?…\n]$/.test(before)
}

/**
 * Collects capitalized proper nouns that appear mid-sentence anywhere in the note,
 * so the same name won't be flagged when it starts another sentence.
 */
export function collectDocumentNames(blockTexts: string[]): Set<string> {
  const names = new Set<string>()
  for (const text of blockTexts) {
    for (const m of text.matchAll(WORD_RE)) {
      const w = m[0]
      const at = m.index ?? 0
      if (w.length < 2 || w === w.toUpperCase()) continue
      if (isProperNounShape(w) && !isAtSentenceStart(text, at)) {
        names.add(stripPossessive(w))
      }
    }
  }
  return names
}

export interface WordContext {
  word: string
  blockText: string
  offsetInBlock: number
  docNames?: Set<string>
}

/**
 * Decides whether a word should be considered correctly spelled (or intentionally skipped)
 * given a dictionary checker `inDict`.
 */
export function isAcceptableWord(
  ctx: WordContext,
  inDict: (word: string) => boolean
): boolean {
  const { word, blockText, offsetInBlock, docNames } = ctx
  const clean = normalizeApostrophe(word)
  const base = stripPossessive(clean)
  const lower = clean.toLowerCase()
  const baseLower = base.toLowerCase()

  if (clean.length < 2) return true
  // Acronyms & Roman numerals (HTML, NASA, IV, PDF)
  if (clean === clean.toUpperCase()) return true

  const before = blockText[offsetInBlock - 1] ?? ''
  const after = blockText[offsetInBlock + word.length] ?? ''
  const after2 = blockText[offsetInBlock + word.length + 1] ?? ''

  // Numbers, emails, handles, file paths, domains
  if (/[0-9_@/\\]/.test(before + after)) return true
  if (after === '.' && /[A-Za-z]/.test(after2)) return true

  // CamelCase / mixed-case brand & surnames (iPhone, IronLog, McDonald, JavaScript)
  if (isCamelOrMixedCase(clean)) return true

  // Built-in study/tech/app words
  if (EXTRA_WORDS.has(lower) || EXTRA_WORDS.has(baseLower)) return true

  // Hyphenated prefixes like pre-exam, non-linear, re-read
  if (after === '-' && HYPHEN_PREFIXES.has(lower)) return true

  // Mid-sentence proper nouns / names (and names already seen mid-sentence in the same note)
  if (isProperNounShape(clean)) {
    if (!isAtSentenceStart(blockText, offsetInBlock) || docNames?.has(base)) {
      return true
    }
  }

  // Dictionary lookup (exact, lowercase fallback for sentence start, and possessive base)
  if (inDict(clean)) return true
  if (clean !== lower && inDict(lower)) return true
  if (base !== clean) {
    if (inDict(base) || inDict(baseLower)) return true
  }

  return false
}

/** Matches suggestion capitalization to the original word ("Recieve" -> "Receive"). */
export function matchSuggestionCase(original: string, suggestion: string): string {
  if (!original || !suggestion) return suggestion
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) {
    return suggestion.toUpperCase()
  }
  const first = original[0]
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    const sf = suggestion[0]
    if (sf === sf.toLowerCase() && sf !== sf.toUpperCase()) {
      return sf.toUpperCase() + suggestion.slice(1)
    }
  }
  return suggestion
}
