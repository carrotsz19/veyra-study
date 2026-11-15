// Pull to refresh on the phone (the Android app and the website): pull a page down from its top
// and let go to reload Veyra. Not from inside text you're editing, a sheet or a dialog, and not
// while what's under your finger is scrolled down.

const PHONE = '(max-width: 720px), (max-height: 540px) and (pointer: coarse)' // as in phone.css
const SKIP = 'input, textarea, select, [contenteditable="true"], .ProseMirror, .scrim, .sel-sheet, .phone-sheet-scrim, .phone-dock, [data-no-pull]'
const REACH = 72 // how far (after resistance) counts as "refresh"

const ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'

/** Starts listening; `refresh` runs when a pull is let go far enough. */
export function startPullToRefresh(refresh: () => void): void {
  let start: { x: number; y: number } | null = null
  let pulling = false
  let dist = 0
  let busy = false
  const ball = document.createElement('div')
  ball.className = 'ptr'
  ball.setAttribute('aria-hidden', 'true')
  ball.innerHTML = ICON
  document.body.appendChild(ball)

  const show = (d: number, animate: boolean) => {
    ball.style.transition = animate ? 'transform .25s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none'
    ball.style.transform = `translate(-50%, ${d - 48}px) rotate(${d * 4}deg)`
    ball.style.opacity = String(Math.min(1, d / REACH))
    ball.classList.toggle('ready', d >= REACH)
  }

  /** Something between the finger and the page is scrolled down: that pull scrolls it instead. */
  const scrolledAbove = (el: Element | null) => {
    for (; el && el !== document.documentElement; el = el.parentElement) if (el.scrollTop > 0) return true
    return false
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      start = null
      if (busy || e.touches.length !== 1 || !matchMedia(PHONE).matches) return
      const t = e.target as Element
      if (!t.closest?.('main.main') || t.closest(SKIP) || document.querySelector('.scrim, .sel-sheet, .phone-sheet-scrim') || scrolledAbove(t)) return
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      pulling = false
    },
    { passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return
      const dy = e.touches[0].clientY - start.y
      const dx = e.touches[0].clientX - start.x
      if (!pulling) {
        if (dy > 10 && dy > Math.abs(dx) * 1.5) pulling = true
        else if (Math.abs(dx) > 10 || dy < -4) return void (start = null)
        else return
      }
      e.preventDefault()
      dist = Math.max(0, Math.min(110, (dy - 10) * 0.5))
      show(dist, false)
    },
    { passive: false }
  )
  const end = () => {
    if (!start || !pulling) return void (start = null)
    start = null
    pulling = false
    if (dist < REACH) return show(0, true)
    busy = true
    show(REACH - 8, true)
    ball.classList.add('spinning')
    // A moment first, so a note typed in just before has saved.
    setTimeout(refresh, 700)
  }
  document.addEventListener('touchend', end)
  document.addEventListener('touchcancel', end)
}
