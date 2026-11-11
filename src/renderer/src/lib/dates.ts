import { differenceInCalendarDays, format, parseISO } from 'date-fns'

export const todayKey = (): string => format(new Date(), 'yyyy-MM-dd')
export const dayKey = (d: Date | number): string => format(d, 'yyyy-MM-dd')

/** "Today", "Tomorrow", "Yesterday", "3 days late", or "Mon 14 Dec". */
export function dueLabel(due: string): string {
  const diff = differenceInCalendarDays(parseISO(due), new Date())
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  if (diff < 0) return `${-diff} days late`
  if (diff < 7) return format(parseISO(due), 'EEEE')
  return format(parseISO(due), 'EEE d MMM')
}

export const isOverdue = (due: string | null, done: boolean): boolean =>
  !!due && !done && differenceInCalendarDays(parseISO(due), new Date()) < 0

/** 5400 -> "1h 30m", 300 -> "5m", 20 -> "<1m". */
export function duration(sec: number): string {
  const m = Math.round(sec / 60)
  if (sec > 0 && m === 0) return '<1m'
  const h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`
}

export const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
