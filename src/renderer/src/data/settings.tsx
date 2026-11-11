import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { accentColors, withDefaults, type AppSettings } from '@shared/settings'
import { db, useRecords } from './store'

const SETTINGS_ID = 'app-settings'
/** Mirrored to localStorage so the theme and accent apply before data loads (and on the sign-in screen). */
const BOOT_KEY = 'veyra.boot'

interface Ctx {
  /** The saved settings have loaded (until then, the boot copy is used). */
  ready: boolean
  s: AppSettings
  set: (patch: Partial<AppSettings>) => void
  reset: (keys?: (keyof AppSettings)[]) => void
}
const SettingsCtx = createContext<Ctx | null>(null)
export const useSettings = () => useContext(SettingsCtx)!

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { items, loaded } = useRecords('settings')
  const stored = items.find((r) => r.id === SETTINGS_ID)?.data
  const [local, setLocal] = useState<AppSettings>(() => withDefaults(readBoot()))
  const pending = useRef<Partial<AppSettings>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The saved record wins once it loads.
  useEffect(() => {
    if (loaded) setLocal(withDefaults({ ...stored, ...pending.current }))
  }, [loaded, stored])

  const save = useCallback(() => {
    timer.current = null
    const next = { ...(stored ?? {}), ...pending.current }
    pending.current = {}
    db.put('settings', next, SETTINGS_ID)
  }, [stored])

  const set = useCallback(
    (patch: Partial<AppSettings>) => {
      setLocal((cur) => withDefaults({ ...cur, ...patch }))
      pending.current = { ...pending.current, ...patch }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, 300)
    },
    [save]
  )
  const reset = useCallback(
    (keys?: (keyof AppSettings)[]) => {
      if (!keys) {
        pending.current = {}
        setLocal(withDefaults({}))
        db.put('settings', {}, SETTINGS_ID)
        return
      }
      const defaults = withDefaults({})
      set(Object.fromEntries(keys.map((k) => [k, defaults[k]])) as Partial<AppSettings>)
    },
    [set]
  )

  // Save a pending change if the window closes before the debounce fires.
  useEffect(() => {
    const onUnload = () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      window.veyra.saveNow('settings', { ...(stored ?? {}), ...pending.current }, SETTINGS_ID)
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [stored])

  useApplyAppearance(local)

  return <SettingsCtx.Provider value={{ ready: loaded, s: local, set, reset }}>{children}</SettingsCtx.Provider>
}

function readBoot(): Partial<AppSettings> {
  try {
    return JSON.parse(localStorage.getItem(BOOT_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** Puts appearance settings on <html>: theme, accent, font, density, corners, motion, zoom. */
function useApplyAppearance(s: AppSettings) {
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const forced = new URLSearchParams(location.search).get('theme') // dev checks
  const theme = forced || s.theme
  const dark = theme === 'dark' || (theme === 'system' && systemDark)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    const { light, dark: darkColor } = accentColors(s.accent)
    const tint = dark ? darkColor : light
    // Only the accent changes; red stays red for overdue, high priority and delete.
    root.style.setProperty('--tint', tint)
    root.style.setProperty('--tint-soft', dark ? `color-mix(in srgb, ${tint} 24%, #1e1c17)` : `color-mix(in srgb, ${tint} 17%, #ffffff)`)
    root.dataset.font = s.font
    root.dataset.density = s.density
    root.dataset.corners = s.corners
    root.classList.toggle('reduce-motion', s.reduceMotion)
    const seeThrough = window.veyra.app.materialSupported && s.material !== 'solid'
    root.classList.toggle('material', seeThrough)
    root.dataset.material = seeThrough ? s.material : 'solid'
    void window.veyra.app.setMaterial(s.material, s.theme)
    window.veyra.app.setZoom(s.zoom)
    try {
      localStorage.setItem(BOOT_KEY, JSON.stringify({ theme: s.theme, accent: s.accent, font: s.font, zoom: s.zoom }))
      localStorage.setItem('veyra.theme', s.theme)
    } catch {
      /* storage unavailable */
    }
  }, [dark, s.accent, s.font, s.density, s.corners, s.reduceMotion, s.zoom, s.theme, s.material])
}

/** Time of day in the person's chosen format. */
export function useTimeFormat() {
  const { s } = useSettings()
  return (d: Date | number) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: s.timeFormat === '12h' })
}
