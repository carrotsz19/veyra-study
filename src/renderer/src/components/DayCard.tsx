import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { addDays, format } from 'date-fns'
import { Check, ChevronLeft, ChevronRight, MapPin, Plus, Sun } from 'lucide-react'
import type { GoogleEvent, Rec } from '@shared/types'
import { db } from '../data/store'
import { dayKey, todayKey } from '../lib/dates'
import { useSettings, useTimeFormat } from '../data/settings'
import { useExit } from '../lib/motion'
import { usePhone } from '../lib/phone'
import { toggleTask } from './TaskList'
import { useToast } from './ui'

/**
 * One day of the calendar, as a card that springs open from the day you
 * tapped: its events and tasks in time order, a box to add a task on that
 * day, and a swipe (or ← →) to the day before or after.
 */
export function DayCard({
  day,
  from,
  events,
  tasks,
  color,
  subjectName,
  onDay,
  onEvent,
  onTask,
  onNewTask,
  onClose
}: {
  day: string
  /** Where it grows from (the tapped day), in window pixels. */
  from: DOMRect | null
  events: GoogleEvent[]
  tasks: Rec<'task'>[]
  color: (t: Rec<'task'>) => string
  subjectName: (t: Rec<'task'>) => string | undefined
  onDay: (day: string) => void
  onEvent: (e: GoogleEvent) => void
  onTask: (t: Rec<'task'>) => void
  /** The full new-task form, for this day (with what was typed so far). */
  onNewTask: (title: string) => void
  onClose: () => void
}) {
  const fmt = useTimeFormat()
  const phone = usePhone()
  const toast = useToast()
  const date = new Date(day + 'T00:00:00')
  const [text, setText] = useState('')
  const scrim = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useExit(scrim)

  // Grow out of the day that was tapped.
  useLayoutEffect(() => {
    const el = card.current
    if (!el || !from) return
    const r = el.getBoundingClientRect()
    el.style.transformOrigin = `${from.left + from.width / 2 - r.left}px ${from.top + from.height / 2 - r.top}px`
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Another day: the list slides in from the side it came from.
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null)
  const go = (by: 1 | -1) => {
    setSlide(by > 0 ? 'next' : 'prev')
    onDay(dayKey(addDays(date, by)))
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea')
      if (e.key === 'Escape') onClose()
      else if (!typing && e.key === 'ArrowRight') go(1)
      else if (!typing && e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Swiping sideways on the list (phone): it follows your finger, then moves on a day.
  const swipe = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => (swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, dx: 0, on: false })
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current
    if (!s || !body.current) return
    const dx = e.touches[0].clientX - s.x
    const dy = e.touches[0].clientY - s.y
    if (!s.on && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) s.on = true
    if (!s.on) return
    s.dx = dx
    body.current.style.transition = 'none'
    body.current.style.transform = `translateX(${dx * 0.9}px)`
    body.current.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 500))
  }
  const onTouchEnd = () => {
    const s = swipe.current
    swipe.current = null
    if (!body.current) return
    body.current.style.transition = ''
    body.current.style.transform = ''
    body.current.style.opacity = ''
    if (s?.on && Math.abs(s.dx) > 70) go(s.dx < 0 ? 1 : -1)
  }

  const { s: settings } = useSettings()
  const add = async () => {
    const title = text.trim()
    if (!title) return onNewTask('')
    await db.put('task', { title, subjectId: null, done: false, completedAt: null, due: day, priority: settings.defaultPriority })
    setText('')
    toast(`Added “${title}” on ${format(date, 'd MMM')}`)
  }
  const tick = async (t: Rec<'task'>) => {
    const next = await toggleTask(t)
    if (next) toast(`Next one: ${format(new Date(next + 'T00:00:00'), 'EEE d MMM')}`)
  }

  // All-day first, then by time; tasks after (a reminder time puts one among the events).
  const allDay = events.filter((e) => e.allDay)
  const timed = [...events.filter((e) => !e.allDay)].sort((a, b) => a.start.localeCompare(b.start))
  const taskTime = (t: Rec<'task'>) => (t.data.remindAt?.startsWith(day) ? t.data.remindAt.slice(11) : null)
  type Row = { at: string; node: React.ReactNode }
  const rows: Row[] = [
    ...timed.map((e) => ({
      at: format(new Date(e.start), 'HH:mm'),
      node: (
        <button key={e.id} className="dc-row" onClick={() => onEvent(e)}>
          <span className="dc-time">{fmt(new Date(e.start))}</span>
          <span className="dc-bar" style={{ background: e.color }} />
          <span className="dc-main">
            <span className="dc-title">{e.title}</span>
            <span className="dc-sub">
              {fmt(new Date(e.start))} – {fmt(new Date(e.end))}
              {e.location && (
                <>
                  {'  '}
                  <MapPin size={12} /> {e.location}
                </>
              )}
            </span>
          </span>
        </button>
      )
    })),
    ...tasks
      .filter((t) => taskTime(t))
      .map((t) => ({ at: taskTime(t)!, node: taskRow(t, taskTime(t)) }))
  ].sort((a, b) => a.at.localeCompare(b.at))
  const untimed = tasks.filter((t) => !taskTime(t)).sort((a, b) => Number(a.data.done) - Number(b.data.done))

  function taskRow(t: Rec<'task'>, at: string | null) {
    return (
      <div key={t.id} className={`dc-row task ${t.data.done ? 'done' : ''}`}>
        <span className="dc-time">
          {at ? fmt(new Date(`${day}T${at}`)) : null}
          <button className={`dc-check ${t.data.done ? 'on' : ''}`} style={{ ['--c' as string]: color(t) }} aria-label={t.data.done ? 'Not done' : 'Done'} onClick={() => tick(t)}>
            {t.data.done && <Check size={12} strokeWidth={3} />}
          </button>
        </span>
        <span className="dc-bar" style={{ background: color(t) }} />
        <button className="dc-main" onClick={() => onTask(t)}>
          <span className="dc-title">{t.data.title}</span>
          <span className="dc-sub">{subjectName(t) ?? 'Task'}</span>
        </button>
      </div>
    )
  }

  const rel = day === todayKey() ? 'Today' : day === dayKey(addDays(new Date(), 1)) ? 'Tomorrow' : day === dayKey(addDays(new Date(), -1)) ? 'Yesterday' : null
  const empty = !events.length && !tasks.length
  return (
    <div ref={scrim} className="scrim day-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={card} className="day-card" role="dialog" aria-modal="true" aria-label={format(date, 'EEEE d MMMM')}>
        <div className="dc-head">
          <span className={`dc-badge ${day === todayKey() ? 'today' : ''}`}>{format(date, 'd')}</span>
          <span className="dc-weekday">
            {format(date, 'EEEE')}
            <span className="dc-date">
              {rel ? `${rel} · ` : ''}
              {format(date, 'd MMMM yyyy')}
            </span>
          </span>
          {!phone && (
            <span className="dc-nav">
              <button className="iconbtn plain" aria-label="Day before" onClick={() => go(-1)}>
                <ChevronLeft size={18} />
              </button>
              <button className="iconbtn plain" aria-label="Day after" onClick={() => go(1)}>
                <ChevronRight size={18} />
              </button>
            </span>
          )}
        </div>
        <div className="dc-scroll" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
          <div ref={body} key={day} className={`dc-body ${slide ? `slide-${slide}` : ''}`}>
            {allDay.map((e) => (
              <button key={e.id} className="dc-allday" style={{ ['--ev' as string]: e.color }} onClick={() => onEvent(e)}>
                <Sun size={13} /> <span className="trunc">{e.title}</span>
              </button>
            ))}
            {rows.map((r) => r.node)}
            {untimed.length > 0 && rows.length > 0 && <div className="dc-sep">Tasks</div>}
            {untimed.map((t) => taskRow(t, null))}
            {empty && (
              <div className="dc-empty">
                <span className="dc-empty-icon">☀︎</span>
                Nothing on this day.
              </div>
            )}
          </div>
        </div>
        <form
          className="dc-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add on ${format(date, 'd MMM')}`} aria-label={`Add a task on ${format(date, 'd MMMM')}`} />
          <button type="submit" className="dc-plus" aria-label={text.trim() ? 'Add task' : 'New task with details'}>
            <Plus size={22} />
          </button>
        </form>
      </div>
    </div>
  )
}
