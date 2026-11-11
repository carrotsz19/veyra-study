import { startOfDay } from 'date-fns'
import { Pause, Play, SkipForward, Square } from 'lucide-react'
import { useRecords } from '../data/store'
import { clock, duration } from '../lib/dates'
import { useTimer } from '../components/timer'
import { SubjectSelect } from '../components/editors'

const R = 128
const C = 2 * Math.PI * R

export function TimerView() {
  const t = useTimer()
  const { items: sessions } = useRecords('session')
  const { items: subjects } = useRecords('subject')
  const subject = subjects.find((s) => s.id === t.subjectId)
  const color = t.phase === 'break' ? 'var(--ok)' : (subject?.data.color ?? 'var(--accent)')
  const frac = t.total ? 1 - t.remaining / t.total : 0
  const dirty = t.running || t.remaining < t.total

  const todays = sessions.filter((s) => s.data.startedAt >= startOfDay(new Date()).getTime()).sort((a, b) => b.data.startedAt - a.data.startedAt)
  const name = (id: string | null) => subjects.find((s) => s.id === id)?.data.name ?? 'No subject'

  return (
    <div className="inner view">
      <div className="topbar">
        <h1>Focus timer</h1>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div className="card timer-face">
          <div className="ring">
            <svg width="280" height="280" viewBox="0 0 280 280" aria-hidden="true">
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
                {t.phase === 'focus' ? 'Focus' : 'Break'}
              </span>
              <b role="timer" aria-live="off">
                {clock(t.remaining)}
              </b>
              <span className="sm dim">{subject?.data.name ?? 'No subject'}</span>
            </div>
          </div>
          <div className="row" style={{ marginTop: 24, gap: 12 }}>
            <button className="iconbtn" style={{ width: 50, height: 50, borderRadius: 99 }} aria-label="Stop and save" title="Stop (saves the time so far)" disabled={!dirty} onClick={t.stop}>
              <Square size={18} />
            </button>
            <button className="btn lg" style={{ minWidth: 150 }} onClick={t.running ? t.pause : t.start}>
              {t.running ? <Pause size={18} /> : <Play size={18} />}
              {t.running ? 'Pause' : dirty ? 'Resume' : 'Start'}
            </button>
            <button className="iconbtn" style={{ width: 50, height: 50, borderRadius: 99 }} aria-label={t.phase === 'focus' ? 'Skip to break' : 'Skip break'} title={t.phase === 'focus' ? 'Skip to break' : 'Skip break'} onClick={t.skip}>
              <SkipForward size={18} />
            </button>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="field">
              <label className="field-label">Studying</label>
              <SubjectSelect value={t.subjectId} onChange={t.setSubject} />
            </div>
            <div className="grid g2 field">
              <div>
                <label className="field-label" htmlFor="focus-min">Focus (min)</label>
                <input
                  id="focus-min"
                  type="number"
                  min={1}
                  max={180}
                  value={t.settings.focusMin}
                  onChange={(e) => t.setSettings({ ...t.settings, focusMin: Math.max(1, Math.min(180, +e.target.value || 1)) })}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="break-min">Break (min)</label>
                <input
                  id="break-min"
                  type="number"
                  min={1}
                  max={60}
                  value={t.settings.breakMin}
                  onChange={(e) => t.setSettings({ ...t.settings, breakMin: Math.max(1, Math.min(60, +e.target.value || 1)) })}
                />
              </div>
            </div>
            <p className="xs dim" style={{ margin: '10px 0 0' }}>
              Focus time is saved when a block finishes, or when you stop or skip after at least a minute.
            </p>
          </div>
          <div>
            <h2>Today · {duration(todays.reduce((n, s) => n + s.data.durationSec, 0))}</h2>
            {todays.length ? (
              <div className="ig">
                {todays.map((s) => (
                  <div key={s.id} className="ig-row">
                    <span style={{ width: 9, height: 9, borderRadius: 9, marginLeft: 6, background: subjects.find((x) => x.id === s.data.subjectId)?.data.color ?? 'var(--label-tertiary)' }} />
                    <span className="grow trunc">{name(s.data.subjectId)}</span>
                    <span className="sm dim num">
                      {new Date(s.data.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {duration(s.data.durationSec)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card sm dim">No focus blocks yet today.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
