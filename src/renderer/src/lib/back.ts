// Back on the phone: Android's back gesture or button, or the browser's back (the website, also
// installed as an app). In order, it:
//   1. closes what's on top (a sheet, a dialog, a menu),
//   2. presses the page's own ‹ back button (an open note, a settings section, a group),
//   3. goes to the screen before (a subject's page → where it was opened from; another tab → the start screen),
// and with none of those, leaves the app.

let routeBack: { can: () => boolean; go: () => void } | null = null
/** The app's screens (App.tsx): whether there's a screen to go back to, and going there. */
export const setRouteBack = (r: { can: () => boolean; go: () => void }): void => void (routeBack = r)

const PHONE = '(max-width: 720px), (max-height: 540px) and (pointer: coarse)' // as in phone.css
const OVERLAYS = '.phone-sheet-scrim, .sel-sheet:not(.closing), .scrim'
const topOverlay = () => [...document.querySelectorAll<HTMLElement>(OVERLAYS)].pop()
const pageBack = () => [...document.querySelectorAll<HTMLElement>('main .phone-back')].filter((b) => b.offsetParent !== null).pop()
const escape = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

export const canGoBack = (): boolean => !!(topOverlay() || pageBack() || routeBack?.can())

/** One step back. False if there's nothing to go back to (then the app should close). */
export function goBack(): boolean {
  const over = topOverlay()
  if (over) {
    if (over.matches('.phone-sheet-scrim')) over.click()
    else escape(over.querySelector('[role=listbox]') ?? document.activeElement ?? document.body)
    return true
  }
  const button = pageBack()
  if (button) {
    button.click()
    return true
  }
  if (routeBack?.can()) {
    routeBack.go()
    return true
  }
  return false
}

/**
 * The website: the browser's back runs goBack. While there's somewhere to go back to, one extra
 * entry is kept in the browser's history for back to use up; with nothing left, it's taken away,
 * so the next back leaves the site (or closes the installed app) at once.
 */
export function startWebBack(): void {
  let armed = false
  let skip = false
  const sync = () => {
    const want = matchMedia(PHONE).matches && canGoBack()
    if (want && !armed) {
      history.pushState({ veyraBack: true }, '')
      armed = true
    } else if (!want && armed) {
      armed = false
      skip = true
      history.back()
    }
  }
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      sync()
    })
  }
  window.addEventListener('popstate', () => {
    if (skip) return void (skip = false)
    armed = false // back used up the extra entry
    goBack()
    schedule()
  })
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  schedule()
}
