import { useMemo, useState, type ReactNode } from 'react'
import { addDays, format, formatDistanceToNowStrict, startOfDay, subDays } from 'date-fns'
import {
  ArrowDown, ArrowUp, BarChart3, CalendarClock, CheckCircle2, Flame, GripVertical, LayoutGrid, ListTodo, NotebookPen,
  Pause, Play, Plus, RotateCcw, Sparkles, Target, Timer, X, type LucideIcon
} from 'lucide-react'
import type { Rec } from '@shared/types'
import { defaultLayout, type WidgetId, type WidgetSize, type WidgetSlot } from '@shared/settings'
import { db, useRecords } from '../data/store'
import { clock, dayKey, duration, isOverdue, todayKey } from '../lib/dates'
import { defaultDueDate, progress } from '../lib/subjects'
import { Bar, Empty, useToast } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { TaskDialog } from '../components/editors'
import { phaseLabel, useTimer } from '../components/timer'
import { useNav } from '../nav'
import { eventDays, useGoogleEvents } from '../data/google'
import { useSettings, useTimeFormat } from '../data/settings'
import { useAccount } from '../components/account'
import type { GoogleEvent } from '@shared/types'

/* =====================================================================
   TODAY — a page of widgets. "Customize" lets you reorder (drag, or the
   arrows), resize, remove and add widgets. The layout is a setting, so
   it follows the account.
===================================================================== */

interface WidgetDef {
  title: string
  description: string
  icon: LucideIcon
  sizes: WidgetSize[]
  defaultSize: WidgetSize
}

const DEFS: Record<WidgetId, WidgetDef> = {
  stats: { title: 'Summary', description: 'Studied today, done today and overdue.', icon: BarChart3, sizes: ['m', 'l', 'xl'], defaultSize: 'xl' },
  due: { title: 'Due today', description: 'Tasks due today or late, and what you finished today.', icon: CheckCircle2, sizes: ['m', 'l', 'xl'], defaultSize: 'l' },
  upcoming: { title: 'Coming up', description: 'Your next tasks with a due date.', icon: ListTodo, sizes: ['s', 'm', 'l', 'xl'], defaultSize: 'l' },
  schedule: { title: 'Today’s schedule', description: 'Events from your connected calendars.', icon: CalendarClock, sizes: ['s', 'm', 'l', 'xl'], defaultSize: 's' },
  focus: { title: 'Focus timer', description: 'Start or pause the timer from here.', icon: Timer, sizes: ['s', 'm', 'l'], defaultSize: 's' },
  subjects: { title: 'Subjects', description: 'Progress for each subject.', icon: LayoutGrid, sizes: ['s', 'm', 'l', 'xl'], defaultSize: 's' },
  goal: { title: 'Daily goal', description: 'A ring that fills as you study.', icon: Target, sizes: ['s', 'm'], defaultSize: 's' },
  week: { title: 'This week', description: 'Study time for the last 7 days.', icon: BarChart3, sizes: ['m', 'l', 'xl'], defaultSize: 'm' },
  streak: { title: 'Streak', description: 'Days in a row you’ve studied.', icon: Flame, sizes: ['s', 'm'], defaultSize: 's' },
  notes: { title: 'Recent notes', description: 'Jump back into what you were writing.', icon: NotebookPen, sizes: ['s', 'm', 'l', 'xl'], defaultSize: 'm' },
  quickadd: { title: 'Quick add', description: 'Type a task and press Enter.', icon: Sparkles, sizes: ['m', 'l', 'xl'], defaultSize: 'xl' }
}
const SIZE_LABEL: Record<WidgetSize, string> = { s: 'Small', m: 'Medium', l: 'Large', xl: 'Full width' }
const GOAL_C = 2 * Math.PI * 23

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/** Everything the widgets read, worked out once per render. */
function useTodayData() {
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const { items: sessions } = useRecords('session')
  const { items: notes } = useRecords('note')
  const { s } = useSettings()
  const today = todayKey()
  const [dayStart] = useState(() => startOfDay(new Date()))
  const { events } = useGoogleEvents(dayStart, addDays(dayStart, 1))

  return useMemo(() => {
    const startMs = dayStart.getTime()
    const due = tasks.filter((t) => (!t.data.done && t.data.due && t.data.due <= today) || (t.data.done && (t.data.completedAt ?? 0) >= startMs))
    const upcoming = tasks
      .filter((t) => !t.data.done && t.data.due && t.data.due > today)
      .sort((a, b) => (a.data.due! < b.data.due! ? -1 : 1))
      .slice(0, s.upcomingCount)
    const perDay = new Map<string, number>()
    sessions.forEach((x) => perDay.set(dayKey(x.data.startedAt), (perDay.get(dayKey(x.data.startedAt)) ?? 0) + x.data.durationSec))
    let streak = 0
    for (let d = perDay.has(today) ? new Date() : subDays(new Date(), 1); perDay.has(dayKey(d)); d = subDays(d, 1)) streak++
    return {
      tasks,
      subjects: subjects.filter((x) => !x.data.archived),
      notes: [...notes].sort((a, b) => b.updatedAt - a.updatedAt),
      due,
      upcoming,
      overdue: tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length,
      doneToday: due.filter((t) => t.data.done).length,
      studiedToday: perDay.get(today) ?? 0,
      perDay,
      streak,
      events: events.filter((e) => eventDays(e).includes(today)),
      goal: s.dailyGoalMin * 60
    }
  }, [tasks, subjects, sessions, notes, events, s.upcomingCount, s.dailyGoalMin, today, dayStart])
}
type TodayData = ReturnType<typeof useTodayData>

