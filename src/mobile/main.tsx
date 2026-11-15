// The Android app's entry: install window.veyra first, then load the screens
// (several modules read window.veyra as soon as they load).
import { colourBars, installBridge } from './bridge'
import { ON_WEB } from '@shared/channel'
import { startWebApp } from '../renderer/src/lib/webapp'
import { goBack, startWebBack } from '../renderer/src/lib/back'
import { startPullToRefresh } from '../renderer/src/lib/pull'
import { App as Native } from '@capacitor/app'
import '../renderer/src/styles.css'
import '../renderer/src/notes.css'
import '../renderer/src/account.css'
import '../renderer/src/settings.css'
import '../renderer/src/phone.css'

function applyTheme() {
  let theme: string | null = null
  try {
    theme = localStorage.getItem('veyra.theme')
  } catch {
    /* storage unavailable */
  }
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || ((!theme || theme === 'system') && mq.matches))
  apply()
  mq.addEventListener('change', apply)
}

/**
 * A share link on the website (/s/<id>): the document itself, like a Google Doc. It uses the
 * website's account connection, so if you're signed in here you edit it with your name on
 * your cursor; signing in happens on this page and you stay on it.
 */
async function sharePage(id: string) {
  await installBridge()
  document.documentElement.classList.add('web', 'share-only')
  applyTheme()
  const [{ createElement }, { createRoot }, { PublicSharePage }] = await Promise.all([import('react'), import('react-dom/client'), import('../renderer/src/components/notes/SharePage')])
  createRoot(document.getElementById('root')!).render(createElement(PublicSharePage, { id }))
}

async function app() {
  await installBridge()
  // 'phone': the phone app's set of features (no computer-only ones); 'web': it's the website.
  document.documentElement.classList.add('phone')
  if (ON_WEB) document.documentElement.classList.add('web')
  applyTheme()
  navigator.storage?.persist?.()
  // Back steps back through Veyra before it leaves; pulling a page down reloads it.
  if (ON_WEB) startWebBack()
  else void Native.addListener('backButton', () => void (goBack() || Native.exitApp()))
  startPullToRefresh(() => location.reload())
  const [{ StrictMode, createElement }, { createRoot }, { App }] = await Promise.all([import('react'), import('react-dom/client'), import('../renderer/src/App')])
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App)))
}

/**
 * The bars around the page take its colour, light or dark: the status bar in the installed
 * website; the status bar and the navigation bar in the Android app.
 */
function followTheme() {
  if (ON_WEB) startWebApp()
  let last = ''
  const bar = () => {
    const rgb = getComputedStyle(document.body).backgroundColor
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ['243', '241', '236']).map(Number)
    const hex = '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')
    if (hex === last) return
    last = hex
    if (ON_WEB) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex)
    else void colourBars(hex, 0.2126 * r + 0.7152 * g + 0.0722 * b < 128)
  }
  // Again once a colour change has faded in.
  const soon = () => {
    requestAnimationFrame(bar)
    setTimeout(bar, 450)
  }
  new MutationObserver(soon).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  soon()
}
followTheme()
const shared = ON_WEB ? /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/.exec(location.pathname)?.[1] : undefined
await (shared ? sharePage(shared) : app())
