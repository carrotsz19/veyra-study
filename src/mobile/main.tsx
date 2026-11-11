// The Android app's entry: install window.veyra first, then load the screens
// (several modules read window.veyra as soon as they load).
import { installBridge } from './bridge'
import '../renderer/src/styles.css'
import '../renderer/src/notes.css'
import '../renderer/src/account.css'
import '../renderer/src/settings.css'
import '../renderer/src/phone.css'

installBridge()
document.documentElement.classList.add('phone')
{
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
navigator.storage?.persist?.()

const [{ StrictMode, createElement }, { createRoot }, { App }] = await Promise.all([import('react'), import('react-dom/client'), import('../renderer/src/App')])
createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(App)))
