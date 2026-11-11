import { useState } from 'react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Rec } from '@shared/types'
import { useRecords } from '../data/store'
import { dayKey, todayKey } from '../lib/dates'
import { TaskDialog } from '../components/editors'
import { eventDays, useGoogleEvents } from '../data/google'
import type { GoogleEvent } from '@shared/types'
import { useSettings, useTimeFormat } from '../data/settings'

export function Calendar() {
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [newOn, setNewOn] = useState<string | null>(null)
  const [editing, setEditing] = useState<Rec<'task'> | null>(null)
  const { s } = useSettings()
  const fmtTime = useTimeFormat()

  const start = startOfWeek(month, { weekStartsOn: s.weekStart })
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: s.weekStart })
  const days: Date[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)

  const { events, error } = useGoogleEvents(start, addDays(end, 1))
  const eventsByDay = new Map<string, GoogleEvent[]>()
  if (s.calendarShowEvents) events.forEach((e) => eventDays(e).forEach((k) => eventsByDay.set(k, [...(eventsByDay.get(k) ?? []), e])))
  const [openEvent, setOpenEvent] = useState<GoogleEvent | null>(null)

  const byDay = new Map<string, Rec<'task'>[]>()
  tasks.forEach((t) => s.calendarShowTasks && (s.calendarShowDone || !t.data.done) && t.data.due && byDay.set(t.data.due, [...(byDay.get(t.data.due) ?? []), t]))
  const color = (t: Rec<'task'>) => subjects.find((s) => s.id === t.data.subjectId)?.data.color ?? 'var(--label-tertiary)'
  const today = todayKey()

  return (
    <div className="view" style={{ maxWidth: 1300, margin: '0 auto' }}>
      <div className="topbar">
        <h1>{format(month, 'MMMM yyyy')}</h1>
        <div className="row">
          <button className="btn sec sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </button>
          <button className="iconbtn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={17} />
          </button>
          <button className="iconbtn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <div className="cal">
        {days.slice(0, 7).map((d) => format(d, 'EEE')).map((d) => (
          <div key={d} className="dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = dayKey(d)
          const list = byDay.get(key) ?? []
          return (
            <div
              key={key}
              className={`cell ${isSameMonth(d, month) ? '' : 'out'} ${key === today ? 'today' : ''}`}
              onClick={() => setNewOn(key)}
              role="button"
              tabIndex={0}
              aria-label={`${format(d, 'd MMMM')}, ${list.length} tasks. Add a task.`}
            >
              <span className="d">{format(d, 'd')}</span>
              {(eventsByDay.get(key) ?? []).slice(0, 3).map((e) => (
                <span
                  key={e.id}
                  className={`chip gev ${e.allDay ? 'allday' : ''}`}
                  style={{ ['--ev' as string]: e.color }}
                  title={`${e.title} · ${e.calendar}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setOpenEvent(e)
                  }}
                >
                  {!e.allDay && <b>{fmtTime(new Date(e.start))}</b>} {e.title}
                </span>
              ))}
              {list.slice(0, 4).map((t) => (
                <span
                  key={t.id}
                  className={`chip ${t.data.done ? 'done' : ''}`}
                  style={{ borderLeftColor: color(t) }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing(t)
                  }}
                >
                  {t.data.title}
                </span>
              ))}
              {list.length > 4 && <span className="xs dim">+{list.length - 4} more</span>}
            </div>
          )
        })}
      </div>
      <p className="sm dim">
        Click a day to add a task due then.{' '}
        {s.calendarShowEvents && events.length > 0 && 'Google Calendar events show in their calendar’s colour.'}
        {error && <span style={{ color: 'var(--bad)' }}> {error}</span>}
      </p>
      {openEvent && (
        <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpenEvent(null)}>
          <div className="dialog" role="dialog" aria-label={openEvent.title}>
            <div className="row" style={{ gap: 10, marginBottom: 6 }}>
              <span style={{ width: 12, height: 12, borderRadius: 4, background: openEvent.color }} />
              <span className="sm dim">{openEvent.calendar}</span>
            </div>
            <h3 style={{ fontSize: 20, fontWeight: 800 }}>{openEvent.title}</h3>
            <p className="dim" style={{ margin: '6px 0 0' }}>
              {openEvent.allDay
                ? format(new Date(openEvent.start + 'T00:00:00'), 'EEEE d MMMM')
                : `${format(new Date(openEvent.start), 'EEEE d MMMM')}, ${fmtTime(new Date(openEvent.start))} – ${fmtTime(new Date(openEvent.end))}`}
            </p>
            {openEvent.location && <p className="sm" style={{ margin: '8px 0 0' }}>{openEvent.location}</p>}
            <div className="actions">
              {openEvent.link && (
                <button className="btn sec" onClick={() => window.veyra.open(openEvent.link)}>
                  Open in Google Calendar
                </button>
              )}
              <button className="btn" onClick={() => setOpenEvent(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      {newOn && <TaskDialog defaults={{ due: newOn }} onClose={() => setNewOn(null)} />}
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
