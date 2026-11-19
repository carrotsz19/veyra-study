import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { buildDeleteTr, buildMoveTr, findStepTarget } from './blockMove'

/** Feedback messages from block deletions (connected to the note toast with Undo). */
export type BlockNotice = (message: string, undo?: () => void) => void
let notice: BlockNotice = () => {}
export const onBlockNotice = (fn: BlockNotice) => {
  notice = fn
  return () => {
    if (notice === fn) notice = () => {}
  }
}
export const notifyBlock = (message: string, undo?: () => void) => notice(message, undo)

const svg15 = (body: string) =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

/** Lucide-matching icons shared across note block controls (attachments, drawings, callouts, etc.). */
export const BLK_SVG = {
  grip: svg15(
    '<circle cx="9" cy="5" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="19" r="1" fill="currentColor"/><circle cx="15" cy="5" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="19" r="1" fill="currentColor"/>'
  ),
  up: svg15('<polyline points="18 15 12 9 6 15"/>'),
  down: svg15('<polyline points="6 9 12 15 18 9"/>'),
  trash: svg15(
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'
  ),
  open: svg15('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  download: svg15(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'
  ),
  clear: svg15('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>')
}

export type PosGetter = () => number | undefined

/** Moves a block one visible sibling up (-1) or down (+1). */
export function moveBlockBy(editor: Editor, getPos: PosGetter, dir: -1 | 1): boolean {
  if (!editor.isEditable) return false
  const pos = getPos()
  if (typeof pos !== 'number') return false
  const skipHiddenPdfs = !!editor.view.dom.closest('.pdfs-collapsed')
  const target = findStepTarget(editor.state.doc, pos, dir, skipHiddenPdfs)
  if (target === null) return false
  const tr = buildMoveTr(editor.state, pos, target)
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

/** Deletes a block in a single undoable transaction and announces Undo via toast. */
export function deleteBlock(
  editor: Editor,
  getPos: PosGetter,
  label: string,
  beforeDelete?: () => void
): boolean {
  if (!editor.isEditable) return false
  const pos = getPos()
  if (typeof pos !== 'number') return false
  beforeDelete?.()
  const tr = buildDeleteTr(editor.state, pos)
  if (!tr) return false
  editor.view.dispatch(tr)
  notifyBlock(`${label} deleted`, () => {
    if (!editor.isDestroyed) editor.chain().focus().undo().run()
  })
  return true
}

interface DropSlot {
  pos: number
  y: number
  left: number
  width: number
}

function collectDropSlots(view: EditorView, fromPos: number): DropSlot[] {
  const doc = view.state.doc
  const dragged = doc.nodeAt(fromPos)
  if (!dragged) return []
  const fromEnd = fromPos + dragged.nodeSize
  const editorRect = view.dom.getBoundingClientRect()
  const slots: DropSlot[] = []

  const addContainerSlots = (parentStart: number, parent: typeof doc, left: number, width: number) => {
    const visible: { pos: number; end: number; rect: DOMRect }[] = []
    let cursor = parentStart
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i)
      const dom = view.nodeDOM(cursor)
      if (dom instanceof HTMLElement) {
        const rect = dom.getBoundingClientRect()
        if (rect.height > 0 && rect.width > 0) {
          visible.push({ pos: cursor, end: cursor + child.nodeSize, rect })
        }
      }
      cursor += child.nodeSize
    }
    if (!visible.length) return

    const push = (pos: number, y: number) => {
      if (pos >= fromPos && pos <= fromEnd) return
      const $t = doc.resolve(pos)
      if (!$t.parent.canReplaceWith($t.index(), $t.index(), dragged.type)) return
      slots.push({ pos, y, left, width })
    }

    push(visible[0].pos, visible[0].rect.top - 4)
    for (let i = 0; i < visible.length - 1; i++) {
      push(visible[i + 1].pos, (visible[i].rect.bottom + visible[i + 1].rect.top) / 2)
    }
    const last = visible[visible.length - 1]
    push(last.end, last.rect.bottom + 4)
  }

  // Always offer top-level document slots so items can move anywhere on the page.
  addContainerSlots(0, doc, editorRect.left, editorRect.width)

  // If the item is nested (e.g. inside a callout or toggle), also allow reordering among its siblings.
  const $from = doc.resolve(fromPos)
  if ($from.depth > 0) {
    const parentPos = $from.before($from.depth)
    const parentDom = view.nodeDOM(parentPos)
    const pr = parentDom instanceof HTMLElement ? parentDom.getBoundingClientRect() : editorRect
    addContainerSlots($from.start($from.depth), $from.parent, pr.left + 8, Math.max(80, pr.width - 16))
  }

  return slots
}

