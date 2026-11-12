import { useLayoutEffect, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * Motion helpers.
 *
 * Leaving: dialogs, sheets and the palette are closed in many ways (Cancel,
 * Save, Esc, clicking outside, a parent going away). Rather than wiring an
 * exit into each, the element leaves a copy of itself behind for a moment,
 * which plays its exit (the "leaving" class) and is then removed.
 *
 * Screen changes: the browser's view transitions crossfade one screen into
 * the next, or push and pop like iOS when a note opens on the phone.
 */

export const reducedMotion = (): boolean =>
  document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches

function ghost(el: HTMLElement, ms: number) {
  if (!el.isConnected || reducedMotion()) return
  const copy = el.cloneNode(true) as HTMLElement
  // What you'd typed stays visible while it fades.
  const from = el.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((c, i) => {
    const o = from[i]
    if (!o) return
    if (c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio')) c.checked = (o as HTMLInputElement).checked
    else c.value = o.value
  })
  copy.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'))
  copy.removeAttribute('id')
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  copy.classList.add('leaving')
  document.body.appendChild(copy)
  setTimeout(() => copy.remove(), ms)
}

/** Plays the element's exit (CSS: `.leaving`) when it unmounts, however it was closed. */
export function useExit(ref: RefObject<HTMLElement | null>, ms = 240): void {
  useLayoutEffect(() => {
    const el = ref.current
    return () => {
      if (el) ghost(el, ms)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

type Kind = 'fade' | 'push' | 'pop'
const canTransition = typeof document !== 'undefined' && 'startViewTransition' in document
if (canTransition) document.documentElement.classList.add('vt')

/** Runs a state change as an animated transition between the old and new screen. */
export function transition(update: () => void, kind: Kind = 'fade'): void {
  if (!canTransition || reducedMotion() || document.visibilityState !== 'visible') {
    update()
    return
  }
  const root = document.documentElement
  root.dataset.vt = kind
  try {
    const t = (document as Document & { startViewTransition: (cb: () => void) => { finished: Promise<void> } }).startViewTransition(() => flushSync(update))
    t.finished.finally(() => {
      if (root.dataset.vt === kind) delete root.dataset.vt
    })
  } catch {
    delete root.dataset.vt
    update()
  }
}
