import { useEffect, useRef, useState } from 'react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Rec } from '@shared/types'
import { useRecords } from '../data/store'
import { dayKey, todayKey } from '../lib/dates'
import { TaskDialog } from '../components/editors'
import { eventDays, prefetchEvents, useGoogleEvents } from '../data/google'
import type { GoogleEvent } from '@shared/types'
import { useSettings, useTimeFormat } from '../data/settings'
import { EventDialog } from '../components/EventDialog'
import { DayCard } from '../components/DayCard'

/** The days a month view shows: whole weeks around the month (end exclusive). */
export function monthRange(month: Date, weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6): [Date, Date] {
  return [startOfWeek(startOfMonth(month), { weekStartsOn }), addDays(endOfWeek(endOfMonth(month), { weekStartsOn }), 1)]
}

/** Fetches this month's events early (at start-up), so the calendar opens with them. */
export function usePrefetchCalendar(weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6, on: boolean): void {
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => prefetchEvents(...monthRange(new Date(), weekStartsOn)), 1500)
    return () => clearTimeout(t)
  }, [weekStartsOn, on])
}

export function Calendar() {
  const { items: allTasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  // Archived subjects keep their tasks out of sight here too, as on Today and Tasks.
  const archived = new Set(subjects.filter((x) => x.data.archived).map((x) => x.id))
  const tasks = allTasks.filter((t) => !t.data.subjectId || !archived.has(t.data.subjectId))
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [newOn, setNewOn] = useState<{ due: string; title?: string } | null>(null)
  const [editing, setEditing] = useState<Rec<'task'> | null>(null)
  const { s } = useSettings()
  const fmtTime = useTimeFormat()

  const start = startOfWeek(month, { weekStartsOn: s.weekStart })
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: s.weekStart })
  const days: Date[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)

  const { events, error } = useGoogleEvents(start, addDays(end, 1))
  // The months either side, ready before you go there.
  useEffect(() => {
    const t = setTimeout(() => {
      prefetchEvents(...monthRange(addMonths(month, 1), s.weekStart))
      prefetchEvents(...monthRange(addMonths(month, -1), s.weekStart))
    }, 300)
    return () => clearTimeout(t)
  }, [month, s.weekStart])
  const eventsByDay = new Map<string, GoogleEvent[]>()
  if (s.calendarShowEvents) events.forEach((e) => eventDays(e).forEach((k) => eventsByDay.set(k, [...(eventsByDay.get(k) ?? []), e])))
  const [openEvent, setOpenEvent] = useState<GoogleEvent | null>(null)
  const [openDay, setOpenDay] = useState<{ day: string; from: DOMRect | null } | null>(null)
  const showDay = (day: string, el?: Element | null) => setOpenDay({ day, from: el?.getBoundingClientRect() ?? null })

  const byDay = new Map<string, Rec<'task'>[]>()
  tasks.forEach((t) => s.calendarShowTasks && (s.calendarShowDone || !t.data.done) && t.data.due && byDay.set(t.data.due, [...(byDay.get(t.data.due) ?? []), t]))
  const color = (t: Rec<'task'>) => subjects.find((s) => s.id === t.data.subjectId)?.data.color ?? 'var(--label-tertiary)'
  const today = todayKey()

  // How many entries fit in a day: the month fills the window, so it depends on the window's height.
  const grid = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(3)
  const weeks = Math.ceil(days.length / 7)
  useEffect(() => {
    const el = grid.current
    if (!el) return
    const measure = () => {
      const head = el.querySelector<HTMLElement>('.dow')?.offsetHeight ?? 28
      const row = (el.clientHeight - head) / weeks
      // day number ~28px, each line ~19px
      setFit(Math.max(1, Math.floor((row - 30) / 19)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [weeks])

  return (
    <div className="view cal-view">
      <div className="topbar cal-top">
        <h1>
          {format(month, 'MMMM')} <span className="cal-year">{format(month, 'yyyy')}</span>
        </h1>
        <div className="cal-nav" role="group" aria-label="Month">
          <button className="cal-nav-btn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={16} />
          </button>
          <button className="cal-nav-btn today" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </button>
          <button className="cal-nav-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="cal" ref={grid}>
        {days.slice(0, 7).map((d) => format(d, 'EEE')).map((d) => (
          <div key={d} className="dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = dayKey(d)
          const list = byDay.get(key) ?? []
          const dayEvents = eventsByDay.get(key) ?? []
          // All-day first, then by time, then tasks; as many as fit (keeping a line for "+ more").
          const ordered = [...dayEvents].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
          const total = ordered.length + list.length
          const room = total > fit ? Math.max(0, fit - 1) : fit
          const shownEvents = ordered.slice(0, room)
          const shownTasks = list.slice(0, Math.max(0, room - shownEvents.length))
          const hidden = total - shownEvents.length - shownTasks.length
          return (
            <div
              key={key}
              className={`cell ${isSameMonth(d, month) ? '' : 'out'} ${key === today ? 'today' : ''}`}
              onClick={(e) => showDay(key, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  showDay(key, e.currentTarget)
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${format(d, 'd MMMM')}: ${list.length} tasks, ${dayEvents.length} events. Open the day.`}
            >
              <span className="d">{format(d, 'd')}</span>
              {shownEvents.map((e) => (
                <span
                  key={e.id}
                  className={`chip ev-line ${e.allDay ? 'allday' : ''}`}
                  style={{ ['--ev' as string]: e.color }}
                  title={`${e.allDay ? '' : fmtTime(new Date(e.start)) + ' '}${e.title} · ${e.calendar}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setOpenEvent(e)
                  }}
                >
                  {!e.allDay && <i className="ev-dot" />}
                  <span className="ev-title">{e.title}</span>
                  {!e.allDay && <span className="ev-time">{fmtTime(new Date(e.start))}</span>}
                </span>
              ))}
              {shownTasks.map((t) => (
                <span
                  key={t.id}
                  className={`chip ev-line task ${t.data.done ? 'done' : ''}`}
                  style={{ ['--ev' as string]: color(t) }}
                  title={t.data.title}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing(t)
                  }}
                >
                  <i className="ev-box" />
                  <span className="ev-title">{t.data.title}</span>
                </span>
              ))}
              {hidden > 0 && (
                <button
                  className="more-chip"
                  onClick={(e) => {
                    e.stopPropagation()
                    showDay(key, e.currentTarget.closest('.cell'))
                  }}
                >
                  +{hidden} more
                </button>
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="sm cal-hint" style={{ color: 'var(--bad)' }}>{error}</p>}
      {openEvent && <EventDialog event={openEvent} onClose={() => setOpenEvent(null)} />}
      {openDay && (
        <DayCard
          day={openDay.day}
          from={openDay.from}
          events={eventsByDay.get(openDay.day) ?? []}
          tasks={tasks.filter((t) => t.data.due === openDay.day && (s.calendarShowDone || !t.data.done))}
          color={color}
          subjectName={(t) => subjects.find((x) => x.id === t.data.subjectId)?.data.name}
          onDay={(day) => setOpenDay({ day, from: null })}
          onEvent={setOpenEvent}
          onTask={setEditing}
          onNewTask={(title) => setNewOn({ due: openDay.day, title })}
          onClose={() => setOpenDay(null)}
        />
      )}
      {newOn && <TaskDialog defaults={{ due: newOn.due, ...(newOn.title ? { title: newOn.title } : {}) }} onClose={() => setNewOn(null)} />}
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
