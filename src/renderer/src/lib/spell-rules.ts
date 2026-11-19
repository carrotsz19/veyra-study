/**
 * Pure spellcheck filtering & suggestion casing rules.
 * Keeps spellchecking helpful without nagging about names, brands, tech/study words,
 * possessives, or hyphenated prefixes.
 */

export const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ɏ]+(?:['’][A-Za-zÀ-ÖØ-öø-ɏ]+)*/g

const HONORIFIC_RE = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Rev|Gen|Col|Lt|Capt|Sgt|Hon)\.$/i

const EXTRA_WORDS = new Set([
  // App / brand / tech / study terms
  'veyra', 'ironlog', 'cashline', 'pdf', 'pdfs', 'ui', 'ux', 'ai', 'api', 'apis', 'url', 'urls',
  'doi', 'isbn', 'issn', 'pmid', 'arxiv', 'https', 'http', 'ftp', 'www', 'mailto', 'localhost',
  // Common abbreviations, Latin academic terms, months & days
  'etc', 'eg', 'ie', 'vs', 'et', 'al', 'cf', 'ibid', 'viz', 'ca', 'circa', 'approx', 'dept', 'govt',
  'intl', 'natl', 'vol', 'vols', 'ed', 'eds', 'pp', 'ch', 'sec', 'fig', 'figs', 'eq', 'eqs', 'ref',
  'refs', 'nos', 'ok', 'okay', 'btw', 'idk', 'tbh', 'imo', 'fyi', 'asap', 'tl', 'dr',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  // Modern & compound words missing from older Hunspell dictionaries
  'covid', 'coronavirus', 'lockdown', 'lockdowns', 'mothership', 'motherships', 'wellbeing',
  'telehealth', 'telemedicine', 'burnout', 'mindfulness', 'workplace', 'workplaces', 'frontline',
  'pushback', 'rollout', 'rollouts', 'buyout', 'buyouts', 'standout', 'standouts', 'breakout',
  'breakouts', 'dropout', 'dropouts', 'handout', 'handouts', 'writeup', 'writeups', 'checkup',
  'checkups', 'followup', 'followups', 'setup', 'setups', 'backup', 'backups', 'cleanup', 'cleanups',
  'lookup', 'lookups', 'meetup', 'meetups', 'startup', 'startups', 'walkthrough', 'walkthroughs',
  'takeaway', 'takeaways', 'mindset', 'mindsets', 'roadmap', 'roadmaps', 'paywall', 'paywalls',
  'clickbait', 'deepfake', 'deepfakes', 'chatbot', 'chatbots', 'webinar', 'webinars', 'livestream',
  'livestreams', 'livestreamed', 'livestreaming', 'smartphone', 'smartphones', 'smartwatch',
  'smartwatches', 'touchscreen', 'touchscreens', 'hotspot', 'hotspots', 'onboarding', 'offboarding',
  'upskill', 'upskilled', 'upskilling', 'reskill', 'reskilled', 'reskilling', 'freelancer',
  'freelancers', 'coworker', 'coworkers', 'coauthor', 'coauthors', 'coauthored', 'preprint',
  'preprints', 'dataset', 'datasets', 'metadata', 'timestamp', 'timestamps', 'hyperlink',
  'hyperlinks', 'permalink', 'permalinks', 'benchmark', 'benchmarks', 'benchmarking', 'stakeholder',
  'stakeholders', 'deliverable', 'deliverables', 'actionable', 'scalable', 'scalability',
  'refactor', 'refactored', 'refactoring', 'codebase', 'codebases', 'frontend', 'backend',
  'fullstack', 'devops', 'middleware', 'microservice', 'microservices', 'webhook', 'webhooks',
  'oauth', 'regex', 'hostname', 'subdomain', 'subdomains', 'pathname', 'filesystem', 'changelog',
  'changelogs', 'readme', 'hotfix', 'hotfixes', 'bugfix', 'bugfixes', 'wireframe', 'wireframes',
  'mockup', 'mockups', 'kanban', 'pomodoro', 'zettelkasten', 'mindmap', 'mindmaps', 'notetaking',
  'rubric', 'rubrics', 'firsthand', 'secondhand', 'thirdhand', 'shortlist', 'shortlisted',
  'shortlisting', 'fasttrack', 'doomscrolling', 'fintech', 'edtech', 'biotech', 'crowdfunding',
  'crowdsourcing', 'factcheck', 'factchecked', 'factchecking', 'broadband', 'gigabyte', 'gigabytes',
  'terabyte', 'terabytes', 'megabyte', 'megabytes', 'kilobyte', 'kilobytes',
  'vlog', 'vlogs', 'vlogger', 'blog', 'blogs', 'blogger', 'blogging', 'repost', 'reposted',
  'reposting', 'unfollow', 'unfollowed', 'unfollowing', 'hashtag', 'hashtags', 'selfie', 'selfies',
  'meme', 'memes', 'gif', 'gifs',
  // UI / study / platform terms
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
  'autocorrect', 'spellcheck', 'spellchecker', 'dm', 'dms', 'tiktok', 'instagram', 'linkedin',
  'reddit', 'spotify', 'netflix', 'wikipedia', 'pubmed', 'zotero', 'mendeley', 'overleaf', 'latex',
  'jupyter', 'colab', 'figma', 'canva', 'slack', 'onenote', 'evernote', 'obsidian', 'goodnotes',
  'notability'
])

const HYPHEN_PREFIXES = new Set([
  'anti', 'auto', 'bio', 'co', 'counter', 'cyber', 'de', 'dis', 'eco', 'electro', 'ex', 'extra',
  'geo', 'hyper', 'inter', 'intra', 'macro', 'mega', 'meta', 'micro', 'mid', 'mini', 'mis', 'mono',
  'multi', 'neo', 'neuro', 'non', 'omni', 'out', 'over', 'para', 'photo', 'poly', 'post', 'pre',
  'pro', 'proto', 'pseudo', 'psycho', 're', 'self', 'semi', 'socio', 'sub', 'super', 'techno',
  'tele', 'thermo', 'trans', 'tri', 'ultra', 'un', 'under', 'uni', 'vice'
])

// Prefixes commonly attached directly without a hyphen (telehealth, cyberbullying, neurodivergent).
const SOLID_PREFIXES = [
  'counter', 'electro', 'pseudo', 'psycho', 'techno', 'thermo', 'extra', 'hyper', 'inter', 'intra',
  'macro', 'micro', 'multi', 'neuro', 'photo', 'socio', 'super', 'trans', 'ultra', 'under', 'anti',
  'auto', 'cyber', 'mega', 'meta', 'mini', 'mono', 'omni', 'over', 'para', 'poly', 'post', 'self',
  'semi', 'tele', 'bio', 'dis', 'eco', 'geo', 'mid', 'mis', 'neo', 'non', 'out', 'pre', 'pro',
  'sub', 'tri', 'uni', 'co', 'de', 're', 'un'
]

// Matches full URLs, mailto links, www addresses, email addresses, and domain/path tokens.
const IGNORED_SPAN_RE =
  /\b(?:(?:https?|ftp|ftps|file|ws|wss|veyra):\/\/[^\s<>()[\]"'’]+|mailto:[^\s<>()[\]"'’]+|www\.[^\s<>()[\]"'’]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/[^\s<>()[\]"'’]*|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|edu|gov|io|dev|app|ai|sg|uk|us|ca|au|co|me|tv|info|news|network|study|pdf|png|jpg|jpeg|svg|gif|webp|mp3|mp4|wav|csv|json|tsx?|jsx?|mjs|css|html|md|txt|docx?|xlsx?|pptx?|zip))\b/gi

const URL_HOST_RE = /\b(?:https?:\/\/|www\.)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gi

const NUMBERED_LIST_PREFIX_RE = /^\s*(?:\d+[.)]|[A-Za-z][.)])\s+$/

export type TextSpan = [start: number, end: number]

/** Collects URL, email, domain, and filename spans in a block that spellcheck should skip completely. */
export function collectIgnoredSpans(blockText: string): TextSpan[] {
  const spans: TextSpan[] = []
  for (const m of blockText.matchAll(IGNORED_SPAN_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    spans.push([start, end])
  }
  return spans
}

function inIgnoredSpan(spans: TextSpan[], start: number, end: number): boolean {
  for (const [s, e] of spans) {
    if (start >= s && end <= e) return true
    if (s > end) break
  }
  return false
}

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
 * plus hostnames from URLs in the note (e.g. `mothership.sg` -> `Mothership`),
 * so the same name won't be flagged when it starts a heading or sentence.
 */
export function collectDocumentNames(blockTexts: string[]): Set<string> {
  const names = new Set<string>()
  for (const text of blockTexts) {
    const ignored = collectIgnoredSpans(text)
    for (const m of text.matchAll(WORD_RE)) {
      const w = m[0]
      const at = m.index ?? 0
      if (w.length < 2 || w === w.toUpperCase()) continue
      if (inIgnoredSpan(ignored, at, at + w.length)) continue
      if (isProperNounShape(w) && !isAtSentenceStart(text, at)) {
        const base = stripPossessive(w)
        names.add(base)
        names.add(base.toLowerCase())
      }
    }
    for (const m of text.matchAll(URL_HOST_RE)) {
      const host = (m[1] ?? '').toLowerCase()
      for (const part of host.split('.')) {
        if (part.length >= 3 && part !== 'www') names.add(part)
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
  ignoredSpans?: TextSpan[]
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

  const endInBlock = offsetInBlock + word.length
  const ignoredSpans = ctx.ignoredSpans ?? collectIgnoredSpans(blockText)
  if (inIgnoredSpan(ignoredSpans, offsetInBlock, endInBlock)) return true

  const before = blockText[offsetInBlock - 1] ?? ''
  const after = blockText[endInBlock] ?? ''
  const after2 = blockText[endInBlock + 1] ?? ''

  // Numbers, emails, handles, file paths, domains, URL schemes
  if (/[0-9_@/\\]/.test(before + after)) return true
  if (after === '.' && /[A-Za-z]/.test(after2)) return true
  if (after === ':' && after2 === '/') return true

  // CamelCase / mixed-case brand & surnames (iPhone, IronLog, McDonald, JavaScript)
  if (isCamelOrMixedCase(clean)) return true

  // Built-in study/tech/app/academic words
  if (EXTRA_WORDS.has(lower) || EXTRA_WORDS.has(baseLower)) return true

  // Hyphenated prefixes like pre-exam, non-linear, re-read
  if (after === '-' && HYPHEN_PREFIXES.has(lower)) return true

  // Mid-sentence proper nouns / names, document-learned names, and citation author/source titles
  if (isProperNounShape(clean)) {
    if (!isAtSentenceStart(blockText, offsetInBlock) || docNames?.has(base) || docNames?.has(baseLower)) {
      return true
    }
    const tail = blockText.slice(endInBlock)
    // Academic author citations ("Tan et al.", "1. Subramaniam et al.")
    if (/^\s+et\s+al\b/i.test(tail)) return true
    // Citation or source titles at block/item start ('3. Mothership, "Firsthand..."', 'Kallang (2023)')
    const head = blockText.slice(0, offsetInBlock)
    if (
      (/^\s*$/.test(head) && /^(?:,\s*["“'(]|\s*\(\d{4})/.test(tail)) ||
      (NUMBERED_LIST_PREFIX_RE.test(head) && /^(?:,\s*["“'(]|\s*\(\d{4}|\s*:)/.test(tail))
    ) {
      return true
    }
  }

  // Dictionary lookup (exact, lowercase fallback for sentence start, and possessive base)
  if (inDict(clean)) return true
  if (clean !== lower && inDict(lower)) return true
  if (base !== clean) {
    if (inDict(base) || inDict(baseLower)) return true
  }

  // Productive unhyphenated prefix compounds (telehealth, cyberbullying, neurodivergent, subtopic)
  if (baseLower.length >= 7) {
    for (const prefix of SOLID_PREFIXES) {
      if (baseLower.startsWith(prefix)) {
        const rest = baseLower.slice(prefix.length)
        if (rest.length >= 4 && inDict(rest)) return true
      }
    }
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