/* ---------- the widgets ---------- */
function Card({ title, action, children, flush }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="w-card" aria-label={title}>
      <header className="w-head">
        <h2>{title}</h2>
        {action}
      </header>
      <div className={flush ? 'w-body flush' : 'w-body'}>{children}</div>
    </section>
  )
}

function StatsWidget({ d }: { d: TodayData }) {
  return (
    <div className="w-stats">
      <div className="card stat">
        <h2>Studied today</h2>
        <b>{duration(d.studiedToday)}</b>
      </div>
      <div className="card stat">
        <h2>Done today</h2>
        <b>{d.doneToday}</b>
      </div>
      <div className="card stat">
        <h2>Overdue</h2>
        <b style={d.overdue ? { color: 'var(--bad)' } : undefined}>{d.overdue}</b>
      </div>
    </div>
  )
}

function DueWidget({ d }: { d: TodayData }) {
  return (
    <Card title="Due today" flush>
      {d.due.length ? <TaskList tasks={d.due} /> : <Empty icon={CheckCircle2} title="Nothing due today" text="Tasks due today or overdue show up here." />}
    </Card>
  )
}

function UpcomingWidget({ d }: { d: TodayData }) {
  return (
    <Card title="Coming up" flush>
      {d.upcoming.length ? <TaskList tasks={d.upcoming} /> : <p className="w-empty">No upcoming deadlines.</p>}
    </Card>
  )
}

