import { useEffect, useMemo, useState } from 'react'
import { addDays, format, startOfDay } from 'date-fns'
import { Maximize2, Minimize2, Pause, Play, Plus, RotateCcw, SkipForward, Square, Target, Trash2 } from 'lucide-react'
import { db, useRecords } from '../data/store'
import { clock, duration, todayKey } from '../lib/dates'
import { phaseLabel, useTimer } from '../components/timer'
import { useSettings, useTimeFormat } from '../data/settings'
import { useNav } from '../nav'
import { SubjectSelect } from '../components/editors'
import { Select } from '../components/Select'
import { useToast } from '../components/ui'
import { sortTasks } from '../components/TaskList'

/**
 * The focus timer: pick what you're working on (a subject, and a task if you
 * like), a length for this sitting, and go. Today's goal, this week, and
 * what you've done today sit beside it. Full-screen focus hides everything
 * but the timer. Keys: Space start/pause, S skip, R reset, F full screen.
 */

const R = 128
const C = 2 * Math.PI * R
const LENGTHS = [25, 50, 90]

export function TimerView() {
  const t = useTimer()
  const { s: st } = useSettings()
  const { go } = useNav()
  const toast = useToast()
  const fmtTime = useTimeFormat()
  const { items: sessions } = useRecords('session')
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const [full, setFull] = useState(false)
  const [custom, setCustom] = useState('')
  const subject = subjects.find((s) => s.id === t.subjectId)
  const task = tasks.find((x) => x.id === t.taskId)
  const color = t.phase !== 'focus' ? 'var(--ok)' : (subject?.data.color ?? 'var(--accent)')
  const frac = t.total ? 1 - t.remaining / t.total : 0
  const dirty = t.running || t.remaining < t.total
  const focusMin = t.focusLen ?? st.focusMin

  // Today, this week, and the goal.
  const dayStart = startOfDay(new Date()).getTime()
  const todays = sessions.filter((s) => s.data.startedAt >= dayStart).sort((a, b) => b.data.startedAt - a.data.startedAt)
  const todaySec = todays.reduce((n, s) => n + s.data.durationSec, 0)
  const goalSec = st.dailyGoalMin * 60
  const week = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(new Date()), i - 6))
    return days.map((d) => {
      const from = d.getTime()
      const to = addDays(d, 1).getTime()
      return { d, sec: sessions.filter((s) => s.data.startedAt >= from && s.data.startedAt < to).reduce((n, s) => n + s.data.durationSec, 0) }
    })
  }, [sessions])
  const weekMax = Math.max(goalSec, ...week.map((w) => w.sec), 1)
  const name = (id: string | null) => subjects.find((s) => s.id === id)?.data.name ?? 'No subject'

  // Tasks you could focus on: open ones in this subject (or all, without a subject).
  const taskOptions = useMemo(() => {
    const open = sortTasks(tasks.filter((x) => !x.data.done && (!t.subjectId || x.data.subjectId === t.subjectId)), 'due')
    return [{ value: '', label: 'Nothing in particular' }, ...open.slice(0, 60).map((x) => ({ value: x.id, label: x.data.title, hint: x.data.due === todayKey() ? 'Due today' : undefined }))]
  }, [tasks, t.subjectId])

  // Keyboard: Space start/pause, S skip, R reset, F full screen, Esc leaves full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"], .sel-menu') || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === ' ') t.running ? t.pause() : t.start()
      else if (k === 's') t.skip()
      else if (k === 'r') t.reset()
      else if (k === 'f') setFull((v) => !v)
      else if (k === 'escape' && full) setFull(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const removeSession = async (id: string) => {
    const rec = sessions.find((x) => x.id === id)
    if (!rec) return
    await db.remove('session', id)
    toast('Removed from today', { label: 'Undo', run: () => void db.put('session', rec.data, rec.id) })
  }

  const ring = (size: number) => (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 280 280" aria-hidden="true">
        <circle cx="140" cy="140" r={R} fill="none" stroke="var(--panel-2)" strokeWidth="12" />
        <circle
          cx="140"
          cy="140"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset .3s linear' }}
        />
      </svg>
      <div className="time">
        <span className="pill" style={{ marginBottom: 6 }}>
          {phaseLabel(t.phase)}
        </span>
        <b role="timer" aria-live="off">
          {clock(t.remaining)}
        </b>
        <span className="sm dim trunc timer-what">{task ? task.data.title : (subject?.data.name ?? 'No subject')}</span>
      </div>
    </div>
  )

  const controls = (
    <div className="timer-controls">
      <button className="iconbtn timer-round" aria-label="Stop and save" title="Stop (saves the time so far)" disabled={!dirty} onClick={t.stop}>
        <Square size={18} />
      </button>
      <button className="btn lg timer-main" onClick={t.running ? t.pause : t.start}>
        {t.running ? <Pause size={18} /> : <Play size={18} />}
        {t.running ? 'Pause' : dirty ? 'Resume' : 'Start'}
      </button>
      <button className="iconbtn timer-round" aria-label={t.phase === 'focus' ? 'Skip to break' : 'Skip break'} title={t.phase === 'focus' ? 'Skip to break (S)' : 'Skip break (S)'} onClick={t.skip}>
        <SkipForward size={18} />
      </button>
    </div>
  )

  if (full)
    return (
      <div className="timer-full" role="dialog" aria-label="Full-screen focus">
        <button className="iconbtn plain timer-full-exit" aria-label="Leave full screen" title="Leave full screen (Esc)" onClick={() => setFull(false)}>
          <Minimize2 size={18} />
        </button>
        {ring(360)}
        {controls}
        {dirty && (
          <button className="btn ghost sm" onClick={() => t.extend(5)}>
            <Plus size={14} /> 5 min
          </button>
        )}
        <p className="xs dim">Space to start or pause · S to skip · Esc to leave</p>
      </div>
    )

  return (
    <div className="inner view timer-view">
      <div className="topbar">
        <h1>Focus timer</h1>
      </div>
      <div className="timer-grid">
        <div className="card timer-face">
          <button className="iconbtn plain timer-full-btn" aria-label="Full-screen focus" title="Full-screen focus (F)" onClick={() => setFull(true)}>
            <Maximize2 size={16} />
          </button>
          {ring(280)}
          {controls}
          <div className="timer-extras">
            <button className="btn ghost sm" disabled={!dirty} onClick={() => t.extend(5)} title="Add 5 minutes to this block">
              <Plus size={14} /> 5 min
            </button>
            <button className="btn ghost sm" disabled={!dirty} onClick={t.reset} title="Start this block over without saving it (R)">
              <RotateCcw size={14} /> Reset
            </button>
          </div>
          <p className="xs tert timer-keys">Space start/pause · S skip · R reset · F full screen</p>
        </div>

        <div className="stack">
          <div className="card timer-setup">
            <div className="field">
              <label className="field-label">Studying</label>
              <SubjectSelect value={t.subjectId} onChange={t.setSubject} />
            </div>
            <div className="field">
              <label className="field-label">
                <Target size={12} style={{ verticalAlign: -1 }} /> Working on
              </label>
              <Select label="Working on" value={t.taskId ?? ''} onChange={(v) => t.setTask(v || null)} options={taskOptions} />
            </div>
            <div className="field">
              <label className="field-label">Focus for</label>
              <div className="timer-lengths" role="group" aria-label="Focus length">
                {LENGTHS.map((m) => (
                  <button key={m} className={`dp-chip ${focusMin === m ? 'on' : ''}`} onClick={() => t.setFocusLength(m === st.focusMin ? null : m)}>
                    {m} min
                  </button>
                ))}
                <span className="timer-custom">
                  <input
                    type="number"
                    min={1}
                    max={240}
                    placeholder={LENGTHS.includes(focusMin) ? 'Other' : String(focusMin)}
                    value={custom}
                    aria-label="Other length in minutes"
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && Number(custom) > 0) {
                        t.setFocusLength(Number(custom))
                        setCustom('')
                      }
                    }}
                    onBlur={() => {
                      if (Number(custom) > 0) t.setFocusLength(Number(custom))
                      setCustom('')
                    }}
                  />
                  min
                </span>
              </div>
              <div className="xs dim" style={{ marginTop: 6 }}>
                Then a {st.breakMin}-minute break
                {st.longBreakEvery > 0 ? `, and ${st.longBreakMin} minutes after every ${st.longBreakEvery}` : ''}.{' '}
                <button
                  className="linkbtn xs"
                  onClick={() => {
                    sessionStorage.setItem('veyra.settingsSection', 'timer')
                    go({ name: 'settings' })
                  }}
                >
                  Change…
                </button>
              </div>
            </div>
            {st.longBreakEvery > 0 && (
              <div className="streak-dots" aria-label={`${t.streak} of ${st.longBreakEvery} focus blocks before a long break`} title="Focus blocks until the long break">
                {Array.from({ length: st.longBreakEvery }, (_, i) => (
                  <i key={i} className={i < t.streak ? 'on' : ''} />
                ))}
              </div>
            )}
          </div>

          <div className="card timer-today">
            <div className="between">
              <b>Today</b>
              <span className="sm dim num">
                {duration(todaySec)} of {duration(goalSec)}
              </span>
            </div>
            <div className="bar" style={{ marginTop: 8 }} role="progressbar" aria-valuenow={Math.round((todaySec / goalSec) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.min(100, (todaySec / goalSec) * 100)}%`, background: todaySec >= goalSec ? 'var(--ok)' : 'var(--accent)' }} />
            </div>
            <div className="timer-week" aria-label="This week">
              {week.map(({ d, sec }) => (
                <div key={d.getTime()} className={`timer-day ${format(d, 'yyyy-MM-dd') === todayKey() ? 'today' : ''}`} title={`${format(d, 'EEEE')}: ${duration(sec)}`}>
                  <span className="timer-day-bar">
                    <i style={{ height: `${Math.max(sec ? 6 : 0, (sec / weekMax) * 100)}%` }} />
                    <em style={{ bottom: `${(goalSec / weekMax) * 100}%` }} />
                  </span>
                  <span className="xs dim">{format(d, 'EEEEE')}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2>Done today</h2>
            {todays.length ? (
              <div className="ig">
                {todays.map((s) => (
                  <div key={s.id} className="ig-row timer-session">
                    <span className="timer-session-dot" style={{ background: subjects.find((x) => x.id === s.data.subjectId)?.data.color ?? 'var(--label-tertiary)' }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="trunc">{s.data.label || name(s.data.subjectId)}</div>
                      {s.data.label && <div className="xs dim trunc">{name(s.data.subjectId)}</div>}
                    </div>
                    <span className="sm dim num">
                      {fmtTime(s.data.startedAt)} · {duration(s.data.durationSec)}
                    </span>
                    <button className="iconbtn plain timer-session-del" aria-label="Remove this session" title="Remove (logged by mistake)" onClick={() => void removeSession(s.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card sm dim">No focus blocks yet today. Pick what you're working on and press Start.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
