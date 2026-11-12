import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../data/store'
import { useSettings } from '../data/settings'
import { useToast } from './ui'
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
  /** The task you're focusing on (optional); its title labels the saved session. */
  taskId: string | null
  /** Focus length chosen on the timer for this sitting (minutes), or null for Settings' length. */
  focusLen: number | null
  /** Focus blocks finished since the last long break. */
  streak: number
  start: () => void
  pause: () => void
  stop: () => void
  skip: () => void
  /** Start the current block over, without saving it. */
  reset: () => void
  /** Add minutes to the block that's running (or about to). */
  extend: (min: number) => void
  setFocusLength: (min: number | null) => void
  setTask: (id: string | null) => void
  setSubject: (id: string | null) => void
  /** Start (or keep) studying this subject; time already spent on another subject is saved first. */
  study: (id: string | null) => void
}

const Ctx = createContext<TimerState | null>(null)
export const useTimer = (): TimerState => useContext(Ctx)!

export const phaseLabel = (p: Phase) => (p === 'focus' ? 'Focus' : p === 'long' ? 'Long break' : 'Break')

const lengthOf = (p: Phase, s: AppSettings, focusLen?: number | null) => (p === 'focus' ? focusLen || s.focusMin : p === 'long' ? s.longBreakMin : s.breakMin) * 60

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

/* A block in progress is kept, so it survives the app closing (or Android stopping it in the background). */
const SAVED = 'veyra.timer'
interface Saved {
  phase: Phase
  running: boolean
  total: number
  remaining: number
  subjectId: string | null
  streak: number
  endsAt: number | null
  startedAt: number | null
  taskId?: string | null
  focusLen?: number | null
}
function loadSaved(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as Saved | null
    // Anything older than a day is stale.
    if (!v || typeof v.total !== 'number' || v.startedAt == null || Date.now() - v.startedAt > 86_400_000) return null
    return v
  } catch {
    return null
  }
}

