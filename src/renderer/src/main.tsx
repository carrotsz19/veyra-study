import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './notes.css'
import './account.css'
import './settings.css'
import './phone.css'
import { startScrollbars } from './lib/scrollbars'
import { APP_NAME } from '@shared/channel'

// The name in the taskbar and Alt+Tab: Veyra Study, or Veyra Study Dev for a test build.
document.title = APP_NAME

// Full screen: Veyra's own acrylic (the blurred wallpaper), since Windows' flickers there.
window.veyra?.app?.onBackdrop?.((url) => {
  const root = document.documentElement
  root.classList.toggle('fs-glass', !!url)
  if (url) root.style.setProperty('--fs-wall', `url("${url}")`)
  else root.style.removeProperty('--fs-wall')
})

// Apply the saved theme before anything renders (the sign-in screen has no sidebar).
{
  let theme: string | null = new URLSearchParams(location.search).get('theme')
  try {
    theme = theme || localStorage.getItem('veyra.theme')
  } catch {
    /* storage unavailable */
  }
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || ((!theme || theme === 'system') && mq.matches))
  apply()
  mq.addEventListener('change', () => {
    try {
      theme = localStorage.getItem('veyra.theme') || theme
    } catch {
      /* ignore */
    }
    apply()
  })
}

// The title bar's acrylic menu window shows just a menu; everything else is the app.
if (location.hash === '#menu') {
  void import('./components/MenuWindow').then(({ MenuWindow }) => createRoot(document.getElementById('root')!).render(<MenuWindow />))
} else {
  startScrollbars()
  void import('./App').then(({ App }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  )
}
