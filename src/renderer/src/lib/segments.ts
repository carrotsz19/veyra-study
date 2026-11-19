/**
 * Selections that slide instead of jumping, on a spring:
 *  - segmented controls (.seg): the elevated pill moves to the chosen segment;
 *  - the sidebar (.side nav), settings sidebar (.set-nav nav), and phone tab bar
 *    (.phone-tabs): the highlight moves to what you pick, fading out of one list
 *    and into the other when you cross between them.
 * Works for every one in the app without changing them: it watches aria-selected /
 * aria-current and moves a pill drawn by CSS (::before), through CSS variables.
 * Nothing is blocked while it moves; picking again just sends it somewhere new.
 */
const NAV_SEL = '.side nav, .set-nav nav, .phone-tabs'
const ALL_SEL = `.seg, ${NAV_SEL}`

export function startSegments(): () => void {
  const sized = new WeakSet<HTMLElement>()
  const lastRect = new WeakMap<HTMLElement, string>()
  const resize = new ResizeObserver((entries) => entries.forEach((e) => update(e.target as HTMLElement, true)))
  const observe = (el: HTMLElement) => {
    if (sized.has(el)) return
    sized.add(el)
    resize.observe(el)
  }

  /** Applies CSS vars without animating, then synchronously flushes layout so the next real pick always slides. */
  const apply = (el: HTMLElement, cls: string, instant: boolean, write: () => void) => {
    if (instant) {
      el.classList.add(cls)
      write()
      void el.offsetWidth
      el.classList.remove(cls)
    } else {
      if (el.classList.contains(cls)) {
        el.classList.remove(cls)
        void el.offsetWidth
      }
      write()
    }
  }

  function placeSeg(seg: HTMLElement, instant = false) {
    const on = seg.querySelector<HTMLElement>(':scope > [aria-selected="true"]')
    if (!on || !on.offsetWidth) {
      seg.classList.remove('has-thumb')
      lastRect.delete(seg)
      return
    }
    const first = !seg.classList.contains('has-thumb')
    // Ensure position: relative is active BEFORE measuring offsetLeft/offsetTop.
    if (first) seg.classList.add('has-thumb')
    observe(seg)

    const x = on.offsetLeft
    const y = on.offsetTop
    const w = on.offsetWidth
    const h = on.offsetHeight
    const key = `${x}:${y}:${w}:${h}`
    if (instant && !first && lastRect.get(seg) === key) return
    lastRect.set(seg, key)

    apply(seg, 'thumb-instant', first || instant, () => {
      seg.style.setProperty('--thumb-x', `${x}px`)
      seg.style.setProperty('--thumb-y', `${y}px`)
      seg.style.setProperty('--thumb-w', `${w}px`)
      seg.style.setProperty('--thumb-h', `${h}px`)
    })
  }

  function placeNav(nav: HTMLElement, instant = false) {
    const on = nav.querySelector<HTMLElement>(':scope > [aria-current="true"]')
    const first = !nav.classList.contains('has-pill')
    if (first) nav.classList.add('has-pill')
    observe(nav)
    if (!on || !on.offsetHeight) {
      // Nothing chosen here: the pill fades where it is.
      nav.classList.add('pill-off')
      lastRect.delete(nav)
      return
    }

    const x = on.offsetLeft
    const y = on.offsetTop
    const w = on.offsetWidth
    const h = on.offsetHeight
    const key = `${x}:${y}:${w}:${h}`
    const wasOff = nav.classList.contains('pill-off')
    if (instant && !first && !wasOff && lastRect.get(nav) === key) return
    lastRect.set(nav, key)

    // Coming back into this list, or the first time: appear in place rather than sliding from a stale spot.
    apply(nav, 'pill-instant', first || instant || wasOff, () => {
      nav.style.setProperty('--pill-x', `${x}px`)
      nav.style.setProperty('--pill-w', `${w}px`)
      nav.style.setProperty('--pill-y', `${y}px`)
      nav.style.setProperty('--pill-h', `${h}px`)
      nav.classList.remove('pill-off')
    })
  }

  function update(el: HTMLElement, instant = false) {
    if (el.matches('.seg')) placeSeg(el, instant)
    else if (el.matches(NAV_SEL)) placeNav(el, instant)
  }

  const all = () => document.querySelectorAll<HTMLElement>(ALL_SEL).forEach((el) => update(el))
  const watch = new MutationObserver((list) => {
    const found = new Set<HTMLElement>()
    for (const m of list) {
      const el = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as HTMLElement | null
      const host = el?.closest<HTMLElement>(ALL_SEL)
      if (host) found.add(host)
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return
        const e = n as HTMLElement
        if (e.matches(ALL_SEL)) found.add(e)
        e.querySelectorAll?.<HTMLElement>(ALL_SEL).forEach((s) => found.add(s))
      })
    }
    found.forEach((el) => update(el))
  })
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current'] })
  all()
  // Fonts arriving change the sizes.
  void document.fonts?.ready.then(() => document.querySelectorAll<HTMLElement>(ALL_SEL).forEach((el) => update(el, true)))
  return () => {
    watch.disconnect()
    resize.disconnect()
  }
}
