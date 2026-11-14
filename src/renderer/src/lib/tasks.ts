import type { Rec } from '@shared/types'
import { nextInSeries } from '@shared/repeat'
import { db } from '../data/store'
import { dueLabel, todayKey } from './dates'

/**
 * Ticks a task off (or back on). A repeating task makes its next one; unticking
 * takes that next one away again if it hasn't been touched since.
 * Returns the next task's due date, if one was made.
 */
export async function toggleTask(t: Rec<'task'>): Promise<string | null> {
  const done = !t.data.done
  if (done) {
    const next = nextInSeries(t.id, t.data, todayKey())
    if (next && !(await db.list('task')).some((x) => x.id === next.id)) await db.put('task', next.data, next.id)
    await db.put('task', { ...t.data, done, completedAt: Date.now(), nextId: next?.id ?? null }, t.id)
    return next?.data.due ?? null
  }
  if (t.data.nextId) {
    const n = (await db.list('task')).find((x) => x.id === t.data.nextId)
    if (n && !n.data.done && n.updatedAt === n.createdAt) await db.remove('task', n.id)
  }
  await db.put('task', { ...t.data, done, completedAt: null, nextId: null }, t.id)
  return null
}

/** "tomorrow", "on Friday", "on Mon 14 Dec". */
export function nextWhen(day: string): string {
  const l = dueLabel(day)
  return l === 'Today' || l === 'Tomorrow' ? l.toLowerCase() : `on ${l}`
}

/** The newest copy of a task (the one on screen may be a moment old). */
export async function freshTask(t: Rec<'task'>): Promise<Rec<'task'>> {
  return (await db.list('task')).find((x) => x.id === t.id) ?? t
}

/** A "YYYY-MM-DD" day, some days from today. */
export function dayFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Gives tasks a new due date (late ones moved to today, say). Returns the way
 * back: each task gets the date it had, unless it has gone since.
 */
export async function setDue(list: Rec<'task'>[], due: string | null): Promise<() => Promise<void>> {
  const before = list.map((t) => [t.id, t.data.due] as const)
  const all = await db.list('task')
  for (const t of list) {
    const cur = all.find((x) => x.id === t.id) ?? t
    if (cur.data.due !== due) await db.put('task', { ...cur.data, due }, t.id)
  }
  return async () => {
    const now = await db.list('task')
    for (const [id, was] of before) {
      const cur = now.find((x) => x.id === id)
      if (cur && cur.data.due !== was) await db.put('task', { ...cur.data, due: was }, id)
    }
  }
}