function ScheduleWidget({ d }: { d: TodayData }) {
  const fmtTime = useTimeFormat()
  const { go } = useNav()
  return (
    <Card title="Today’s schedule" flush>
      {d.events.length ? (
        <div className="ig plain">
          {d.events.map((e: GoogleEvent) => (
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
      ) : (
        <p className="w-empty">
          Nothing scheduled.{' '}
          <button
            className="linkbtn"
            onClick={() => {
              sessionStorage.setItem('veyra.settingsSection', 'connections')
              go({ name: 'settings' })
            }}
          >
            Connect a calendar
          </button>
        </p>
      )}
    </Card>
  )
}

function GoalRing({ pct, size = 54 }: { pct: number; size?: number }) {
  return (
    <div className="goal-ring" style={{ width: size, height: size }} aria-label={`Daily goal ${pct}%`}>
      <svg width={size} height={size} viewBox="0 0 54 54" aria-hidden="true">
        <circle cx="27" cy="27" r="23" fill="none" stroke="var(--panel-2)" strokeWidth="6" />
        <circle cx="27" cy="27" r="23" fill="none" stroke="var(--accent)" strokeWidth="6" strokeLinecap="round" strokeDasharray={GOAL_C} strokeDashoffset={GOAL_C * (1 - pct / 100)} transform="rotate(-90 27 27)" />
      </svg>
      <span className="num" style={{ fontSize: size > 70 ? 17 : 11.5 }}>{pct}%</span>
    </div>
  )
}

function FocusWidget({ d }: { d: TodayData }) {
  const timer = useTimer()
  const { go } = useNav()
  const goalPct = d.goal ? Math.min(100, Math.round((d.studiedToday / d.goal) * 100)) : 0
  return (
    <Card title="Focus">
      <div className="between">
        {d.goal > 0 && <GoalRing pct={goalPct} />}
        <div className="grow">
          <div className="num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>
            {clock(timer.remaining)}
          </div>
          <div className="sm dim">{phaseLabel(timer.phase)}</div>
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
    </Card>
  )
}

function SubjectsWidget({ d }: { d: TodayData }) {
  const { go } = useNav()
  return (
    <Card title="Subjects" flush>
      {d.subjects.length ? (
        <div className="ig plain">
          {d.subjects.map((x) => {
            const p = progress(d.tasks, x.id)
            return (
              <button key={x.id} className="ig-row tap" onClick={() => go({ name: 'subject', id: x.id })}>
                <span style={{ width: 10, height: 10, borderRadius: 9, background: x.data.color, flexShrink: 0, marginLeft: 6 }} />
                <div className="grow">
                  <div className="between">
                    <span className="ig-title trunc">{x.data.name}</span>
                    <span className="xs dim num">
                      {p.done}/{p.total}
                    </span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Bar pct={p.pct} color={x.data.color} />
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="w-empty">Add a subject from the sidebar to see your progress here.</p>
      )}
    </Card>
  )
}

function GoalWidget({ d }: { d: TodayData }) {
  const { go } = useNav()
  if (!d.goal)
    return (
      <Card title="Daily goal">
        <p className="w-empty" style={{ padding: 0 }}>
          No daily goal set.{' '}
          <button
            className="linkbtn"
            onClick={() => {
              sessionStorage.setItem('veyra.settingsSection', 'timer')
              go({ name: 'settings' })
            }}
          >
            Set one
          </button>
        </p>
      </Card>
    )
  const pct = Math.min(100, Math.round((d.studiedToday / d.goal) * 100))
  const left = Math.max(0, d.goal - d.studiedToday)
  return (
    <Card title="Daily goal">
      <div className="row" style={{ gap: 16 }}>
        <GoalRing pct={pct} size={84} />
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{duration(d.studiedToday)}</div>
          <div className="sm dim">of {duration(d.goal)}</div>
          <div className="xs tert" style={{ marginTop: 4 }}>{left ? `${duration(left)} to go` : 'Goal reached'}</div>
        </div>
      </div>
    </Card>
  )
}

function WeekWidget({ d }: { d: TodayData }) {
  const days = Array.from({ length: 7 }, (_, i) => subDays(startOfDay(new Date()), 6 - i))
  const max = Math.max(1, ...days.map((x) => d.perDay.get(dayKey(x)) ?? 0))
  const total = days.reduce((n, x) => n + (d.perDay.get(dayKey(x)) ?? 0), 0)
  return (
    <Card title="This week" action={<span className="xs dim num">{duration(total)}</span>}>
      <div className="bars mini">
        {days.map((day) => {
          const sec = d.perDay.get(dayKey(day)) ?? 0
          return (
            <div className="col" key={dayKey(day)} title={`${format(day, 'EEE d MMM')}: ${duration(sec)}`}>
              <div className={`b ${sec ? '' : 'zero'}`} style={{ height: `${Math.max(3, (sec / max) * 100)}%` }} />
              <span className="l">{format(day, 'EEEEE')}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function StreakWidget({ d }: { d: TodayData }) {
  return (
    <Card title="Streak">
      <div className="row" style={{ gap: 12 }}>
        <span className="streak-flame" data-on={d.streak > 0}>
          <Flame size={26} />
        </span>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1 }} className="num">
            {d.streak} {d.streak === 1 ? 'day' : 'days'}
          </div>
          <div className="xs dim">{d.perDay.has(todayKey()) ? 'You’ve studied today.' : d.streak ? 'Study today to keep it going.' : 'Study today to start one.'}</div>
        </div>
      </div>
    </Card>
  )
}

function NotesWidget({ d }: { d: TodayData }) {
  const { go } = useNav()
  const list = d.notes.slice(0, 4)
  return (
    <Card title="Recent notes" flush action={<button className="linkbtn xs" onClick={() => go({ name: 'notes' })}>All notes</button>}>
      {list.length ? (
        <div className="ig plain">
          {list.map((n: Rec<'note'>) => (
            <button key={n.id} className="ig-row tap" onClick={() => go({ name: 'notes', noteId: n.id })}>
              <span className="note-row-icon" style={{ width: 28, height: 28, fontSize: 15 }}>{n.data.icon ?? <NotebookPen size={14} />}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ig-title trunc" style={{ display: 'block' }}>{n.data.title || 'Untitled'}</span>
                <span className="ig-sub trunc" style={{ display: 'block' }}>{formatDistanceToNowStrict(n.updatedAt, { addSuffix: true })}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="w-empty">No notes yet.</p>
      )}
    </Card>
  )
}

function QuickAddWidget() {
  const { s } = useSettings()
  const toast = useToast()
  const [title, setTitle] = useState('')
  return (
    <form
      className="w-quick"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!title.trim()) return
        await db.put('task', { title: title.trim(), subjectId: null, done: false, completedAt: null, due: defaultDueDate(s.defaultDue), priority: s.defaultPriority })
        setTitle('')
        toast('Task added')
      }}
    >
      <Plus size={18} className="dim" />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task and press Enter" aria-label="Quick add a task" />
    </form>
  )
}

function Widget({ id, d }: { id: WidgetId; d: TodayData }) {
  switch (id) {
    case 'stats':
      return <StatsWidget d={d} />
    case 'due':
      return <DueWidget d={d} />
    case 'upcoming':
      return <UpcomingWidget d={d} />
    case 'schedule':
      return <ScheduleWidget d={d} />
    case 'focus':
      return <FocusWidget d={d} />
    case 'subjects':
      return <SubjectsWidget d={d} />
    case 'goal':
      return <GoalWidget d={d} />
    case 'week':
      return <WeekWidget d={d} />
    case 'streak':
      return <StreakWidget d={d} />
    case 'notes':
      return <NotesWidget d={d} />
    case 'quickadd':
      return <QuickAddWidget />
  }
}

/* ---------- the page ---------- */
export function Today({ startEditing = false }: { startEditing?: boolean }) {
  const { s, set } = useSettings()
  const d = useTodayData()
  const user = useAccount().state.user
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(startEditing)
  const [dragId, setDragId] = useState<WidgetId | null>(null)
  const [overId, setOverId] = useState<WidgetId | 'end' | null>(null)
  const layout = s.todayLayout
  const firstName = (s.name.trim() || user?.displayName || '').split(/\s+/)[0]
  const hidden = (Object.keys(DEFS) as WidgetId[]).filter((id) => !layout.some((w) => w.id === id))

  const save = (next: WidgetSlot[]) => set({ todayLayout: next })
  const move = (from: number, to: number) => {
    if (to < 0 || to >= layout.length || from === to) return
    const next = [...layout]
    const [w] = next.splice(from, 1)
    next.splice(to, 0, w)
    save(next)
  }
  const dropOn = (target: WidgetId | 'end') => {
    if (!dragId || dragId === target) return
    const next = layout.filter((w) => w.id !== dragId)
    const w = layout.find((x) => x.id === dragId)!
    const at = target === 'end' ? next.length : next.findIndex((x) => x.id === target)
    next.splice(at, 0, w)
    save(next)
  }

  return (
    <div className={`inner view today ${editing ? 'editing' : ''}`}>
      <div className="topbar">
        <div>
          <h1>{s.greeting ? `${greeting()}${firstName ? `, ${firstName}` : ''}` : format(new Date(), 'EEEE')}</h1>
          <p className="dim">{format(new Date(), s.greeting ? 'EEEE d MMMM' : 'd MMMM yyyy')}</p>
        </div>
        <div className="row">
          {editing ? (
            <>
              <button className="btn ghost" onClick={() => save(defaultLayout())} title="Back to the original widgets">
                <RotateCcw size={14} /> Reset
              </button>
              <button className="btn" onClick={() => setEditing(false)}>
                Done
              </button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => setEditing(true)}>
                <LayoutGrid size={15} /> Customize
              </button>
              <button className="btn" onClick={() => setAdding(true)}>
                <Plus size={16} /> New task
              </button>
            </>
          )}
        </div>
      </div>

      {editing && <p className="w-hint">Drag widgets to move them, pick a size, or remove them. Add more from the list below.</p>}

      <div className="w-grid">
        {layout.map((w, i) => {
          const def = DEFS[w.id]
          return (
            <div
              key={w.id}
              className={`w-slot size-${w.size} ${dragId === w.id ? 'dragging' : ''} ${overId === w.id && dragId !== w.id ? 'over' : ''}`}
              draggable={editing}
              onDragStart={(e) => {
                setDragId(w.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', w.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setOverId(w.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                dropOn(w.id)
                setDragId(null)
                setOverId(null)
              }}
            >
              {editing && (
                <div className="w-tools">
                  <span className="w-grip" title="Drag to move" aria-hidden="true">
                    <GripVertical size={15} />
                  </span>
                  <span className="w-name">{def.title}</span>
                  <span className="grow" />
                  <div className="w-sizes" role="radiogroup" aria-label={`${def.title} size`}>
                    {def.sizes.map((sz) => (
                      <button
                        key={sz}
                        role="radio"
                        aria-checked={w.size === sz}
                        title={SIZE_LABEL[sz]}
                        onClick={() => save(layout.map((x) => (x.id === w.id ? { ...x, size: sz } : x)))}
                      >
                        {sz.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <button className="w-icon" aria-label={`Move ${def.title} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="w-icon" aria-label={`Move ${def.title} later`} disabled={i === layout.length - 1} onClick={() => move(i, i + 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button className="w-icon danger" aria-label={`Remove ${def.title}`} onClick={() => save(layout.filter((x) => x.id !== w.id))}>
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className="w-content" inert={editing || undefined}>
                <Widget id={w.id} d={d} />
              </div>
            </div>
          )
        })}
        {editing && dragId && (
          <div
            className={`w-slot size-xl w-dropend ${overId === 'end' ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOverId('end')
            }}
            onDrop={(e) => {
              e.preventDefault()
              dropOn('end')
              setDragId(null)
              setOverId(null)
            }}
          >
            Drop here to move to the end
          </div>
        )}
      </div>

      {!layout.length && !editing && (
        <div className="card">
          <Empty
            icon={LayoutGrid}
            title="Your Today page is empty"
            text="Add widgets to see your tasks, timer and progress here."
            action={
              <button className="btn" onClick={() => setEditing(true)}>
                Customize
              </button>
            }
          />
        </div>
      )}

      {editing && (
        <div className="w-gallery">
          <h2>Add widgets</h2>
          {hidden.length ? (
            <div className="w-gallery-grid">
              {hidden.map((id) => {
                const def = DEFS[id]
                return (
                  <button key={id} className="w-add" onClick={() => save([...layout, { id, size: def.defaultSize }])}>
                    <span className="w-add-icon">
                      <def.icon size={18} />
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <b>{def.title}</b>
                      <span>{def.description}</span>
                    </span>
                    <span className="w-add-plus">
                      <Plus size={16} />
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="sm dim">Every widget is on your page.</p>
          )}
        </div>
      )}

      {adding && <TaskDialog onClose={() => setAdding(false)} />}
    </div>
  )
}
