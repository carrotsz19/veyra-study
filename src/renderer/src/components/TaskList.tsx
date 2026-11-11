import { useState } from 'react'
import { Check, Flag } from 'lucide-react'
import type { Rec } from '@shared/types'
import { db, useRecords } from '../data/store'
import { dueLabel, isOverdue } from '../lib/dates'
import { TaskDialog } from './editors'

export async function toggleTask(t: Rec<'task'>): Promise<void> {
  const done = !t.data.done
  await db.put('task', { ...t.data, done, completedAt: done ? Date.now() : null }, t.id)
}

/** Open tasks first (overdue, then by due date), finished ones at the end. */
export function sortTasks(tasks: Rec<'task'>[]): Rec<'task'>[] {
  const rank = { high: 0, normal: 1, low: 2 }
  return [...tasks].sort((a, b) => {
    if (a.data.done !== b.data.done) return a.data.done ? 1 : -1
    if (a.data.done) return (b.data.completedAt ?? 0) - (a.data.completedAt ?? 0)
    const ad = a.data.due ?? '9999', bd = b.data.due ?? '9999'
    if (ad !== bd) return ad < bd ? -1 : 1
    return rank[a.data.priority] - rank[b.data.priority]
  })
}

export function TaskRow({ task, showSubject = true, onOpen }: { task: Rec<'task'>; showSubject?: boolean; onOpen: () => void }) {
  const { items: subjects } = useRecords('subject')
  const subject = subjects.find((s) => s.id === task.data.subjectId)
  const late = isOverdue(task.data.due, task.data.done)
  return (
    <div className={`ig-row tap ${task.data.done ? 'task-done' : ''}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <button
        className="tick"
        role="checkbox"
        aria-checked={task.data.done}
        aria-label={task.data.done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => {
          e.stopPropagation()
          toggleTask(task)
        }}
        style={{ marginLeft: 2 }}
      >
        {task.data.done && <Check size={14} strokeWidth={3} />}
      </button>
      <div className="grow">
        <div className="ig-title trunc">{task.data.title}</div>
        {(showSubject && subject) || task.data.details ? (
          <div className="ig-sub trunc row" style={{ gap: 6 }}>
            {showSubject && subject && (
              <>
                <span className="dot" style={{ width: 7, height: 7, borderRadius: 9, background: subject.data.color, display: 'inline-block' }} />
                {subject.data.name}
              </>
            )}
            {task.data.details && <span className="tert trunc">{task.data.details}</span>}
          </div>
        ) : null}
      </div>
      {task.data.priority === 'high' && !task.data.done && <Flag size={14} color="var(--bad)" aria-label="High priority" />}
      {task.data.due && !task.data.done && <span className={`pill ${late ? 'bad' : dueLabel(task.data.due) === 'Today' ? 'accent' : ''}`}>{dueLabel(task.data.due)}</span>}
    </div>
  )
}

export function TaskList({ tasks, showSubject = true }: { tasks: Rec<'task'>[]; showSubject?: boolean }) {
  const [editing, setEditing] = useState<Rec<'task'> | null>(null)
  return (
    <>
      <div className="ig">
        {sortTasks(tasks).map((t) => (
          <TaskRow key={t.id} task={t} showSubject={showSubject} onOpen={() => setEditing(t)} />
        ))}
      </div>
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
