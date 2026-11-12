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
 * Screen changes: the new screen or page animates in on the live page, so it
 * can be used (and interrupted) the moment it appears.
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
let clear: ReturnType<typeof setTimeout> | undefined

/**
 * A move to another screen or page. The change happens at once, on the live
 * page (so you can tap anything straight away, and a new move simply takes
 * over); CSS animates what appears: a screen rises in (fade), a phone page
 * slides in from the right (push), or the page before slides back (pop).
 */
export function transition(update: () => void, kind: Kind = 'fade'): void {
  const root = document.documentElement
  if (reducedMotion()) {
    update()
    return
  }
  // Restart the animation even if the same kind of move is already playing.
  delete root.dataset.nav
  void root.offsetWidth
  root.dataset.nav = kind
  flushSync(update)
  clearTimeout(clear)
  clear = setTimeout(() => delete root.dataset.nav, 700)
}
