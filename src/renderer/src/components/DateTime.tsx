import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, parseISO, startOfMonth, startOfWeek } from 'date-fns'
import { Popover } from './Popover'
import { useSettings } from '../data/settings'
import { dayKey, todayKey } from '../lib/dates'

/**
 * Veyra's own date and time pickers, in place of the system ones (which
 * don't follow the app's look). A date opens a month calendar with quick
 * picks (Today, Tomorrow, Next week); a time opens a list of times every
 * 15 minutes, and you can type any time ("7:30 pm", "1930").
 */

/** "Today", "Tomorrow", "Yesterday", "Thu 12 Nov", or with the year when it isn't this one. */
export function dayLabel(day: string): string {
  const d = parseISO(day)
  const t = todayKey()
  if (day === t) return 'Today'
  if (day === dayKey(addDays(parseISO(t), 1))) return 'Tomorrow'
  if (day === dayKey(addDays(parseISO(t), -1))) return 'Yesterday'
  return format(d, d.getFullYear() === new Date().getFullYear() ? 'EEE d MMM' : 'EEE d MMM yyyy')
}

export function timeLabel(hhmm: string, h12: boolean): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (!h12) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** Reads "7", "7:30", "730", "1930", "7.30pm", "7 pm" into "HH:MM" (or null). */
export function parseTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '')
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = m[3]?.[0]
  if (ap === 'p' && h < 12) h += 12
  if (ap === 'a' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** The month grid, with quick picks above it. */
function Calendar({ value, onPick, onClear }: { value: string | null; onPick: (day: string) => void; onClear?: () => void }) {
  const { s } = useSettings()
  const [month, setMonth] = useState(() => startOfMonth(value ? parseISO(value) : new Date()))
  const [dir, setDir] = useState<0 | 1 | -1>(0)
  const today = todayKey()
  const days = useMemo(() => {
    const out: Date[] = []
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: s.weekStart })
    for (let d = startOfWeek(month, { weekStartsOn: s.weekStart }); d <= end; d = addDays(d, 1)) out.push(d)
    while (out.length < 42) out.push(addDays(out[out.length - 1], 1))
    return out
  }, [month, s.weekStart])
  const step = (by: 1 | -1) => {
    setDir(by)
    setMonth((m) => addMonths(m, by))
  }
  const nextMonday = dayKey(addDays(parseISO(today), ((8 - parseISO(today).getDay()) % 7) || 7))
  const quick: [string, string][] = [
    ['Today', today],
    ['Tomorrow', dayKey(addDays(parseISO(today), 1))],
    ['Next week', nextMonday]
  ]
  // Arrow keys move the focused day.
  const grid = useRef<HTMLDivElement>(null)
  const [focusDay, setFocusDay] = useState(value ?? today)
  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true })
  }, [focusDay, month])
  const onKey = (e: React.KeyboardEvent) => {
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (!by) return
    e.preventDefault()
    const next = dayKey(addDays(parseISO(focusDay), by))
    if (!isSameMonth(parseISO(next), month)) step(next > focusDay ? 1 : -1)
    setFocusDay(next)
  }
  return (
    <div className="dp">
      <div className="dp-quick">
        {quick.map(([l, d]) => (
          <button key={l} type="button" className={`dp-chip ${value === d ? 'on' : ''}`} onClick={() => onPick(d)}>
            {l}
          </button>
        ))}
        {onClear && value && (
          <button type="button" className="dp-chip clear" onClick={onClear}>
            <X size={12} /> No date
          </button>
        )}
      </div>
      <div className="dp-head">
        <b>{format(month, 'MMMM yyyy')}</b>
        <span className="grow" />
        <button type="button" className="iconbtn plain dp-nav" aria-label="Previous month" onClick={() => step(-1)}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" className="iconbtn plain dp-nav" aria-label="Next month" onClick={() => step(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="dp-dow" aria-hidden>
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()}>{format(d, 'EEEEE')}</span>
        ))}
      </div>
      <div ref={grid} key={dayKey(month)} className={`dp-grid ${dir > 0 ? 'from-right' : dir < 0 ? 'from-left' : ''}`} role="grid" onKeyDown={onKey}>
        {days.map((d) => {
          const k = dayKey(d)
          return (
            <button
              key={k}
              type="button"
              data-day={k}
              tabIndex={k === focusDay ? 0 : -1}
              className={`dp-day ${isSameMonth(d, month) ? '' : 'out'} ${k === today ? 'today' : ''} ${k === value ? 'on' : ''}`}
              aria-pressed={k === value}
              aria-label={format(d, 'EEEE d MMMM yyyy')}
              onClick={() => onPick(k)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Every 15 minutes, with the chosen (or nearest) time scrolled into view; or type one. */
function TimeList({ value, onPick }: { value: string | null; onPick: (t: string) => void }) {
  const { s } = useSettings()
  const h12 = s.timeFormat === '12h'
  const list = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const slots = useMemo(() => Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`), [])
  const near = useMemo(() => {
    const now = new Date()
    const [h, m] = (value ?? `${now.getHours()}:${now.getMinutes()}`).split(':').map(Number)
    return slots[Math.min(95, Math.round((h * 60 + m) / 15))]
  }, [value, slots])
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-t="${near}"]`)
    if (el && list.current) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 2 + el.offsetHeight / 2
  }, [near])
  const parsed = parseTime(typed)
  return (
    <div className="tp">
      <input
        className="tp-type"
        placeholder={h12 ? 'Type a time, e.g. 7:45 pm' : 'Type a time, e.g. 19:45'}
        value={typed}
        aria-label="Type a time"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (parsed) onPick(parsed)
          }
        }}
      />
      {typed && (
        <button type="button" className="tp-slot typed" disabled={!parsed} onClick={() => parsed && onPick(parsed)}>
          {parsed ? `Use ${timeLabel(parsed, h12)}` : 'That isn’t a time'}
        </button>
      )}
      <div ref={list} className="tp-list" role="listbox" aria-label="Times">
        {slots.map((t) => (
          <button key={t} type="button" data-t={t} role="option" aria-selected={t === value} className={`tp-slot ${t === value ? 'on' : ''}`} onClick={() => onPick(t)}>
            {timeLabel(t, h12)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A date: "YYYY-MM-DD" or null. */
export function DateField({ value, onChange, label, id, clearable = true, placeholder = 'No date', className = '' }: { value: string | null; onChange: (v: string | null) => void; label: string; id?: string; clearable?: boolean; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)
  return (
    <>
      <button ref={btn} id={id} type="button" className={`sel dt-btn ${open ? 'open' : ''} ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${value ? dayLabel(value) : placeholder}`} onClick={() => setOpen(!open)}>
        <CalendarDays size={15} className="dim" />
        <span className={`sel-value ${value ? '' : 'placeholder'}`}>{value ? dayLabel(value) : placeholder}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={close} label={label}>
        <Calendar
          value={value}
          onPick={(d) => {
            onChange(d)
            close()
            btn.current?.focus({ preventScroll: true })
          }}
          onClear={clearable ? () => (onChange(null), close()) : undefined}
        />
      </Popover>
    </>
  )
}

/** A time of day: "HH:MM" or null. */
export function TimeField({ value, onChange, label, id, placeholder = 'Any time', disabled, className = '' }: { value: string | null; onChange: (v: string) => void; label: string; id?: string; placeholder?: string; disabled?: boolean; className?: string }) {
  const { s } = useSettings()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = () => setOpen(false)
  return (
    <>
      <button ref={btn} id={id} type="button" disabled={disabled} className={`sel dt-btn ${open ? 'open' : ''} ${className}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${value ? timeLabel(value, s.timeFormat === '12h') : placeholder}`} onClick={() => setOpen(!open)}>
        <Clock size={15} className="dim" />
        <span className={`sel-value ${value ? '' : 'placeholder'}`}>{value ? timeLabel(value, s.timeFormat === '12h') : placeholder}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={close} label={label} className="tp-pop">
        <TimeList
          value={value}
          onPick={(t) => {
            onChange(t)
            close()
            btn.current?.focus({ preventScroll: true })
          }}
        />
      </Popover>
    </>
  )
}

/** A moment: "YYYY-MM-DDTHH:MM" or null (reminders). Picking a day first gives it 9 am. */
export function DateTimeField({ value, onChange, label, id }: { value: string | null; onChange: (v: string | null) => void; label: string; id?: string }) {
  const [day, time] = value ? value.split('T') : [null, null]
  return (
    <div className="dt-pair">
      <DateField id={id} label={`${label}: day`} placeholder="No reminder" value={day} onChange={(d) => onChange(d ? `${d}T${time ?? '09:00'}` : null)} />
      {day && <TimeField label={`${label}: time`} value={time} onChange={(t) => onChange(`${day}T${t}`)} />}
    </div>
  )
}
