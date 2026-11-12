/**
 * Helpers for the notes list: a clean one-glance preview, short dates, and
 * the date sections (Today, Yesterday, Previous 7 days, …) notes are grouped in.
 */
import { differenceInCalendarDays, format, isSameYear } from 'date-fns'

/** The preview under a note's title, without the title repeated at its start. */
export function preview(title: string, excerpt: string): string {
  let text = (excerpt ?? '').replace(/\s+/g, ' ').trim()
  const t = (title ?? '').trim()
  if (t && text.toLowerCase().startsWith(t.toLowerCase())) text = text.slice(t.length).replace(/^[\s·:–—-]+/, '')
  return text
}

/** 14:05 today, "Yesterday", a weekday this week, otherwise a date. */
export function shortDate(ts: number, hour12: boolean): string {
  const days = differenceInCalendarDays(Date.now(), ts)
  if (days <= 0) return format(ts, hour12 ? 'h:mm a' : 'HH:mm')
  if (days === 1) return 'Yesterday'
  if (days < 7) return format(ts, 'EEEE')
  return isSameYear(ts, Date.now()) ? format(ts, 'd MMM') : format(ts, 'd MMM yyyy')
}

/** Which section a note falls in, by the date it's sorted on. */
export function section(ts: number): string {
  const days = differenceInCalendarDays(Date.now(), ts)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  if (days < 30) return 'Previous 30 days'
  return isSameYear(ts, Date.now()) ? format(ts, 'MMMM') : format(ts, 'yyyy')
}
