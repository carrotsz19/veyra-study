import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../data/store'

/**
 * One focus timer for the whole app, so it keeps running while you move
 * between screens. A finished (or stopped, if over a minute) focus block is
 * saved as a study session against the chosen subject.
 */
export type Phase = 'focus' | 'break'

export interface TimerSettings {
  focusMin: number
  breakMin: number
}

interface TimerState {
  phase: Phase
  running: boolean
  /** Seconds left in the current block. */
  remaining: number
  total: number
  subjectId: string | null
  settings: TimerSettings
  start: () => void
  pause: () => void
  stop: () => void
  skip: () => void
  setSubject: (id: string | null) => void
  setSettings: (s: TimerSettings) => void
}

const Ctx = createContext<TimerState | null>(null)
export const useTimer = (): TimerState => useContext(Ctx)!

const SETTINGS_KEY = 'veyra.timer'
function loadSettings(): TimerSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '')
    if (s.focusMin > 0 && s.breakMin > 0) return s
  } catch {
    /* defaults */
  }
  return { focusMin: 25, breakMin: 5 }
}

function chime(): void {
  try {
    const ac = new AudioContext()
    ;[0, 0.18].forEach((t, i) => {
      const o = ac.createOscillator()
      const g = ac.createGain()
      o.frequency.value = i ? 880 : 660
      g.gain.setValueAtTime(0.0001, ac.currentTime + t)
      g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.5)
      o.connect(g).connect(ac.destination)
      o.start(ac.currentTime + t)
      o.stop(ac.currentTime + t + 0.55)
    })
  } catch {
    /* no audio */
  }
}

export function TimerProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState(loadSettings)
  const [phase, setPhase] = useState<Phase>('focus')
  const [running, setRunning] = useState(false)
  const [remaining, setRemaining] = useState(settings.focusMin * 60)
  const [subjectId, setSubject] = useState<string | null>(null)

  // Wall-clock based so the count stays right even if the window is throttled.
  const endsAt = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)

  const total = (phase === 'focus' ? settings.focusMin : settings.breakMin) * 60

  const saveFocus = useCallback(
    (sec: number) => {
      if (sec < 60 || startedAt.current == null) return
      const end = Date.now()
      db.put('session', {
        subjectId,
        startedAt: startedAt.current,
        endedAt: end,
        durationSec: Math.round(sec)
      })
    },
    [subjectId]
  )

  const finishBlock = useCallback(() => {
    chime()
    if (phase === 'focus') {
      saveFocus(total)
      new Notification('Focus block done', { body: `Take a ${settings.breakMin}-minute break.`, silent: true })
      setPhase('break')
      setRemaining(settings.breakMin * 60)
    } else {
      new Notification('Break over', { body: 'Ready for the next focus block?', silent: true })
      setPhase('focus')
      setRemaining(settings.focusMin * 60)
    }
    startedAt.current = null
    endsAt.current = null
    setRunning(false)
  }, [phase, saveFocus, settings, total])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const left = ((endsAt.current ?? Date.now()) - Date.now()) / 1000
      if (left <= 0) finishBlock()
      else setRemaining(left)
    }, 250)
    return () => clearInterval(id)
  }, [running, finishBlock])

  const start = () => {
    if (running) return
    if (startedAt.current == null) startedAt.current = Date.now()
    endsAt.current = Date.now() + remaining * 1000
    setRunning(true)
  }
  const pause = () => {
    if (!running) return
    endsAt.current = null
    setRunning(false)
  }
  const reset = (p: Phase) => {
    setPhase(p)
    setRemaining((p === 'focus' ? settings.focusMin : settings.breakMin) * 60)
    startedAt.current = null
    endsAt.current = null
    setRunning(false)
  }
  const stop = () => {
    if (phase === 'focus') saveFocus(total - remaining)
    reset('focus')
  }
  const skip = () => {
    if (phase === 'focus') saveFocus(total - remaining)
    reset(phase === 'focus' ? 'break' : 'focus')
  }
  const setSettings = (s: TimerSettings) => {
    setSettingsState(s)
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
    if (!running && startedAt.current == null) setRemaining((phase === 'focus' ? s.focusMin : s.breakMin) * 60)
  }

  return (
    <Ctx.Provider
      value={{ phase, running, remaining, total, subjectId, settings, start, pause, stop, skip, setSubject, setSettings }}
    >
      {children}
    </Ctx.Provider>
  )
}
