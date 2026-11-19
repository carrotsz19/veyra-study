import { Component, StrictMode, type ReactNode } from 'react'
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

/**
 * A screen that throws while drawing must never take the whole window with it: without this, React
 * unmounts everything and the see-through (acrylic) window is left empty. Shows a solid panel instead.
 */
class Crashed extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    console.error('Veyra hit an error while drawing', error)
  }
  render() {
    if (!this.state.error) return this.props.children
    const dark = document.documentElement.classList.contains('dark')
    return (
      <div role="alert" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: dark ? '#15140f' : '#f7f7f5', color: dark ? '#eee' : '#222', font: '14px system-ui, sans-serif', WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div style={{ textAlign: 'center', maxWidth: 420, padding: 24, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong</h2>
          <p style={{ margin: '0 0 16px', opacity: 0.75 }}>Veyra hit a problem drawing this screen. Reload to carry on.</p>
          <button className="btn" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    )
  }
}

// The title bar's acrylic menu window shows just a menu; everything else is the app.
if (location.hash === '#menu') {
  void import('./components/MenuWindow').then(({ MenuWindow }) => createRoot(document.getElementById('root')!).render(<MenuWindow />))
} else {
  startScrollbars()
  void import('./App').then(({ App }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Crashed>
          <App />
        </Crashed>
      </StrictMode>
    )
  )
}
