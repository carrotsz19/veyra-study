// The website installed as an app (its own window and icon, opening without a connection).
// The manifest and service worker are made by the website build (mobile/vite.config.ts).
import { useEffect, useState } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let prompt: InstallPrompt | null = null
let installed = false
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

/** Called once when the website starts: the service worker, and the browser's offer to install. */
export function startWebApp(): void {
  // (Running the code with Vite there's no /sw.js, so this just fails quietly.)
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {})
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // Veyra offers it in Settings instead of a banner over the app
    prompt = e as InstallPrompt
    changed()
  })
  window.addEventListener('appinstalled', () => {
    prompt = null
    installed = true
    changed()
  })
}

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)

/**
 * - app: running as the installed app
 * - installed: just installed from this tab
 * - ready: the browser can install it (install() shows its dialog)
 * - ios: Safari on iPhone/iPad, installed from the Share menu
 * - manual: the browser has its own way (or none), see its menu
 */
export type WebAppState = 'app' | 'installed' | 'ready' | 'ios' | 'manual'
const state = (): WebAppState => (standalone() ? 'app' : installed ? 'installed' : prompt ? 'ready' : ios() ? 'ios' : 'manual')

export function useWebApp(): WebAppState {
  const [s, set] = useState(state)
  useEffect(() => {
    const l = () => set(state())
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return s
}

/** Shows the browser's install dialog. True if it was installed. */
export async function installWebApp(): Promise<boolean> {
  const p = prompt
  if (!p) return false
  await p.prompt()
  const { outcome } = await p.userChoice
  prompt = null
  if (outcome === 'accepted') installed = true
  changed()
  return outcome === 'accepted'
}
