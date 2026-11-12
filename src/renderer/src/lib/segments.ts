/**
 * Segmented controls (.seg): the white "chosen" pill slides to the segment
 * you pick, on a spring, instead of jumping. Works for every .seg in the app
 * without changing them: it watches which button has aria-selected and moves
 * a pill drawn by CSS (.seg.has-thumb::before) using two CSS variables.
 */
export function startSegments(): () => void {
  const sized = new WeakSet<HTMLElement>()
  const resize = new ResizeObserver((entries) => entries.forEach((e) => place(e.target as HTMLElement, true)))

  function place(seg: HTMLElement, instant = false) {
    const on = seg.querySelector<HTMLElement>(':scope > [aria-selected="true"]')
    if (!on || !on.offsetWidth) {
      seg.classList.remove('has-thumb')
      return
    }
    const first = !seg.classList.contains('has-thumb')
    if (first || instant) seg.classList.add('thumb-instant')
    seg.style.setProperty('--thumb-x', `${on.offsetLeft}px`)
    seg.style.setProperty('--thumb-w', `${on.offsetWidth}px`)
    seg.classList.add('has-thumb')
    if (first || instant) requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('thumb-instant')))
    if (!sized.has(seg)) {
      sized.add(seg)
      resize.observe(seg)
    }
  }

  const all = () => document.querySelectorAll<HTMLElement>('.seg').forEach((s) => place(s))
  const watch = new MutationObserver((list) => {
    const segs = new Set<HTMLElement>()
    for (const m of list) {
      const el = (m.target.nodeType === 1 ? m.target : m.target.parentElement) as HTMLElement | null
      const seg = el?.closest<HTMLElement>('.seg')
      if (seg) segs.add(seg)
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return
        const e = n as HTMLElement
        if (e.matches('.seg')) segs.add(e)
        e.querySelectorAll?.<HTMLElement>('.seg').forEach((s) => segs.add(s))
      })
    }
    segs.forEach((s) => place(s))
  })
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] })
  all()
  // Fonts arriving change the widths.
  void document.fonts?.ready.then(all)
  return () => {
    watch.disconnect()
    resize.disconnect()
  }
}
