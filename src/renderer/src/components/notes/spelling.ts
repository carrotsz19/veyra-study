import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { ignoreWord, isWord, learnWord, loadSpelling, onSpellingChange, spellingReady, suggestions } from '../../lib/spell'
import { WORD_RE, collectDocumentNames, isAcceptableWord } from '../../lib/spell-rules'

/**
 * Spelling in notes:
 * - Misspelled words get a soft wavy red underline (names, brands, code, links,
 *   acronyms, possessives, and hyphenated prefixes aren't nagged).
 * - Clicking or moving the cursor onto a red-underlined word keeps the underline
 *   visible and opens an inline suggestions popover right by the word.
 * - Right-clicking a misspelled word also offers fixes in the context menu
 *   (main/popup.ts asks window.__veyraSpellAt for them).
 */
const key = new PluginKey<DecorationSet>('veyraSpelling')
const views = new Set<EditorView>()

function misspelled(doc: PMNode, skipPos: number | null): DecorationSet {
  const blocks: { node: PMNode; pos: number; text: string }[] = []
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (node.isTextblock) {
      blocks.push({ node, pos, text: node.textContent })
      return false
    }
    return true
  })

  const docNames = collectDocumentNames(blocks.map((b) => b.text))
  const decos: Decoration[] = []

  for (const block of blocks) {
    let blockOffset = 0
    block.node.forEach((child, childOffset) => {
      const len = child.isText ? (child.text?.length ?? 0) : child.textContent.length
      if (child.isText && !child.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) {
        const text = child.text ?? ''
        const textNodePos = block.pos + 1 + childOffset
        for (const m of text.matchAll(WORD_RE)) {
          const w = m[0]
          const at = m.index ?? 0
          const from = textNodePos + at
          const to = from + w.length
          // Only suppress the word currently being typed, never on click/navigation.
          if (skipPos !== null && skipPos >= from && skipPos <= to) continue
          if (
            !isAcceptableWord(
              { word: w, blockText: block.text, offsetInBlock: blockOffset + at, docNames },
              isWord
            )
          ) {
            decos.push(Decoration.inline(from, to, { class: 'misspelled' }))
          }
        }
      }
      blockOffset += len
    })
  }

  return DecorationSet.create(doc, decos)
}