/**
 * Attaches smooth pointer drag-to-reorder on `handleEl` with a crisp accent drop line,
 * floating drag badge, and automatic container scrolling.
 */
export function attachBlockDrag(
  handleEl: HTMLElement,
  getBlockEl: () => HTMLElement | null,
  editor: Editor,
  getPos: PosGetter,
  getDragLabel: () => string,
  onDragState?: (dragging: boolean) => void
): () => void {
  let cleanupActive: (() => void) | null = null

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !editor.isEditable) return
    const startPos = getPos()
    if (typeof startPos !== 'number') return
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    let active = false
    let bestSlot: DropSlot | null = null
    let lastClientX = startX
    let lastClientY = startY
    let rafId = 0

    let lineEl: HTMLDivElement | null = null
    let ghostEl: HTMLDivElement | null = null
    const blockEl = getBlockEl()
    const scrollEl =
      (editor.view.dom.closest('.note-scroll, .hist-preview') as HTMLElement | null) ?? null

    const updateIndicator = () => {
      if (!active || !lineEl || !ghostEl) return
      ghostEl.style.left = `${lastClientX + 14}px`
      ghostEl.style.top = `${lastClientY + 14}px`

      const curPos = getPos()
      if (typeof curPos !== 'number') return
      const slots = collectDropSlots(editor.view, curPos)
      let nearest: DropSlot | null = null
      let bestDist = Infinity
      for (const s of slots) {
        const d = Math.abs(s.y - lastClientY)
        if (d < bestDist) {
          bestDist = d
          nearest = s
        }
      }
      bestSlot = nearest
      if (nearest) {
        lineEl.hidden = false
        lineEl.style.left = `${nearest.left}px`
        lineEl.style.top = `${nearest.y}px`
        lineEl.style.width = `${nearest.width}px`
      } else {
        lineEl.hidden = true
      }
    }

    const tickScroll = () => {
      rafId = 0
      if (!active || !scrollEl) return
      const sr = scrollEl.getBoundingClientRect()
      const zone = 56
      let delta = 0
      if (lastClientY < sr.top + zone) {
        delta = -Math.ceil(((sr.top + zone - lastClientY) / zone) * 14)
      } else if (lastClientY > sr.bottom - zone) {
        delta = Math.ceil(((lastClientY - (sr.bottom - zone)) / zone) * 14)
      }
      if (delta !== 0) {
        scrollEl.scrollTop += delta
        updateIndicator()
        rafId = requestAnimationFrame(tickScroll)
      }
    }

    const activate = () => {
      active = true
      onDragState?.(true)
      document.body.classList.add('blk-drag-active')
      blockEl?.classList.add('blk-dragging')

      lineEl = document.createElement('div')
      lineEl.className = 'blk-drop-line'
      lineEl.hidden = true
      document.body.append(lineEl)

      ghostEl = document.createElement('div')
      ghostEl.className = 'blk-drag-ghost'
      ghostEl.textContent = getDragLabel()
      document.body.append(ghostEl)
    }

    const teardown = (commit: boolean) => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
      cleanupActive = null

      if (active) {
        document.body.classList.remove('blk-drag-active')
        blockEl?.classList.remove('blk-dragging')
        lineEl?.remove()
        ghostEl?.remove()
        onDragState?.(false)
      }

      if (commit && active && bestSlot) {
        const curPos = getPos()
        if (typeof curPos === 'number' && editor.isEditable) {
          const tr = buildMoveTr(editor.state, curPos, bestSlot.pos)
          if (tr) editor.view.dispatch(tr)
        }
      }
    }

    const onMove = (ev: PointerEvent) => {
      lastClientX = ev.clientX
      lastClientY = ev.clientY
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4) {
        activate()
      }
      if (active) {
        updateIndicator()
        if (!rafId && scrollEl) rafId = requestAnimationFrame(tickScroll)
      }
    }

    const onUp = () => teardown(true)
    const onCancel = () => teardown(false)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        teardown(false)
      }
    }

    cleanupActive = () => teardown(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
  }

  handleEl.addEventListener('pointerdown', onPointerDown)
  return () => {
    handleEl.removeEventListener('pointerdown', onPointerDown)
    cleanupActive?.()
  }
}

