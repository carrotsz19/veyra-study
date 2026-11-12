import { useRef, useState, type ReactNode } from 'react'
import { Bell, Check, ChevronDown, Flag, ListChecks, Repeat as RepeatIcon, Trash2, Undo2 } from 'lucide-react'
import { usePhone } from '../lib/phone'
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
  const phone = usePhone()
  const remove = async () => {
    await db.remove('task', task.id)
    toast('Task deleted', { label: 'Undo', run: () => void db.put('task', task.data, task.id) })
  }
  const row = (
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
  // On a phone: swipe right to tick it off, left to delete.
  return phone ? (
    <SwipeRow done={task.data.done} onDone={() => void tick()} onDelete={() => void remove()}>
      {row}
    </SwipeRow>
  ) : (
    row
  )
}

/**
 * A row you can swipe. It follows your finger 1:1, resists past the end
 * (rubber band), and a long enough or fast enough swipe carries on off the
 * edge at the speed you threw it, then does the action; otherwise it springs back.
 */
function SwipeRow({ done, onDone, onDelete, children }: { done: boolean; onDone: () => void; onDelete: () => void; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  const front = useRef<HTMLDivElement>(null)
  const g = useRef<{ x: number; y: number; axis: '' | 'x' | 'y'; dx: number; v: number; t: number; armed: number; moved: boolean } | null>(null)
  const [side, setSide] = useState<0 | 1 | -1>(0)
  const [armed, setArmed] = useState(false)
  const set = (x: number, animate: string | null) => {
    const el = front.current
    if (!el) return
    el.style.transition = animate ?? 'none'
    el.style.transform = x ? `translateX(${x}px)` : ''
  }
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.tick, .step-chip, .task-steps')) return
    g.current = { x: e.clientX, y: e.clientY, axis: '', dx: 0, v: 0, t: e.timeStamp, armed: 0, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const s = g.current
    const w = wrap.current?.offsetWidth ?? 360
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.axis) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.axis = 'x'
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        } catch {
          /* the pointer is already gone */
        }
      } else if (Math.abs(dy) > 10) s.axis = 'y'
      return
    }
    if (s.axis !== 'x') return
    s.moved = true
    // Past 60% of the width, it resists more the further you pull.
    const limit = w * 0.6
    const over = Math.max(0, Math.abs(dx) - limit)
    const x = Math.sign(dx) * (Math.min(Math.abs(dx), limit) + (over * 0.55) / (1 + (over * 0.55) / w))
    // Speed, smoothed: two events a millisecond apart would otherwise look like a huge flick.
    const dt = Math.max(8, e.timeStamp - s.t)
    s.v = s.v * 0.5 + ((x - s.dx) / dt) * 0.5
    s.dx = x
    s.t = e.timeStamp
    setSide(x > 0 ? 1 : x < 0 ? -1 : 0)
    const on = Math.abs(x) > w * 0.35 ? Math.sign(x) : 0
    if (on !== s.armed) {
      s.armed = on
      setArmed(!!on)
      if (on) void window.veyra.app.haptic?.('light')
    }
    set(x, null)
  }
  const onUp = () => {
    const s = g.current
    g.current = null
    if (!s || s.axis !== 'x') return
    const w = wrap.current?.offsetWidth ?? 360
    const flick = Math.abs(s.v) > 0.6 && Math.abs(s.dx) > 72
    const go = Math.abs(s.dx) > w * 0.35 || flick ? Math.sign(flick ? s.v : s.dx) : 0
    if (go) {
      // Carry on off the edge, as fast as it was moving (but at least briskly).
      const ms = Math.round(Math.min(260, Math.max(140, (w - Math.abs(s.dx)) / Math.max(Math.abs(s.v), 1.6))))
      set(go * w * 1.05, `transform ${ms}ms cubic-bezier(0.2, 0.7, 0.3, 1)`)
      setTimeout(() => {
        if (go > 0) {
          onDone()
          set(0, 'none')
          setSide(0)
          setArmed(false)
        } else onDelete()
      }, ms)
    } else {
      set(0, 'transform var(--spring-snappy-ms) var(--spring-snappy)')
      setArmed(false)
    }
    // A swipe isn't a tap: don't open the task.
    if (s.moved) {
      const stop = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      wrap.current?.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => wrap.current?.removeEventListener('click', stop, { capture: true }), 50)
    }
  }
  return (
    <div ref={wrap} className={`swipe-wrap ${side > 0 ? 'right' : side < 0 ? 'left' : ''} ${armed ? 'armed' : ''}`}>
      <div className="swipe-act done" aria-hidden>
        {done ? <Undo2 size={20} /> : <Check size={22} strokeWidth={2.6} />}
        <span>{done ? 'Not done' : 'Done'}</span>
      </div>
      <div className="swipe-act del" aria-hidden>
        <span>Delete</span>
        <Trash2 size={20} />
      </div>
      <div ref={front} className="swipe-front" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {children}
      </div>
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
