/**
 * Selections that slide instead of jumping, on a spring:
 *  - segmented controls (.seg): the elevated pill moves to the chosen segment;
 *  - the sidebar (.side-scroll, covering both Main nav and Subjects including
 *    nested folders), settings sidebar (.set-nav nav), and phone tab bar
 *    (.phone-tabs): the highlight glides smoothly to what you pick, fading
 *    cleanly when entering or leaving a list.
 * Works for every one in the app without changing them: it watches aria-selected /
 * aria-current / aria-expanded and moves a pill drawn by CSS (::before) via CSS vars.
 * Nothing is blocked while it moves; picking again retargets the spring seamlessly,
 * and layout/resize observer ticks never abort an in-flight slide.
 */
const NAV_SEL = '.side-scroll, .set-nav nav, .phone-tabs'
const ALL_SEL = `.seg, ${NAV_SEL}`
const SLIDE_GUARD_MS = 400

function activeNavTarget(nav: HTMLElement): HTMLElement | null {
  if (nav.classList.contains('side-scroll')) {
    const cur = nav.querySelector<HTMLElement>('[aria-current="true"]')
    if (cur) {
      // If the active subject sits inside a folded folder, highlight the outermost closed folder head instead.
      let folded: HTMLElement | null = null
      let p = cur.parentElement
      while (p && p !== nav) {
        if (p.classList.contains('side-folder') && !p.classList.contains('open')) folded = p
        p = p.parentElement
      }
      if (folded) return folded.querySelector<HTMLElement>(':scope > .side-folder-head')
      return cur
    }
    return null
  }
  return nav.querySelector<HTMLElement>(':scope > [aria-current="true"]')
}

export function startSegments(): () => void {
  const sized = new WeakSet<HTMLElement>()
  const lastRect = new WeakMap<HTMLElement, string>()
  const lastTarget = new WeakMap<HTMLElement, HTMLElement>()
  const animatingUntil = new WeakMap<HTMLElement, number>()

  const resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement
      // Never snap-cancel a slide animation that is actively moving to a newly picked item.
      const inFlight = performance.now() < (animatingUntil.get(el) ?? 0)
      update(el, !inFlight)
    }
  })

  const observe = (el: HTMLElement) => {
    if (sized.has(el)) return
    sized.add(el)
    resize.observe(el)
    if (el.classList.contains('side-scroll')) {
      el.addEventListener('transitionend', (ev) => {
        if ((ev.target as HTMLElement | null)?.classList.contains('side-folder-body')) {
          update(el, true)
        }
      })
    }
  }

  /** Applies CSS vars with or without transition; synchronous reflow keeps instant snaps clean. */
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
      lastTarget.delete(seg)
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
    const switched = lastTarget.get(seg) !== on
    if (instant && !first && !switched && lastRect.get(seg) === key) return
    lastRect.set(seg, key)
    lastTarget.set(seg, on)
    if (!first && switched && !instant) animatingUntil.set(seg, performance.now() + SLIDE_GUARD_MS)

    apply(seg, 'thumb-instant', first || instant, () => {
      seg.style.setProperty('--thumb-x', `${x}px`)
      seg.style.setProperty('--thumb-y', `${y}px`)
      seg.style.setProperty('--thumb-w', `${w}px`)
      seg.style.setProperty('--thumb-h', `${h}px`)
    })
  }

  function placeNav(nav: HTMLElement, instant = false) {
    const on = activeNavTarget(nav)
    const first = !nav.classList.contains('has-pill')
    if (first) nav.classList.add('has-pill')
    observe(nav)
    if (!on || !on.offsetHeight || !on.offsetWidth) {
      // Nothing chosen here: the pill fades out cleanly in place.
      nav.classList.add('pill-off')
      lastRect.delete(nav)
      lastTarget.delete(nav)
      return
    }

    const hr = nav.getBoundingClientRect()
    const r = on.getBoundingClientRect()
    const x = Math.round(r.left - hr.left - nav.clientLeft + nav.scrollLeft)
    const y = Math.round(r.top - hr.top - nav.clientTop + nav.scrollTop)
    const w = Math.round(r.width)
    const h = Math.round(r.height)
    if (!w || !h) return

    const key = `${x}:${y}:${w}:${h}`
    const wasOff = nav.classList.contains('pill-off')
    const switched = lastTarget.get(nav) !== on
    if (instant && !first && !wasOff && !switched && lastRect.get(nav) === key) return
    lastRect.set(nav, key)
    lastTarget.set(nav, on)

    const writeCoords = () => {
      nav.style.setProperty('--pill-x', `${x}px`)
      nav.style.setProperty('--pill-w', `${w}px`)
      nav.style.setProperty('--pill-y', `${y}px`)
      nav.style.setProperty('--pill-h', `${h}px`)
    }

    if (first) {
      apply(nav, 'pill-instant', true, () => {
        writeCoords()
        nav.classList.remove('pill-off')
      })
      return
    }

    if (wasOff) {
      // Returning to this list: position at the new item first, then let opacity fade in cleanly.
      apply(nav, 'pill-instant', true, writeCoords)
      nav.classList.remove('pill-off')
      animatingUntil.set(nav, performance.now() + 200)
      return
    }

    if (switched && !instant) {
      animatingUntil.set(nav, performance.now() + SLIDE_GUARD_MS)
    }

    apply(nav, 'pill-instant', instant, () => {
      writeCoords()
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
  watch.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-current', 'aria-expanded']
  })
  all()
  // Fonts arriving change the sizes.
  void document.fonts?.ready.then(() => document.querySelectorAll<HTMLElement>(ALL_SEL).forEach((el) => update(el, true)))
  return () => {
    watch.disconnect()
    resize.disconnect()
  }
}
