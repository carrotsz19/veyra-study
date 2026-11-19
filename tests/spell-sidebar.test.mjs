// Unit tests for Zen-style sidebar resizing and forgiving spellcheck rules.
// Run: node --test tests/spell-sidebar.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampSidebarWidth,
  resolveSidebarDrag,
  SIDEBAR_COLLAPSE_THRESHOLD,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_EXPAND_THRESHOLD,
  SIDEBAR_ICONS_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from '../src/shared/sidebar.ts'
import {
  collectDocumentNames,
  isAcceptableWord,
  isAtSentenceStart,
  matchSuggestionCase,
  WORD_RE
} from '../src/renderer/src/lib/spell-rules.ts'

const MINI_DICT = new Set([
  'the', 'exam', 'met', 'with', 'brought', 'notes', 'package', 'today', 'is', 'great',
  'read', 'linear', 'receive', 'spelling', 'friend', 'study', 'class', 'tomorrow', 'she', 'he',
  'and', 'at', 'on', 'are', 'will'
])
const inDict = (w) => MINI_DICT.has(w)

function flaggedWords(blocks) {
  const docNames = collectDocumentNames(blocks)
  const bad = []
  for (const blockText of blocks) {
    for (const m of blockText.matchAll(WORD_RE)) {
      const word = m[0]
      const offsetInBlock = m.index ?? 0
      if (!isAcceptableWord({ word, blockText, offsetInBlock, docNames }, inDict)) {
        bad.push(word)
      }
    }
  }
  return bad
}

test('clampSidebarWidth clamps and handles non-finite inputs', () => {
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH)
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_DEFAULT_WIDTH)
  assert.equal(clampSidebarWidth(100), SIDEBAR_MIN_WIDTH)
  assert.equal(clampSidebarWidth(500), SIDEBAR_MAX_WIDTH)
  assert.equal(clampSidebarWidth(248.6), 249)
})

test('resolveSidebarDrag handles smooth resizing and Zen collapse/expand hysteresis', () => {
  // Normal drag in full mode
  assert.deepEqual(resolveSidebarDrag('full', 260, 224), {
    mode: 'full',
    width: 260,
    visualWidth: 260
  })

  // Dragging below collapse threshold snaps to icons and preserves last full width
  assert.deepEqual(resolveSidebarDrag('full', SIDEBAR_COLLAPSE_THRESHOLD - 1, 260), {
    mode: 'icons',
    width: 260,
    visualWidth: SIDEBAR_ICONS_WIDTH
  })

  // Hysteresis: staying between collapse and expand threshold keeps icons mode
  assert.deepEqual(resolveSidebarDrag('icons', SIDEBAR_EXPAND_THRESHOLD - 1, 260), {
    mode: 'icons',
    width: 260,
    visualWidth: SIDEBAR_ICONS_WIDTH
  })

  // Pulling past expand threshold restores full mode with clamped width
  assert.deepEqual(resolveSidebarDrag('icons', SIDEBAR_EXPAND_THRESHOLD, 260), {
    mode: 'full',
    width: SIDEBAR_MIN_WIDTH,
    visualWidth: SIDEBAR_MIN_WIDTH
  })
  assert.deepEqual(resolveSidebarDrag('icons', 290, 260), {
    mode: 'full',
    width: 290,
    visualWidth: 290
  })

  // Hidden (floating) mode resizes width without changing mode
  assert.deepEqual(resolveSidebarDrag('hidden', 310, 224), {
    mode: 'hidden',
    width: 310,
    visualWidth: 310
  })
  assert.deepEqual(resolveSidebarDrag('hidden', 90, 224), {
    mode: 'hidden',
    width: SIDEBAR_MIN_WIDTH,
    visualWidth: SIDEBAR_MIN_WIDTH
  })
})

test('spell rules skip names, honorifics, possessives, brands, and document-learned names', () => {
  assert.equal(isAtSentenceStart('I met Dr. Chen today.', 10), false)
  assert.equal(isAtSentenceStart('Hello. World', 7), true)

  const blocks = [
    "I met Garrett and Aaliyah Kowalski with Dr. Patel at O'Connor's study class.",
    "Garrett's notes on Veyra IronLog and iPhone flashcards are great.",
    'Garrett brought pre-exam non-linear notes today.'
  ]
  assert.deepEqual(flaggedWords(blocks), [])
})

test('spell rules still catch genuine typos mid-sentence and at sentence start', () => {
  const blocks = [
    'Teh exam is tomorrow and she will recieve the package.',
    'Recieve the speling notes.'
  ]
  assert.deepEqual(flaggedWords(blocks), ['Teh', 'recieve', 'Recieve', 'speling'])
})

test('matchSuggestionCase matches original capitalization', () => {
  assert.equal(matchSuggestionCase('Recieve', 'receive'), 'Receive')
  assert.equal(matchSuggestionCase('TEH', 'the'), 'THE')
  assert.equal(matchSuggestionCase('recieve', 'receive'), 'receive')
})