function findMisspelledAt(state: EditorState, pos: number): { from: number; to: number; word: string } | null {
  const set = key.getState(state)
  if (!set) return null
  const hit =
    set.find(pos, pos)[0] ??
    (pos > 0 ? set.find(pos - 1, pos)[0] : undefined)
  if (!hit || hit.from >= hit.to) return null
  const word = state.doc.textBetween(hit.from, hit.to)
  if (!word.trim()) return null
  return { from: hit.from, to: hit.to, word }
}

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
          let typingSkip: number | null = null
          let dismissedKey = ''
          let activeHit: { from: number; to: number; word: string } | null = null

          // Inline suggestions popover anchored directly to the red-underlined word.
          const pop = document.createElement('div')
          pop.className = 'spell-pop'
          pop.setAttribute('role', 'listbox')
          pop.setAttribute('aria-label', 'Spelling suggestions')
          pop.hidden = true
          // Keep editor focus intact when clicking a suggestion.
          pop.addEventListener('mousedown', (e) => e.preventDefault())
          document.body.append(pop)

          const hidePop = () => {
            activeHit = null
            pop.hidden = true
          }

          const placePop = (from: number, to: number) => {
            if (view.isDestroyed) return hidePop()
            try {
              const a = view.coordsAtPos(from)
              const b = view.coordsAtPos(to)
              const scrollEl = view.dom.closest('.note-scroll, .hist-preview')
              if (scrollEl) {
                const sr = scrollEl.getBoundingClientRect()
                if (a.bottom < sr.top || a.top > sr.bottom) return hidePop()
              }
              pop.hidden = false
              const pw = pop.offsetWidth || 190
              const ph = pop.offsetHeight || 120
              const left = Math.max(8, Math.min(window.innerWidth - pw - 8, a.left))
              const below = Math.max(a.bottom, b.bottom) + 6
              const above = Math.min(a.top, b.top) - ph - 6
              const top = below + ph <= window.innerHeight - 8 ? below : Math.max(8, above)
              pop.style.left = `${Math.round(left)}px`
              pop.style.top = `${Math.round(top)}px`
            } catch {
              hidePop()
            }
          }

          const openPop = (hit: { from: number; to: number; word: string }) => {
            const hitKey = `${hit.from}:${hit.to}:${hit.word}`
            if (dismissedKey === hitKey) return
            if (activeHit && `${activeHit.from}:${activeHit.to}:${activeHit.word}` === hitKey && !pop.hidden) {
              placePop(hit.from, hit.to)
              return
            }
            activeHit = hit
            const fixes = suggestions(hit.word)
            pop.textContent = ''

            if (fixes.length) {
              for (const fix of fixes) {
                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'spell-item'
                btn.textContent = fix
                btn.addEventListener('click', () => {
                  if (view.isDestroyed || !view.editable) return
                  const cur = view.state.doc.textBetween(hit.from, hit.to)
                  if (cur === hit.word) {
                    view.dispatch(view.state.tr.insertText(fix, hit.from, hit.to))
                    view.focus()
                  }
                  hidePop()
                })
                pop.append(btn)
              }
            } else {
              const empty = document.createElement('div')
              empty.className = 'spell-empty'
              empty.textContent = 'No suggestions'
              pop.append(empty)
            }

            const sep = document.createElement('div')
            sep.className = 'spell-sep'
            pop.append(sep)

            const actions = document.createElement('div')
            actions.className = 'spell-actions'

            const addBtn = document.createElement('button')
            addBtn.type = 'button'
            addBtn.className = 'spell-act'
            addBtn.textContent = 'Add to dictionary'
            addBtn.addEventListener('click', () => {
              learnWord(hit.word)
              hidePop()
              view.focus()
            })

            const ignBtn = document.createElement('button')
            ignBtn.type = 'button'
            ignBtn.className = 'spell-act'
            ignBtn.textContent = 'Ignore'
            ignBtn.addEventListener('click', () => {
              ignoreWord(hit.word)
              hidePop()
              view.focus()
            })

            actions.append(addBtn, ignBtn)
            pop.append(actions)
            placePop(hit.from, hit.to)
          }

          const syncPopover = () => {
            if (view.isDestroyed || !view.editable || !view.hasFocus() || !view.state.selection.empty) {
              hidePop()
              return
            }
            // Don't pop up over the word while actively typing it.
            if (typingSkip !== null) {
              hidePop()
              return
            }
            const hit = findMisspelledAt(view.state, view.state.selection.from)
            if (!hit) {
              dismissedKey = ''
              hidePop()
              return
            }
            openPop(hit)
          }

          const check = (wait: number, skip: number | null) => {
            clearTimeout(timer)
            timer = setTimeout(() => {
              if (!spellingReady() || view.isDestroyed) return
              view.dispatch(
                view.state.tr
                  .setMeta(key, misspelled(view.state.doc, skip))
                  .setMeta('addToHistory', false)
              )
            }, Math.max(0, wait))
          }

          const off = onSpellingChange(() => {
            typingSkip = null
            check(0, null)
          })
          void loadSpelling().then(() => check(0, null))

          const onDomMouseUp = (e: MouseEvent) => {
            if (e.button !== 0) return
            // Clicking a red-underlined word explicitly re-opens suggestions even if Esc dismissed it earlier.
            if ((e.target as HTMLElement | null)?.closest?.('.misspelled')) {
              dismissedKey = ''
              typingSkip = null
              requestAnimationFrame(syncPopover)
            }
          }
          const onContextMenu = () => hidePop()
          const onBlur = () => {
            if (typingSkip !== null) {
              typingSkip = null
              check(0, null)
            }
            hidePop()
          }
          const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !pop.hidden && activeHit) {
              dismissedKey = `${activeHit.from}:${activeHit.to}:${activeHit.word}`
              hidePop()
              e.stopPropagation()
            }
          }
          const onDocMouseDown = (e: MouseEvent) => {
            if (pop.hidden) return
            const t = e.target as Node | null
            if (t && (pop.contains(t) || view.dom.contains(t))) return
            hidePop()
          }
          const onScrollOrResize = () => {
            if (!pop.hidden && activeHit) placePop(activeHit.from, activeHit.to)
          }

          const scrollEl = view.dom.closest('.note-scroll, .hist-preview')
          view.dom.addEventListener('mouseup', onDomMouseUp)
          view.dom.addEventListener('contextmenu', onContextMenu)
          view.dom.addEventListener('blur', onBlur)
          window.addEventListener('keydown', onKeyDown, true)
          document.addEventListener('mousedown', onDocMouseDown)
          scrollEl?.addEventListener('scroll', onScrollOrResize, { passive: true })
          window.addEventListener('resize', onScrollOrResize)

          return {
            update: (v, prev) => {
              const docChanged = !v.state.doc.eq(prev.doc)
              const selChanged = !v.state.selection.eq(prev.selection)
              if (docChanged) {
                // Suppress underlining only the word actively being edited, never on click.
                dismissedKey = ''
                typingSkip = v.hasFocus() && v.state.selection.empty ? v.state.selection.from : null
                hidePop()
                check(380, typingSkip)
                return
              }
              if (selChanged) {
                const hadTypingSkip = typingSkip !== null
                typingSkip = null
                // If the user just moved away from a word they were typing, check it now without skipping the new cursor spot.
                if (hadTypingSkip) check(0, null)
                syncPopover()
                return
              }
              // Spelling decorations just finished updating: sync the popover if cursor sits on a misspelled word.
              if (key.getState(v.state) !== key.getState(prev)) {
                syncPopover()
              }
            },
            destroy: () => {
              clearTimeout(timer)
              off()
              views.delete(view)
              view.dom.removeEventListener('mouseup', onDomMouseUp)
              view.dom.removeEventListener('contextmenu', onContextMenu)
              view.dom.removeEventListener('blur', onBlur)
              window.removeEventListener('keydown', onKeyDown, true)
              document.removeEventListener('mousedown', onDocMouseDown)
              scrollEl?.removeEventListener('scroll', onScrollOrResize)
              window.removeEventListener('resize', onScrollOrResize)
              pop.remove()
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
    const hit = findMisspelledAt(view.state, at.pos)
    if (!hit) return null
    target = { view, from: hit.from, to: hit.to, word: hit.word }
    return { word: hit.word, suggestions: suggestions(hit.word) }
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
