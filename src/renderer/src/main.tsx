import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './notes.css'
import './account.css'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
