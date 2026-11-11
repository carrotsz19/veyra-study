import type { Rec, Task } from '@shared/types'

/** Subject colours, tuned to sit with Veyra's warm palette in both themes. */
export const SUBJECT_COLORS = [
  '#b3492b', // Veyra tint
  '#3f6b4a', // green
  '#2f5f8a', // blue
  '#7a4f9a', // violet
  '#a86f1d', // amber
  '#2f7d7a', // teal
  '#9a3f63', // rose
  '#5b5a55' // graphite
]

export function progress(tasks: Rec<'task'>[], subjectId: string | null): { done: number; total: number; pct: number } {
  const mine = tasks.filter((t) => t.data.subjectId === subjectId)
  const done = mine.filter((t) => t.data.done).length
  return { done, total: mine.length, pct: mine.length ? Math.round((done / mine.length) * 100) : 0 }
}

export const blankTask = (subjectId: string | null = null, due: string | null = null, priority: Task['priority'] = 'normal'): Task => ({
  title: '',
  subjectId,
  done: false,
  completedAt: null,
  due,
  priority
})

/** The due date a new task starts with (Settings → Tasks). */
export function defaultDueDate(kind: 'none' | 'today' | 'tomorrow' | 'week'): string | null {
  if (kind === 'none') return null
  const d = new Date()
  d.setDate(d.getDate() + (kind === 'tomorrow' ? 1 : kind === 'week' ? 7 : 0))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
