import { useEffect, useState } from 'react'
import type { GoogleEvent } from '@shared/types'

/** Google events overlapping [from, to); empty when not connected. */
type Result = { events: GoogleEvent[]; error?: string }
/** The last answer for each range: a calendar opens with it at once, then updates. */
const seen = new Map<string, Result>()
const asking = new Map<string, Promise<Result>>()
const listeners = new Set<() => void>()
function ask(a: string, b: string): Promise<Result> {
  const key = a + '|' + b
  const now = asking.get(key)
  if (now) return now
  const p = window.veyra.google
    .events(a, b)
    .then((r: Result) => {
      seen.set(key, r)
      // Keep memory small: the most recent 24 ranges.
      if (seen.size > 24) seen.delete(seen.keys().next().value!)
      return r
    })
    .finally(() => asking.delete(key))
  asking.set(key, p)
  return p
}
/** Fetches a range ahead of time (the months either side), so moving there is instant. */
export function prefetchEvents(from: Date, to: Date): void {
  const a = from.toISOString()
  const b = to.toISOString()
  if (!seen.has(a + '|' + b)) void ask(a, b).catch(() => {})
}
window.veyra?.google?.onChanged?.(() => {
  seen.clear()
  listeners.forEach((l) => l())
})

export function useGoogleEvents(from: Date, to: Date): Result {
  const a = from.toISOString()
  const b = to.toISOString()
  const [out, setOut] = useState<Result>(() => seen.get(a + '|' + b) ?? { events: [] })
  const [bump, setBump] = useState(0)
  useEffect(() => {
    const l = () => setBump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  useEffect(() => {
    let live = true
    // Show what we have for this range straight away (no empty month while it loads).
    const have = seen.get(a + '|' + b)
    if (have) setOut(have)
    ask(a, b).then((r) => live && setOut(r)).catch(() => {})
    return () => {
      live = false
    }
  }, [a, b, bump])
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