/** Creates a crisp block action icon button (prevents ProseMirror focus stealing). */
export function createActionBtn(
  className: string,
  label: string,
  svg: string,
  onClick: () => void
): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `blk-btn ${className}`
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = svg
  b.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return b
}

/** Creates a drag grip button wired to pointer drag-to-reorder. */
export function createDragHandle(
  editor: Editor,
  getPos: PosGetter,
  blockEl: HTMLElement,
  dragLabel: string
): { el: HTMLButtonElement; destroy: () => void } {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'blk-btn blk-drag'
  el.title = 'Drag to move'
  el.setAttribute('aria-label', 'Drag to move')
  el.innerHTML = BLK_SVG.grip
  const destroy = attachBlockDrag(el, () => blockEl, editor, getPos, () => dragLabel)
  return { el, destroy }
}

/** Creates a compact [↑] [↓] [Delete] action cluster for an embedded block. */
export function createMoveDeleteControls({
  editor,
  getPos,
  label,
  onBeforeDelete
}: {
  editor: Editor
  getPos: PosGetter
  label: string
  onBeforeDelete?: () => void
}): HTMLSpanElement {
  const wrap = document.createElement('span')
  wrap.className = 'blk-controls'
  wrap.append(
    createActionBtn('blk-up', 'Move up', BLK_SVG.up, () => void moveBlockBy(editor, getPos, -1)),
    createActionBtn('blk-down', 'Move down', BLK_SVG.down, () => void moveBlockBy(editor, getPos, 1)),
    createActionBtn('blk-del', `Delete ${label.toLowerCase()}`, BLK_SVG.trash, () =>
      void deleteBlock(editor, getPos, label, onBeforeDelete)
    )
  )
  return wrap
}

/* ---------- Hover / focus controls for other structured blocks ---------- */
const STRUCTURED_NODES = new Set(['callout', 'details', 'table', 'codeBlock', 'horizontalRule'])
const STRUCTURED_SELECTOR = "div[data-callout], div[data-type='details'], .tableWrapper, pre, hr"
const STRUCTURED_LABELS: Record<string, string> = {
  callout: 'Callout',
  details: 'Toggle',
  table: 'Table',
  codeBlock: 'Code block',
  horizontalRule: 'Divider'
}

function findStructuredAtDom(
  view: EditorView,
  el: HTMLElement
): { pos: number; name: string } | null {
  let hit: { pos: number; name: string } | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (!STRUCTURED_NODES.has(node.type.name)) return true
    const dom = view.nodeDOM(pos)
    if (dom === el || (el.classList.contains('tableWrapper') && el.firstElementChild === dom)) {
      hit = { pos, name: node.type.name }
      return false
    }
    return true
  })
  return hit
}

/**
 * Adds a sleek floating Move / Drag / Delete pill on hover for structured note blocks
 * that don't have their own custom toolbar (callouts, toggles, tables, code blocks, dividers).
 * Attachments and drawings already render permanent built-in controls.
 */
