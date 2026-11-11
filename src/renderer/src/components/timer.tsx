import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../data/store'
import { useSettings } from '../data/settings'
import type { AppSettings } from '@shared/settings'

/**
 * One focus timer for the whole app, so it keeps running while you move
 * between screens. A finished (or stopped, if over a minute) focus block is
 * saved as a study session against the chosen subject. Lengths, long breaks,
 * auto-start, sound and notifications come from Settings → Focus timer.
 */
export type Phase = 'focus' | 'break' | 'long'

interface TimerState {
  phase: Phase
  running: boolean
  /** Seconds left in the current block. */
  remaining: number
  /** Length of the current block; fixed when the block starts. */
  total: number
  subjectId: string | null
  /** Focus blocks finished since the last long break. */
  streak: number
  start: () => void
  pause: () => void
  stop: () => void
  skip: () => void
  setSubject: (id: string | null) => void
  /** Start (or keep) studying this subject; time already spent on another subject is saved first. */
  study: (id: string | null) => void
}

const Ctx = createContext<TimerState | null>(null)
export const useTimer = (): TimerState => useContext(Ctx)!

export const phaseLabel = (p: Phase) => (p === 'focus' ? 'Focus' : p === 'long' ? 'Long break' : 'Break')

const lengthOf = (p: Phase, s: AppSettings) => (p === 'focus' ? s.focusMin : p === 'long' ? s.longBreakMin : s.breakMin) * 60

/** The end-of-block sound. Also used by Settings to preview it. */
export function playSound(kind: AppSettings['sound'], volume: number): void {
  if (kind === 'none') return
  try {
    const ac = new AudioContext()
    const notes: [number, number, number][] =
      kind === 'bell'
        ? [[0, 1046.5, 1.6], [0, 1568, 1.2]] // one struck bell, with an overtone
        : kind === 'soft'
          ? [[0, 523.25, 0.9], [0.25, 659.25, 1.1]] // low, gentle two notes
          : [[0, 659.25, 0.5], [0.18, 880, 0.55]] // the chime
    const peak = 0.25 * Math.max(0.05, Math.min(1, volume))
    for (const [t, f, len] of notes) {
      const o = ac.createOscillator()
      const g = ac.createGain()
      o.type = kind === 'soft' ? 'triangle' : 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, ac.currentTime + t)
      g.gain.exponentialRampToValueAtTime(peak, ac.currentTime + t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + len)
      o.connect(g).connect(ac.destination)
      o.start(ac.currentTime + t)
      o.stop(ac.currentTime + t + len + 0.05)
    }
    setTimeout(() => ac.close(), 2500)
  } catch {
    /* no audio */
  }
}

export function TimerProvider({ children }: { children: ReactNode }) {
  const { s } = useSettings()
  const [phase, setPhase] = useState<Phase>('focus')
  const [running, setRunning] = useState(false)
  const [total, setTotal] = useState(() => lengthOf('focus', s))
  const [remaining, setRemaining] = useState(total)
  const [subjectId, setSubject] = useState<string | null>(null)
  const [streak, setStreak] = useState(0)

  // Wall-clock based so the count stays right even if the window is throttled.
  const endsAt = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)
  const idle = !running && startedAt.current == null

  // While nothing is in progress, new lengths from Settings apply at once.
  useEffect(() => {
    if (!idle) return
    const t = lengthOf(phase, s)
    setTotal(t)
    setRemaining(t)
  }, [s.focusMin, s.breakMin, s.longBreakMin]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveFocus = useCallback(
    (sec: number) => {
      if (sec < 60 || startedAt.current == null) return
      db.put('session', { subjectId, startedAt: startedAt.current, endedAt: Date.now(), durationSec: Math.round(sec) })
    },
    [subjectId]
  )

  /** Move to a block; optionally start it straight away. */
  const enter = useCallback(
    (p: Phase, autostart: boolean) => {
      const t = lengthOf(p, s)
      setPhase(p)
      setTotal(t)
      setRemaining(t)
      startedAt.current = autostart ? Date.now() : null
      endsAt.current = autostart ? Date.now() + t * 1000 : null
      setRunning(autostart)
    },
    [s]
  )

  const notify = useCallback(
    (title: string, body: string) => {
      if (!s.notify) return
      try {
        new Notification(title, { body, silent: true })
      } catch {
        /* notifications unavailable */
      }
    },
    [s.notify]
  )

  const finishBlock = useCallback(() => {
    playSound(s.sound, s.volume)
    if (phase === 'focus') {
      saveFocus(total)
      const done = streak + 1
      const long = s.longBreakEvery > 0 && done % s.longBreakEvery === 0
      setStreak(long ? 0 : done)
      const next: Phase = long ? 'long' : 'break'
      notify('Focus block done', `Take a ${lengthOf(next, s) / 60}-minute ${long ? 'long ' : ''}break.`)
      enter(next, s.autoStartBreaks)
    } else {
      notify('Break over', 'Ready for the next focus block?')
      enter('focus', s.autoStartFocus)
    }
  }, [phase, saveFocus, total, streak, s, notify, enter])

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
  const stop = () => {
    if (phase === 'focus') saveFocus(total - remaining)
    enter('focus', false)
  }
  const skip = () => {
    if (phase === 'focus') {
      const spent = total - remaining
      saveFocus(spent)
      // A block you finish early still counts toward the long break.
      const done = spent >= 60 ? streak + 1 : streak
      const long = spent >= 60 && s.longBreakEvery > 0 && done % s.longBreakEvery === 0
      setStreak(long ? 0 : done)
      enter(long ? 'long' : 'break', false)
    } else enter('focus', false)
  }
  /** Switching subject mid-block saves the time so far to the old subject, then starts a fresh block. */
  const changeSubject = (id: string | null) => {
    if (id === subjectId) return
    if (phase === 'focus' && startedAt.current != null) {
      saveFocus(total - remaining)
      setSubject(id)
      enter('focus', running)
      return
    }
    setSubject(id)
  }
  const study = (id: string | null) => {
    if (phase === 'focus' && startedAt.current != null && id !== subjectId) {
      saveFocus(total - remaining)
      setSubject(id)
      enter('focus', true)
      return
    }
    setSubject(id)
    if (phase !== 'focus') enter('focus', true)
    else if (!running) start()
  }

  return <Ctx.Provider value={{ phase, running, remaining, total, subjectId, streak, start, pause, stop, skip, setSubject: changeSubject, study }}>{children}</Ctx.Provider>
}
