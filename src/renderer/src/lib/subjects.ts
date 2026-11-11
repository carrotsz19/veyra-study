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

export const blankTask = (subjectId: string | null = null, due: string | null = null): Task => ({
  title: '',
  subjectId,
  done: false,
  completedAt: null,
  due,
  priority: 'normal'
})
