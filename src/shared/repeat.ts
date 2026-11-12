import type { Repeat, Task } from './types'

/**
 * Repeating tasks. Ticking one off makes the next one, due on the next date
 * the rule gives (never in the past). Shared by the app and the AI tools
 * (MCP), so a task finished either way carries on the same.
 */

const parse = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12)
/** Months later, on the same day where it exists (31 Jan + 1 month = 28/29 Feb). */
function addMonths(d: Date, n: number, day: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1, 12)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, last), 12)
}
/** Monday of the week, as a day count (for "every 2 weeks"). */
const weekNo = (d: Date) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000 + 3) / 7)

export const cleanRepeat = (r: Repeat | null | undefined): Repeat | null => {
  if (!r || !['day', 'week', 'month', 'year'].includes(r.unit)) return null
  const every = Math.min(99, Math.max(1, Math.round(Number(r.every) || 1)))
  const days = r.unit === 'week' ? [...new Set((r.days ?? []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : undefined
  return { unit: r.unit, every, ...(days?.length ? { days } : {}), ...(r.series ? { series: r.series } : {}) }
}

/** One step of the rule after `from`. `anchor` is the series' original day (for month-ends and fortnights). */
function step(from: Date, r: Repeat, anchor: Date): Date {
  if (r.unit === 'day') return addDays(from, r.every)
  if (r.unit === 'month') return addMonths(from, r.every, anchor.getDate())
  if (r.unit === 'year') return addMonths(from, 12 * r.every, anchor.getDate())
  const days = r.days?.length ? r.days : [anchor.getDay()]
  for (let d = addDays(from, 1), i = 0; i < 800; i++, d = addDays(d, 1)) {
    if (days.includes(d.getDay()) && (((weekNo(d) - weekNo(anchor)) % r.every) + r.every) % r.every === 0) return d
  }
  return addDays(from, 7 * r.every)
}

/** The next due date after `due`, moved on until it's today or later. */
export function nextDue(due: string, rule: Repeat, today: string): string {
  const r = cleanRepeat(rule)!
  const anchor = parse(due)
  let d = step(anchor, r, anchor)
  for (let i = 0; i < 5000 && key(d) < today; i++) d = step(d, r, anchor)
  return key(d)
}

const dayDiff = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000)

/** The next task in the series, for a repeating task being ticked off (null if it doesn't repeat). */
export function nextInSeries(id: string, t: Task, today: string): { id: string; data: Task } | null {
  const rule = cleanRepeat(t.repeat)
  if (!rule) return null
  const from = t.due ?? today
  const due = nextDue(from, rule, today)
  const series = rule.series ?? id
  // Made from the series and the date, so two devices ticking it off offline make the same one.
  const nextId = `${series.slice(0, 40)}-r${due.replace(/-/g, '')}`
  let remindAt = t.remindAt ?? null
  if (remindAt) {
    const [day, time] = remindAt.split('T')
    remindAt = `${key(addDays(parse(day), dayDiff(from, due)))}T${time}`
  }
  return {
    id: nextId,
    data: {
      ...t,
      done: false,
      completedAt: null,
      due,
      remindAt,
      steps: t.steps?.map((s) => ({ ...s, done: false })),
      repeat: { ...rule, series },
      nextId: null
    }
  }
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th')

/** "Every day", "Every weekday", "Every 2 weeks on Mon, Thu", "Every month on the 14th". */
export function repeatLabel(rule: Repeat | null | undefined, due?: string | null): string {
  const r = cleanRepeat(rule)
  if (!r) return 'Doesn’t repeat'
  const n = r.every
  const unit = (one: string) => (n === 1 ? `Every ${one}` : `Every ${n} ${one}s`)
  if (r.unit === 'day') return unit('day')
  if (r.unit === 'week') {
    const days = r.days?.length ? r.days : due ? [parse(due).getDay()] : []
    if (n === 1 && days.join() === '1,2,3,4,5') return 'Every weekday'
    if (n === 1 && days.length === 7) return 'Every day'
    return unit('week') + (days.length ? ` on ${days.map((d) => WD[d]).join(', ')}` : '')
  }
  if (r.unit === 'month') return unit('month') + (due ? ` on the ${ordinal(parse(due).getDate())}` : '')
  return unit('year')
}
