// The Android app's entry: install window.veyra first, then load the screens
// (several modules read window.veyra as soon as they load).
import { installBridge } from './bridge'
import { ON_WEB } from '@shared/channel'
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
  const [{ StrictMode, createElement }, { createRoot }, { App }] = await Promise.all([import('react'), import('react-dom/client'), import('../renderer/src/App')])
  createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App)))
}

const shared = ON_WEB ? /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/.exec(location.pathname)?.[1] : undefined
await (shared ? sharePage(shared) : app())
