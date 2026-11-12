import { useState } from 'react'
import { Bell, Check, ChevronDown, Flag, ListChecks, Repeat as RepeatIcon } from 'lucide-react'
import type { Rec, TaskStep } from '@shared/types'
import { nextInSeries, repeatLabel } from '@shared/repeat'
import { db, useRecords } from '../data/store'
import { dueLabel, isOverdue, todayKey } from '../lib/dates'
import { useToast } from './ui'
import { TaskDialog } from './editors'
import { useSettings } from '../data/settings'
import type { TaskSort } from '@shared/settings'

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

/** Ticks one step; says so when that was the last one. */
async function toggleStep(task: Rec<'task'>, step: TaskStep): Promise<boolean> {
  // From the newest copy, so quick ticks in a row don't undo each other.
  const t = (await db.list('task')).find((x) => x.id === task.id) ?? task
  const was = (t.data.steps ?? []).find((x) => x.id === step.id)?.done ?? step.done
  const steps = (t.data.steps ?? []).map((x) => (x.id === step.id ? { ...x, done: !was } : x))
  await db.put('task', { ...t.data, steps }, t.id)
  return !was && steps.every((x) => x.done) && !t.data.done
}

/** Open tasks first (overdue, then by due date), finished ones at the end. */
export function sortTasks(tasks: Rec<'task'>[], by: TaskSort = 'due'): Rec<'task'>[] {
  const rank = { high: 0, normal: 1, low: 2 }
  const due = (t: Rec<'task'>) => t.data.due ?? '9999'
  return [...tasks].sort((a, b) => {
    if (a.data.done !== b.data.done) return a.data.done ? 1 : -1
    if (a.data.done) return (b.data.completedAt ?? 0) - (a.data.completedAt ?? 0)
    if (by === 'priority' && a.data.priority !== b.data.priority) return rank[a.data.priority] - rank[b.data.priority]
    if (by === 'created') return b.createdAt - a.createdAt
    if (by === 'title') return a.data.title.localeCompare(b.data.title)
    if (due(a) !== due(b)) return due(a) < due(b) ? -1 : 1
    return rank[a.data.priority] - rank[b.data.priority]
  })
}

export function TaskRow({ task, showSubject = true, onOpen }: { task: Rec<'task'>; showSubject?: boolean; onOpen: () => void }) {
  const { items: subjects } = useRecords('subject')
  const subject = subjects.find((s) => s.id === task.data.subjectId)
  const { s: settings } = useSettings()
  const late = settings.highlightOverdue && isOverdue(task.data.due, task.data.done)
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const steps = task.data.steps ?? []
  const stepsDone = steps.filter((x) => x.done).length
  const tick = async () => {
    // The newest copy (a step may have just been ticked).
    const fresh = (await db.list('task')).find((x) => x.id === task.id) ?? task
    const next = await toggleTask(fresh)
    if (next) toast(`Done. The next one is due ${nextWhen(next)}.`)
  }
  return (
    <div className={`ig-row tap task-row ${task.data.done ? 'task-done' : ''} ${open && steps.length ? 'steps-open' : ''}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}>
      <button
        className="tick"
        role="checkbox"
        aria-checked={task.data.done}
        aria-label={task.data.done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => {
          e.stopPropagation()
          void tick()
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
      {task.data.repeat && (
        <span title={repeatLabel(task.data.repeat, task.data.due)}>
          <RepeatIcon size={13} className="dim" aria-label={repeatLabel(task.data.repeat, task.data.due)} />
        </span>
      )}
      {steps.length > 0 && (
        <button
          className={`step-chip ${stepsDone === steps.length ? 'all' : ''}`}
          aria-expanded={open}
          title={open ? 'Hide steps' : 'Show steps'}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
        >
          <ListChecks size={13} /> {stepsDone}/{steps.length}
          <ChevronDown size={12} className="step-chev" />
        </button>
      )}
      {task.data.remindAt && !task.data.done && new Date(task.data.remindAt).getTime() > Date.now() && (
        <span title={`Reminder ${new Date(task.data.remindAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}>
          <Bell size={13} className="dim" aria-label="Has a reminder" />
        </span>
      )}
      {task.data.priority === 'high' && !task.data.done && <Flag size={14} color="var(--bad)" aria-label="High priority" />}
      {task.data.due && !task.data.done && <span className={`pill ${late ? 'bad' : dueLabel(task.data.due) === 'Today' ? 'accent' : ''}`}>{dueLabel(task.data.due)}</span>}
      {open && steps.length > 0 && (
        <div className="task-steps" onClick={(e) => e.stopPropagation()}>
          {steps.map((st) => (
            <label key={st.id} className={`task-step ${st.done ? 'done' : ''}`}>
              <button
                className="tick sm"
                role="checkbox"
                aria-checked={st.done}
                aria-label={st.done ? `Mark “${st.text}” not done` : `Mark “${st.text}” done`}
                onClick={async () => {
                  if (await toggleStep(task, st)) toast('Every step is done', { label: 'Tick off the task', run: () => void tick() })
                }}
              >
                {st.done && <Check size={11} strokeWidth={3} />}
              </button>
              <span>{st.text}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskList({ tasks, showSubject = true }: { tasks: Rec<'task'>[]; showSubject?: boolean }) {
  const [editing, setEditing] = useState<Rec<'task'> | null>(null)
  const { s } = useSettings()
  return (
    <>
      <div className="ig">
        {sortTasks(tasks, s.taskSort).map((t) => (
          <TaskRow key={t.id} task={t} showSubject={showSubject} onOpen={() => setEditing(t)} />
        ))}
      </div>
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </>
  )
}
