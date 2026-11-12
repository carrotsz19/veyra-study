/**
 * Overlay scroll bars for the computer app. Chromium can't animate its own
 * scroll bars, so the native vertical ones are hidden and one slim bar is
 * drawn over whichever area you're scrolling or pointing at. It grows thicker
 * (animated) when you hover over it, can be dragged or clicked, and fades out
 * shortly after you stop. Phones keep their native overlay bars.
 */
const EDGE = 14 // how close to the right edge counts as "over the bar"
const MIN_THUMB = 28

export function startScrollbars(): void {
  if (!matchMedia('(pointer: fine)').matches || document.documentElement.classList.contains('phone')) return
  document.documentElement.classList.add('os-on')

  const bar = document.createElement('div')
  bar.className = 'os-bar'
  bar.setAttribute('aria-hidden', 'true')
  const thumb = document.createElement('div')
  thumb.className = 'os-thumb'
  bar.appendChild(thumb)
  document.body.appendChild(bar)

  let target: HTMLElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let frame = 0
  let drag: { y: number; top: number; ratio: number } | null = null
  let hovering = false

  const scrollable = (el: Element | null): HTMLElement | null => {
    for (let e = el as HTMLElement | null; e && e !== document.documentElement; e = e.parentElement) {
      if (e === bar || e === thumb) return target
      if (e.scrollHeight > e.clientHeight + 1) {
        const o = getComputedStyle(e).overflowY
        if (o === 'auto' || o === 'scroll') return e
      }
    }
    return null
  }

  const place = () => {
    frame = 0
    if (!target || !target.isConnected || target.scrollHeight <= target.clientHeight + 1) return hide(true)
    const r = target.getBoundingClientRect()
    const h = Math.max(0, Math.min(r.height, window.innerHeight - r.top) - 6)
    const range = target.scrollHeight - target.clientHeight
    const th = Math.max(MIN_THUMB, (h * target.clientHeight) / target.scrollHeight)
    const top = range > 0 ? (target.scrollTop / range) * (h - th) : 0
    bar.style.transform = `translate(${Math.round(r.right - EDGE)}px, ${Math.round(Math.max(0, r.top) + 3)}px)`
    bar.style.height = `${h}px`
    thumb.style.height = `${th}px`
    thumb.style.transform = `translateY(${top}px)`
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place)
  }
  const show = () => {
    bar.classList.add('on')
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => !hovering && !drag && hide(), 1100)
  }
  const hide = (now = false) => {
    bar.classList.remove('on', 'wide')
    if (now) target = null
  }
  const use = (el: HTMLElement | null) => {
    if (el && el !== target) target = el
    if (target) {
      schedule()
      show()
    }
  }

  // Scrolling anywhere shows the bar for that area.
  document.addEventListener('scroll', (e) => use(e.target instanceof HTMLElement ? e.target : null), { capture: true, passive: true })
  // Pointing: the area under the pointer; near its right edge, the bar thickens.
  document.addEventListener(
    'pointermove',
    (e) => {
      if (drag) return
      const el = scrollable(document.elementFromPoint(e.clientX, e.clientY))
      if (!el) {
        hovering = false
        bar.classList.remove('wide')
        return
      }
      const r = el.getBoundingClientRect()
      const near = e.clientX >= r.right - EDGE && e.clientX <= r.right + 1
      if (el !== target || near) use(el)
      hovering = near
      bar.classList.toggle('wide', near)
    },
    { passive: true }
  )
  window.addEventListener('resize', schedule, { passive: true })
  new ResizeObserver(schedule).observe(document.body)

  // Drag the thumb, or click the track to jump a page.
  thumb.addEventListener('pointerdown', (e) => {
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    thumb.setPointerCapture(e.pointerId)
    const h = bar.getBoundingClientRect().height
    const th = thumb.getBoundingClientRect().height
    drag = { y: e.clientY, top: target.scrollTop, ratio: (target.scrollHeight - target.clientHeight) / Math.max(1, h - th) }
    bar.classList.add('dragging', 'wide', 'on')
  })
  thumb.addEventListener('pointermove', (e) => {
    if (drag && target) target.scrollTop = drag.top + (e.clientY - drag.y) * drag.ratio
  })
  const endDrag = () => {
    if (!drag) return
    drag = null
    bar.classList.remove('dragging')
    show()
  }
  thumb.addEventListener('pointerup', endDrag)
  thumb.addEventListener('lostpointercapture', endDrag)
  bar.addEventListener('pointerdown', (e) => {
    if (!target || e.target !== bar) return
    e.preventDefault()
    const t = thumb.getBoundingClientRect()
    target.scrollBy({ top: (e.clientY < t.top ? -1 : 1) * target.clientHeight * 0.9, behavior: 'smooth' })
  })
  bar.addEventListener('pointerenter', () => {
    hovering = true
    bar.classList.add('wide', 'on')
  })
  bar.addEventListener('pointerleave', () => {
    hovering = false
    if (!drag) bar.classList.remove('wide')
    show()
  })
}
