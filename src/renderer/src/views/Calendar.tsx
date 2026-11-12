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
import { EventDialog, useEventTime } from '../components/EventDialog'
import { Dialog } from '../components/ui'
import { Plus } from 'lucide-react'

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
  const [openDay, setOpenDay] = useState<string | null>(null)
  const range = useEventTime()

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
          const dayEvents = eventsByDay.get(key) ?? []
          const hidden = Math.max(0, dayEvents.length - 3) + Math.max(0, list.length - 4)
          return (
            <div
              key={key}
              className={`cell ${isSameMonth(d, month) ? '' : 'out'} ${key === today ? 'today' : ''}`}
              onClick={() => setNewOn(key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (list.length || dayEvents.length) setOpenDay(key)
                  else setNewOn(key)
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${format(d, 'd MMMM')}: ${list.length} tasks, ${dayEvents.length} events. Press Enter to see the day.`}
            >
              <span className="d">{format(d, 'd')}</span>
              {dayEvents.slice(0, 3).map((e) => (
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
              {hidden > 0 && (
                <button
                  className="more-chip"
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenDay(key)
                  }}
                >
                  +{hidden} more
                </button>
              )}
            </div>
          )
        })}
      </div>
      <p className="sm dim cal-hint">
        Click a day to add a task due then, or “+ more” to see everything on it.{' '}
        {s.calendarShowEvents && events.length > 0 && 'Google Calendar events show in their calendar’s colour.'}
        {error && <span style={{ color: 'var(--bad)' }}> {error}</span>}
      </p>
      {openEvent && <EventDialog event={openEvent} onClose={() => setOpenEvent(null)} />}
      {openDay && (
        <Dialog title={format(new Date(openDay + 'T00:00:00'), 'EEEE d MMMM')} onClose={() => setOpenDay(null)}>
          {(eventsByDay.get(openDay) ?? []).length > 0 && (
            <>
              <h2>Events</h2>
              <div className="ig plain day-list">
                {(eventsByDay.get(openDay) ?? []).map((e) => (
                  <button key={e.id} className="ig-row tap" onClick={() => { setOpenDay(null); setOpenEvent(e) }}>
                    <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: e.color }} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ig-title trunc" style={{ display: 'block' }}>{e.title}</span>
                      <span className="ig-sub">{range(e)} · {e.calendar}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {(byDay.get(openDay) ?? []).length > 0 && (
            <>
              <h2 style={{ marginTop: 14 }}>Tasks due</h2>
              <div className="ig plain day-list">
                {(byDay.get(openDay) ?? []).map((t) => (
                  <button key={t.id} className={`ig-row tap ${t.data.done ? 'task-done' : ''}`} onClick={() => { setOpenDay(null); setEditing(t) }}>
                    <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: color(t) }} />
                    <span className="ig-title grow trunc">{t.data.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="actions">
            <button className="btn" onClick={() => { setNewOn(openDay); setOpenDay(null) }}>
              <Plus size={15} /> Add a task due this day
            </button>
          </div>
        </Dialog>
      )}
      {newOn && <TaskDialog defaults={{ due: newOn }} onClose={() => setNewOn(null)} />}
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