export function TimerProvider({ children }: { children: ReactNode }) {
  const { s } = useSettings()
  const [saved] = useState(loadSaved)
  const [phase, setPhase] = useState<Phase>(saved?.phase ?? 'focus')
  const [running, setRunning] = useState(saved?.running ?? false)
  const [total, setTotal] = useState(() => saved?.total ?? lengthOf('focus', s))
  const [remaining, setRemaining] = useState(() => (saved ? (saved.running && saved.endsAt ? Math.max(0, (saved.endsAt - Date.now()) / 1000) : saved.remaining) : total))
  const [subjectId, setSubject] = useState<string | null>(saved?.subjectId ?? null)
  const [taskId, setTaskState] = useState<string | null>(saved?.taskId ?? null)
  const [focusLen, setFocusLen] = useState<number | null>(saved?.focusLen ?? null)
  const [streak, setStreak] = useState(saved?.streak ?? 0)
  const toast = useToast()

  // Wall-clock based so the count stays right even if the window is throttled.
  const endsAt = useRef<number | null>(saved?.running ? saved.endsAt : null)
  const startedAt = useRef<number | null>(saved?.startedAt ?? null)
  const idle = !running && startedAt.current == null
  // Bumped whenever a block starts or resets, so it's saved even when nothing else changed.
  const [rev, bump] = useState(0)

  // Remember the block whenever it starts, pauses, ends or changes subject.
  useEffect(() => {
    try {
      if (startedAt.current == null && !running) localStorage.removeItem(SAVED)
      else localStorage.setItem(SAVED, JSON.stringify({ phase, running, total, remaining, subjectId, streak, endsAt: endsAt.current, startedAt: startedAt.current, taskId, focusLen } satisfies Saved))
    } catch {
      /* storage unavailable */
    }
  }, [phase, running, total, subjectId, streak, rev, taskId, focusLen]) // eslint-disable-line react-hooks/exhaustive-deps

  // While nothing is in progress, new lengths from Settings apply at once.
  useEffect(() => {
    if (!idle) return
    const t = lengthOf(phase, s, focusLen)
    setTotal(t)
    setRemaining(t)
  }, [s.focusMin, s.breakMin, s.longBreakMin, focusLen]) // eslint-disable-line react-hooks/exhaustive-deps

  // The task's title, to label sessions and ask "did you finish it?".
  const taskTitle = useRef<string | null>(null)
  useEffect(() => {
    taskTitle.current = null
    if (taskId) void db.list('task').then((all) => (taskTitle.current = all.find((t) => t.id === taskId)?.data.title ?? null))
  }, [taskId])

  const saveFocus = useCallback(
    (sec: number) => {
      if (sec < 60 || startedAt.current == null) return
      db.put('session', {
        subjectId,
        startedAt: startedAt.current,
        endedAt: Date.now(),
        durationSec: Math.round(sec),
        ...(taskId ? { taskId, label: taskTitle.current ?? undefined } : {})
      })
    },
    [subjectId, taskId]
  )

  /** Move to a block; optionally start it straight away. */
  const enter = useCallback(
    (p: Phase, autostart: boolean) => {
      const t = lengthOf(p, s, focusLen)
      setPhase(p)
      setTotal(t)
      setRemaining(t)
      startedAt.current = autostart ? Date.now() : null
      endsAt.current = autostart ? Date.now() + t * 1000 : null
      setRunning(autostart)
      bump((n) => n + 1)
    },
    [s, focusLen]
  )

  const notify = useCallback(
    (title: string, body: string) => {
      // On the phone the alert was scheduled ahead (the app may be asleep in the background).
      if (!s.notify || window.veyra.app.timerAlarm) return
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
      // Focusing on a task: ask whether it's done, and tick it off from here.
      const id = taskId
      if (id)
        void db.list('task').then((all) => {
          const t = all.find((x) => x.id === id)
          if (t && !t.data.done)
            toast(`Focus block done. Did you finish “${t.data.title}”?`, {
              label: 'Mark done',
              run: () => {
                void db.put('task', { ...t.data, done: true, completedAt: Date.now() }, t.id)
                setTaskState(null)
              }
            })
        })
    } else {
      notify('Break over', 'Ready for the next focus block?')
      enter('focus', s.autoStartFocus)
    }
  }, [phase, saveFocus, total, streak, s, notify, enter, taskId, toast])

  // Phone: line up the end-of-block notification whenever a block is running.
  useEffect(() => {
    const alarm = window.veyra.app.timerAlarm
    if (!alarm) return
    const at = running && s.notify ? endsAt.current : null
    if (at == null) void alarm(null)
    else if (phase === 'focus') {
      const done = streak + 1
      const long = s.longBreakEvery > 0 && done % s.longBreakEvery === 0
      void alarm(at, 'Focus block done', `Take a ${lengthOf(long ? 'long' : 'break', s) / 60}-minute ${long ? 'long ' : ''}break.`)
    } else void alarm(at, 'Break over', 'Ready for the next focus block?')
  }, [running, phase, total, s.notify, s.longBreakEvery, streak]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const reset = () => enter(phase, false)
  const extend = (min: number) => {
    const add = min * 60
    setTotal((t) => t + add)
    setRemaining((r) => r + add)
    if (endsAt.current != null) endsAt.current += add * 1000
    bump((n) => n + 1)
  }
  /** A focus length for this sitting; applies now if nothing's in progress, else from the next focus block. */
  const setFocusLength = (min: number | null) => setFocusLen(min && min > 0 ? Math.min(240, Math.round(min)) : null)
  /** Focusing on a task also picks its subject. */
  const setTask = (id: string | null) => {
    setTaskState(id)
    if (id)
      void db.list('task').then((all) => {
        const t = all.find((x) => x.id === id)
        if (t && t.data.subjectId !== subjectId) changeSubject(t.data.subjectId)
      })
  }

  return (
    <Ctx.Provider value={{ phase, running, remaining, total, subjectId, taskId, focusLen, streak, start, pause, stop, skip, reset, extend, setFocusLength, setTask, setSubject: changeSubject, study }}>
      {children}
    </Ctx.Provider>
  )
}
