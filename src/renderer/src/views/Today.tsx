import { useState } from 'react'
import { format, startOfDay } from 'date-fns'
import { CheckCircle2, Pause, Play, Plus } from 'lucide-react'
import { useRecords } from '../data/store'
import { clock, duration, isOverdue, todayKey } from '../lib/dates'
import { progress } from '../lib/subjects'
import { Bar, Empty } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { TaskDialog } from '../components/editors'
import { useTimer } from '../components/timer'
import { useNav } from '../nav'

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function Today() {
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const { items: sessions } = useRecords('session')
  const timer = useTimer()
  const { go } = useNav()
  const [adding, setAdding] = useState(false)

  const today = todayKey()
  const focus = tasks.filter(
    (t) => (!t.data.done && t.data.due && t.data.due <= today) || (t.data.done && t.data.completedAt && t.data.completedAt >= startOfDay(new Date()).getTime())
  )
  const overdue = tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const upcoming = tasks.filter((t) => !t.data.done && t.data.due && t.data.due > today).sort((a, b) => (a.data.due! < b.data.due! ? -1 : 1)).slice(0, 5)
  const studiedToday = sessions.filter((s) => s.data.startedAt >= startOfDay(new Date()).getTime()).reduce((n, s) => n + s.data.durationSec, 0)
  const doneToday = focus.filter((t) => t.data.done).length
  const active = subjects.filter((s) => !s.data.archived)

  return (
    <div className="inner view">
      <div className="topbar">
        <div>
          <h1>{greeting()}</h1>
          <p className="dim">{format(new Date(), 'EEEE d MMMM')}</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={16} /> New task
        </button>
      </div>

      <div className="grid g3" style={{ marginBottom: 18 }}>
        <div className="card stat">
          <h2>Studied today</h2>
          <b>{duration(studiedToday)}</b>
        </div>
        <div className="card stat">
          <h2>Done today</h2>
          <b>{doneToday}</b>
        </div>
        <div className="card stat">
          <h2>Overdue</h2>
          <b style={overdue ? { color: 'var(--bad)' } : undefined}>{overdue}</b>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div>
          <h2>Due today</h2>
          {focus.length ? (
            <TaskList tasks={focus} />
          ) : (
            <div className="card">
              <Empty icon={CheckCircle2} title="Nothing due today" text="Tasks due today or overdue show up here." />
            </div>
          )}
          {upcoming.length > 0 && (
            <>
              <h2 style={{ marginTop: 22 }}>Coming up</h2>
              <TaskList tasks={upcoming} />
            </>
          )}
        </div>

        <div className="stack">
          <div>
            <h2>Focus</h2>
            <div className="card between">
              <div>
                <div className="num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>
                  {clock(timer.remaining)}
                </div>
                <div className="sm dim">{timer.phase === 'focus' ? 'Focus block' : 'Break'}</div>
              </div>
              <div className="row">
                <button className="btn sec sm" onClick={() => go({ name: 'timer' })}>
                  Open
                </button>
                <button className="btn" onClick={timer.running ? timer.pause : timer.start} aria-label={timer.running ? 'Pause' : 'Start'}>
                  {timer.running ? <Pause size={16} /> : <Play size={16} />}
                </button>
              </div>
            </div>
          </div>
          <div>
            <h2>Subjects</h2>
            {active.length ? (
              <div className="ig">
                {active.map((s) => {
                  const p = progress(tasks, s.id)
                  return (
                    <button key={s.id} className="ig-row tap" onClick={() => go({ name: 'subject', id: s.id })}>
                      <span style={{ width: 10, height: 10, borderRadius: 9, background: s.data.color, flexShrink: 0, marginLeft: 6 }} />
                      <div className="grow">
                        <div className="between">
                          <span className="ig-title trunc">{s.data.name}</span>
                          <span className="xs dim num">
                            {p.done}/{p.total}
                          </span>
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <Bar pct={p.pct} color={s.data.color} />
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="card sm dim">Add a subject from the sidebar to group tasks and notes and see your progress.</div>
            )}
          </div>
        </div>
      </div>
      {adding && <TaskDialog defaults={{ due: today }} onClose={() => setAdding(false)} />}
    </div>
  )
}
