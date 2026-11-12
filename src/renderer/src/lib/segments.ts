/**
 * Selections that slide instead of jumping, on a spring:
 *  - segmented controls (.seg): the white pill moves to the chosen segment;
 *  - the sidebar (.side nav) and the phone tab bar (.phone-tabs): the highlight moves to what you pick,
 *    fading out of one list and into the other when you cross between them.
 * Works for every one in the app without changing them: it watches aria-selected /
 * aria-current and moves a pill drawn by CSS (::before), through CSS variables.
 * Nothing is blocked while it moves; picking again just sends it somewhere new.
 */
export function startSegments(): () => void {
  const sized = new WeakSet<HTMLElement>()
  const resize = new ResizeObserver((entries) => entries.forEach((e) => update(e.target as HTMLElement, true)))
  const observe = (el: HTMLElement) => {
    if (sized.has(el)) return
    sized.add(el)
    resize.observe(el)
  }
  // The first placement (and resizes) jump straight there; picks after that slide.
  const instantly = (el: HTMLElement, cls: string) => {
    el.classList.add(cls)
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove(cls)))
  }

  function placeSeg(seg: HTMLElement, instant = false) {
    const on = seg.querySelector<HTMLElement>(':scope > [aria-selected="true"]')
    if (!on || !on.offsetWidth) {
      seg.classList.remove('has-thumb')
      return
    }
    if (!seg.classList.contains('has-thumb') || instant) instantly(seg, 'thumb-instant')
    seg.style.setProperty('--thumb-x', `${on.offsetLeft}px`)
    seg.style.setProperty('--thumb-w', `${on.offsetWidth}px`)
    seg.classList.add('has-thumb')
    observe(seg)
  }

  function placeNav(nav: HTMLElement, instant = false) {
    const on = nav.querySelector<HTMLElement>(':scope > [aria-current="true"]')
    const first = !nav.classList.contains('has-pill')
    nav.classList.add('has-pill')
    observe(nav)
    if (!on || !on.offsetHeight) {
      // Nothing chosen here: the pill fades where it is.
      nav.classList.add('pill-off')
      return
    }
    // Coming back into this list, or the first time: appear in place rather than sliding from a stale spot.
    if (first || instant || nav.classList.contains('pill-off')) instantly(nav, 'pill-instant')
    nav.style.setProperty('--pill-x', `${on.offsetLeft}px`)
    nav.style.setProperty('--pill-w', `${on.offsetWidth}px`)
    nav.style.setProperty('--pill-y', `${on.offsetTop}px`)
    nav.style.setProperty('--pill-h', `${on.offsetHeight}px`)
    nav.classList.remove('pill-off')
  }

  function update(el: HTMLElement, instant = false) {
    if (el.matches('.seg')) placeSeg(el, instant)
    else if (el.matches('.side nav, .phone-tabs')) placeNav(el, instant)
  }

  const all = () => document.querySelectorAll<HTMLElement>('.seg, .side nav, .phone-tabs').forEach((el) => update(el))
  const watch = new MutationObserver((list) => {
    const found = new Set<HTMLElement>()
    for (const m of list) {
      const el = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as HTMLElement | null
      const host = el?.closest<HTMLElement>('.seg, .side nav, .phone-tabs')
      if (host) found.add(host)
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return
        const e = n as HTMLElement
        if (e.matches('.seg, .side nav, .phone-tabs')) found.add(e)
        e.querySelectorAll?.<HTMLElement>('.seg, .side nav, .phone-tabs').forEach((s) => found.add(s))
      })
    }
    found.forEach((el) => update(el))
  })
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current'] })
  all()
  // Fonts arriving change the sizes.
  void document.fonts?.ready.then(all)
  return () => {
    watch.disconnect()
    resize.disconnect()
  }
}