export const BlockItemControls = Extension.create({
  name: 'blockItemControls',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('blockItemControls'),
        view: (view) => {
          const pill = document.createElement('div')
          pill.className = 'blk-overlay'
          pill.hidden = true

          let activeEl: HTMLElement | null = null
          let activeName = ''
          let dragging = false
          let hideTimer: ReturnType<typeof setTimeout> | null = null

          const getActivePos: PosGetter = () => {
            if (!activeEl || !activeEl.isConnected) return undefined
            return findStructuredAtDom(view, activeEl)?.pos
          }

          const dragBtn = document.createElement('button')
          dragBtn.type = 'button'
          dragBtn.className = 'blk-btn blk-drag'
          dragBtn.title = 'Drag to move'
          dragBtn.setAttribute('aria-label', 'Drag to move')
          dragBtn.innerHTML = BLK_SVG.grip

          const upBtn = createActionBtn('blk-up', 'Move up', BLK_SVG.up, () => {
            if (moveBlockBy(editor, getActivePos, -1)) hide(true)
          })
          const downBtn = createActionBtn('blk-down', 'Move down', BLK_SVG.down, () => {
            if (moveBlockBy(editor, getActivePos, 1)) hide(true)
          })
          const delBtn = createActionBtn('blk-del', 'Delete block', BLK_SVG.trash, () => {
            const label = STRUCTURED_LABELS[activeName] ?? 'Block'
            if (deleteBlock(editor, getActivePos, label)) hide(true)
          })

          pill.append(dragBtn, upBtn, downBtn, delBtn)
          document.body.append(pill)

          const destroyDrag = attachBlockDrag(
            dragBtn,
            () => activeEl,
            editor,
            getActivePos,
            () => STRUCTURED_LABELS[activeName] ?? 'Block',
            (on) => {
              dragging = on
              if (on) pill.hidden = true
              else hide(true)
            }
          )

          const clearHide = () => {
            if (hideTimer) {
              clearTimeout(hideTimer)
              hideTimer = null
            }
          }

          const hide = (immediate = false) => {
            clearHide()
            if (immediate) {
              activeEl = null
              activeName = ''
              pill.hidden = true
              return
            }
            hideTimer = setTimeout(() => {
              if (!dragging) {
                activeEl = null
                activeName = ''
                pill.hidden = true
              }
            }, 160)
          }

          const place = () => {
            if (!activeEl || !activeEl.isConnected || !editor.isEditable || dragging) {
              pill.hidden = true
              return
            }
            const rect = activeEl.getBoundingClientRect()
            if (rect.height <= 0 || rect.width <= 0) {
              pill.hidden = true
              return
            }
            const scrollEl = view.dom.closest('.note-scroll, .hist-preview')
            if (scrollEl) {
              const sr = scrollEl.getBoundingClientRect()
              if (rect.bottom < sr.top || rect.top > sr.bottom) {
                pill.hidden = true
                return
              }
            }
            pill.hidden = false
            const pw = pill.offsetWidth || 112
            const ph = pill.offsetHeight || 28
            const left = Math.max(8, Math.min(window.innerWidth - pw - 8, rect.right - pw - 6))
            const top =
              activeName === 'horizontalRule'
                ? rect.top + rect.height / 2 - ph / 2
                : Math.max(8, rect.top + 6)
            pill.style.left = `${Math.round(left)}px`
            pill.style.top = `${Math.round(top)}px`
          }

          const showFor = (el: HTMLElement) => {
            if (!editor.isEditable || dragging) return
            const found = findStructuredAtDom(view, el)
            if (!found) return
            clearHide()
            activeEl = el
            activeName = found.name
            const label = STRUCTURED_LABELS[found.name] ?? 'Block'
            delBtn.title = `Delete ${label.toLowerCase()}`
            delBtn.setAttribute('aria-label', `Delete ${label.toLowerCase()}`)
            place()
          }

          const onPointerMove = (e: PointerEvent) => {
            if (!editor.isEditable || dragging) return
            const target = e.target as HTMLElement | null
            if (!target) return
            // Attachments and drawings have their own permanent built-in controls.
            if (target.closest('.att, .drw')) {
              if (!pill.hidden) hide()
              return
            }
            const block = target.closest(STRUCTURED_SELECTOR) as HTMLElement | null
            if (block && view.dom.contains(block)) {
              if (block !== activeEl || pill.hidden) showFor(block)
            } else if (!pill.hidden) {
              hide()
            }
          }

          const onDomLeave = (e: MouseEvent) => {
            const rel = e.relatedTarget as Node | null
            if (rel && pill.contains(rel)) return
            hide()
          }

          const onPillEnter = () => clearHide()
          const onPillLeave = (e: MouseEvent) => {
            const rel = e.relatedTarget as HTMLElement | null
            if (rel && activeEl && activeEl.contains(rel)) return
            hide()
          }

          const onScrollOrResize = () => {
            if (!pill.hidden) place()
          }

          const scrollEl = view.dom.closest('.note-scroll, .hist-preview')
          view.dom.addEventListener('pointermove', onPointerMove)
          view.dom.addEventListener('mouseleave', onDomLeave)
          pill.addEventListener('mouseenter', onPillEnter)
          pill.addEventListener('mouseleave', onPillLeave)
          scrollEl?.addEventListener('scroll', onScrollOrResize, { passive: true })
          window.addEventListener('resize', onScrollOrResize)

          return {
            update: () => {
              if (!editor.isEditable) hide(true)
              else if (!pill.hidden) place()
            },
            destroy: () => {
              clearHide()
              destroyDrag()
              view.dom.removeEventListener('pointermove', onPointerMove)
              view.dom.removeEventListener('mouseleave', onDomLeave)
              pill.removeEventListener('mouseenter', onPillEnter)
              pill.removeEventListener('mouseleave', onPillLeave)
              scrollEl?.removeEventListener('scroll', onScrollOrResize)
              window.removeEventListener('resize', onScrollOrResize)
              pill.remove()
            }
          }
        }
      })
    ]
  }
})
