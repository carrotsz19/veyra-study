import { useEffect, useState } from 'react'
import type { GoogleEvent } from '@shared/types'

/** Google events overlapping [from, to); empty when not connected. */
export function useGoogleEvents(from: Date, to: Date): { events: GoogleEvent[]; error?: string } {
  const [out, setOut] = useState<{ events: GoogleEvent[]; error?: string }>({ events: [] })
  const a = from.toISOString()
  const b = to.toISOString()
  useEffect(() => {
    let live = true
    window.veyra.google.events(a, b).then((r) => live && setOut(r))
    return () => {
      live = false
    }
  }, [a, b])
  return out
}

/** Local "YYYY-MM-DD" days an event covers (all-day ends are exclusive). */
export function eventDays(e: GoogleEvent): string[] {
  const days: string[] = []
  const start = e.allDay ? new Date(e.start + 'T00:00:00') : new Date(e.start)
  let end = e.allDay ? new Date(e.end + 'T00:00:00') : new Date(e.end)
  if (!e.allDay && end.getTime() > start.getTime()) end = new Date(end.getTime() - 1) // ends at midnight: not the next day
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  // All-day ends are exclusive: step back one calendar day (not 24 hours, which breaks across daylight saving).
  const last = e.allDay ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1) : end
  for (let i = 0; i < 62 && d <= last; i++) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    d.setDate(d.getDate() + 1)
  }
  return days.length ? days : [`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`]
}

export const eventTime = (e: GoogleEvent) =>
  e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
