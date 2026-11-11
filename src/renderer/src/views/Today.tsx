import { useState } from 'react'
import { addDays, format, startOfDay } from 'date-fns'
import { CheckCircle2, Pause, Play, Plus } from 'lucide-react'
import { useRecords } from '../data/store'
import { clock, duration, isOverdue, todayKey } from '../lib/dates'
import { progress } from '../lib/subjects'
import { Bar, Empty } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { TaskDialog } from '../components/editors'
import { useTimer } from '../components/timer'
import { useNav } from '../nav'
import { eventDays, useGoogleEvents } from '../data/google'
import { useSettings, useTimeFormat } from '../data/settings'
import { useAccount } from '../components/account'
import { phaseLabel } from '../components/timer'

const GOAL_C = 2 * Math.PI * 23

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
  const { s } = useSettings()
  const fmtTime = useTimeFormat()
  const user = useAccount().state.user
  const firstName = (s.name.trim() || user?.displayName || '').split(/\s+/)[0]

  const today = todayKey()
  const [dayStart] = useState(() => startOfDay(new Date()))
  const { events } = useGoogleEvents(dayStart, addDays(dayStart, 1))
  const todaysEvents = events.filter((e) => eventDays(e).includes(today))
  const focus = tasks.filter(
    (t) => (!t.data.done && t.data.due && t.data.due <= today) || (t.data.done && t.data.completedAt && t.data.completedAt >= startOfDay(new Date()).getTime())
  )
  const overdue = tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const upcoming = tasks.filter((t) => !t.data.done && t.data.due && t.data.due > today).sort((a, b) => (a.data.due! < b.data.due! ? -1 : 1)).slice(0, s.upcomingCount)
  const studiedToday = sessions.filter((x) => x.data.startedAt >= startOfDay(new Date()).getTime()).reduce((n, x) => n + x.data.durationSec, 0)
  const doneToday = focus.filter((t) => t.data.done).length
  const active = subjects.filter((x) => !x.data.archived)
  const goal = s.dailyGoalMin * 60
  const goalPct = goal ? Math.min(100, Math.round((studiedToday / goal) * 100)) : 0
  const left = s.todayDue || (s.todayUpcoming && upcoming.length > 0)
  const right = (s.todaySchedule && todaysEvents.length > 0) || s.todayFocus || s.todaySubjects

  return (
    <div className="inner view">
      <div className="topbar">
        <div>
          <h1>{s.greeting ? `${greeting()}${firstName ? `, ${firstName}` : ''}` : format(new Date(), 'EEEE')}</h1>
          <p className="dim">{format(new Date(), s.greeting ? 'EEEE d MMMM' : 'd MMMM yyyy')}</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={16} /> New task
        </button>
      </div>

      {s.todayStats && <div className="grid g3" style={{ marginBottom: 18 }}>
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
      </div>}

      <div className="grid" style={{ gridTemplateColumns: left && right ? 'minmax(0,1.6fr) minmax(0,1fr)' : 'minmax(0,1fr)', alignItems: 'start' }}>
        {left && <div>
          {s.todayDue && <>
          <h2>Due today</h2>
          {focus.length ? (
            <TaskList tasks={focus} />
          ) : (
            <div className="card">
              <Empty icon={CheckCircle2} title="Nothing due today" text="Tasks due today or overdue show up here." />
            </div>
          )}
          </>}
          {s.todayUpcoming && upcoming.length > 0 && (
            <>
              <h2 style={{ marginTop: 22 }}>Coming up</h2>
              <TaskList tasks={upcoming} />
            </>
          )}
        </div>}

        {right && <div className="stack">
          {s.todaySchedule && todaysEvents.length > 0 && (
            <div>
              <h2>Today’s schedule</h2>
              <div className="ig">
                {todaysEvents.map((e) => (
                  <div key={e.id} className="ig-row">
                    <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: e.color, marginLeft: 2 }} />
                    <div className="grow">
                      <div className="ig-title trunc">{e.title}</div>
                      <div className="ig-sub trunc">
                        {e.allDay ? 'All day' : fmtTime(new Date(e.start))} · {e.calendar}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {s.todayFocus && <div>
            <h2>Focus</h2>
            <div className="card between">
              {goal > 0 && (
                <div className="goal-ring" title={`${duration(studiedToday)} of your ${duration(goal)} goal`} aria-label={`Daily goal ${goalPct}%`}>
                  <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
                    <circle cx="27" cy="27" r="23" fill="none" stroke="var(--panel-2)" strokeWidth="6" />
                    <circle cx="27" cy="27" r="23" fill="none" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" strokeDasharray={GOAL_C} strokeDashoffset={GOAL_C * (1 - goalPct / 100)} transform="rotate(-90 27 27)" />
                  </svg>
                  <span className="num">{goalPct}%</span>
                </div>
              )}
              <div className="grow">
                <div className="num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>
                  {clock(timer.remaining)}
                </div>
                <div className="sm dim">
                  {phaseLabel(timer.phase)}
                  {goal > 0 && ` · ${duration(studiedToday)} of ${duration(goal)}`}
                </div>
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
          </div>}
          {s.todaySubjects && <div>
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
          </div>}
        </div>}
      </div>
      {!left && !right && !s.todayStats && (
        <div className="card">
          <Empty icon={CheckCircle2} title="Your Today page is empty" text="Choose what it shows in Settings → Today." />
        </div>
      )}
      {adding && <TaskDialog onClose={() => setAdding(false)} />}
    </div>
  )
}
