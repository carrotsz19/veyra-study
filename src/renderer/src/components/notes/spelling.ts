import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { isWord, learnWord, loadSpelling, onSpellingChange, spellingReady, suggestions } from '../../lib/spell'

/**
 * Spelling in notes: misspelled words get a wavy red line (not the word you're
 * still typing, code, links, acronyms or anything with digits), and
 * right-clicking one offers fixes at the top of the menu (main/popup.ts asks
 * window.__veyraSpellAt for them).
 */
const key = new PluginKey<DecorationSet>('veyraSpelling')
const WORD = /[A-Za-zÀ-ÖØ-öø-ɏ]+(?:['’][A-Za-zÀ-ÖØ-öø-ɏ]+)*/g
const views = new Set<EditorView>()

function misspelled(doc: PMNode, skip: number | null): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isText) return true
    if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return false
    const text = node.text ?? ''
    for (const m of text.matchAll(WORD)) {
      const w = m[0]
      const at = m.index ?? 0
      const before = text[at - 1] ?? ''
      const after = text[at + w.length] ?? ''
      // Not acronyms, single letters, or bits of numbers, emails, paths and web addresses.
      if (w.length < 2 || w === w.toUpperCase()) continue
      if (/[0-9_@/\\]/.test(before + after) || (after === '.' && /[A-Za-z]/.test(text[at + w.length + 1] ?? ''))) continue
      const from = pos + at
      const to = from + w.length
      if (skip !== null && skip >= from && skip <= to) continue
      if (!isWord(w)) decos.push(Decoration.inline(from, to, { class: 'misspelled' }))
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** While you're typing a word, it isn't marked until you've moved on from it. */
const typingAt = (state: EditorState) => (state.selection.empty ? state.selection.from : null)

export const Spelling = Extension.create({
  name: 'veyraSpelling',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => tr.getMeta(key) ?? old.map(tr.mapping, tr.doc)
        },
        props: { decorations: (state) => key.getState(state) },
        view: (view) => {
          views.add(view)
          let timer: ReturnType<typeof setTimeout> | undefined
          const check = (wait: number) => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (!spellingReady() || view.isDestroyed) return
              view.dispatch(view.state.tr.setMeta(key, misspelled(view.state.doc, view.hasFocus() ? typingAt(view.state) : null)).setMeta('addToHistory', false))
            }, wait)
          }
          const off = onSpellingChange(() => check(0))
          void loadSpelling().then(() => check(0))
          return {
            update: (v, prev) => {
              if (!v.state.doc.eq(prev.doc)) check(400)
              else if (!v.state.selection.eq(prev.selection)) check(150)
            },
            destroy: () => {
              clearTimeout(timer)
              off()
              views.delete(view)
            }
          }
        }
      })
    ]
  }
})

/* ---------- right-click (asked by the main process) ---------- */
let target: { view: EditorView; from: number; to: number; word: string } | null = null
declare global {
  interface Window {
    __veyraSpellAt?: (x: number, y: number) => { word: string; suggestions: string[] } | null
    __veyraSpellFix?: (fix: string) => void
    __veyraSpellLearn?: () => void
  }
}
window.__veyraSpellAt = (x, y) => {
  target = null
  const el = document.elementFromPoint(x, y)
  for (const view of views) {
    if (!el || !view.dom.contains(el)) continue
    const at = view.posAtCoords({ left: x, top: y })
    if (!at) return null
    const hit = key.getState(view.state)?.find(at.pos, at.pos)[0] ?? key.getState(view.state)?.find(Math.max(0, at.pos - 1), at.pos)[0]
    if (!hit) return null
    const word = view.state.doc.textBetween(hit.from, hit.to)
    target = { view, from: hit.from, to: hit.to, word }
    return { word, suggestions: suggestions(word) }
  }
  return null
}
window.__veyraSpellFix = (fix) => {
  if (!target || target.view.isDestroyed) return
  const { view, from, to, word } = target
  // Only if the word is still there.
  if (view.state.doc.textBetween(from, to) !== word) return
  view.dispatch(view.state.tr.insertText(fix, from, to))
  view.focus()
  target = null
}
window.__veyraSpellLearn = () => {
  if (target) learnWord(target.word)
  target = null
}
