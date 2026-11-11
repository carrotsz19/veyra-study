/**
 * Reminders, checked every 30 seconds while Veyra runs (in the tray too):
 *  - a task's own reminder time;
 *  - a morning summary (due today, overdue);
 *  - an evening heads-up (due tomorrow).
 * What has already been shown is remembered per computer (store meta), so a
 * restart doesn't repeat it. A summary that was missed (Veyra wasn't running)
 * still comes if it's at most 4 hours late; a task reminder up to 12 hours late.
 */
import { Notification } from 'electron'
import { appendFileSync } from 'node:fs'
import type { Rec } from '../shared/types'
import { withDefaults } from '../shared/settings'
import type { Store } from './db'

const LATE_SUMMARY = 4 * 3600_000
const LATE_TASK = 12 * 3600_000

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (d: Date, hhmm: string) => {
  const [h, m] = (/^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '08:00').split(':').map(Number)
  const t = new Date(d)
  t.setHours(h, m, 0, 0)
  return t
}
const list = (titles: string[]) => (titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.join(', '))

export class Reminders {
  private timer: ReturnType<typeof setInterval>

  constructor(
    private store: () => Store | null,
    /** Shows the app on the given screen (a notification was clicked). */
    private open: (screen: 'tasks' | 'today') => void
  ) {
    this.timer = setInterval(() => this.tick(), 30_000)
    setTimeout(() => this.tick(), 5_000)
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  private show(title: string, body: string, screen: 'tasks' | 'today') {
    // Dev checks: VEYRA_REMINDER_LOG=file writes reminders there instead of showing them.
    const log = process.env['VEYRA_REMINDER_LOG']
    if (log) return appendFileSync(log, JSON.stringify({ title, body, screen }) + '\n')
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => this.open(screen))
    n.show()
  }

  tick(now = new Date()): void {
    const st = this.store()
    if (!st) return
    let s
    let tasks: Rec<'task'>[]
    try {
      s = withDefaults((st.list('settings')[0]?.data as object) ?? {})
      tasks = (st.list('task') as Rec<'task'>[]).filter((t) => !t.data.done)
    } catch {
      return // the database is switching (signing in or out)
    }
    if (!s.remindersOn) return

    let fired: Record<string, number> = {}
    try {
      fired = JSON.parse(st.meta('reminders_fired') || '{}')
    } catch {
      fired = {}
    }
    const t = now.getTime()
    const mark = (k: string) => (fired[k] = t)
    const today = dayKey(now)
    const tomorrow = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))

    // A task's own reminder.
    for (const task of tasks) {
      const r = task.data.remindAt
      if (!r || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r)) continue
      const when = new Date(r).getTime()
      const k = `t:${task.id}:${r}`
      if (when > t || fired[k]) continue
      mark(k)
      if (t - when > LATE_TASK) continue
      const due = task.data.due ? (task.data.due === today ? 'Due today' : task.data.due === tomorrow ? 'Due tomorrow' : task.data.due < today ? 'Overdue' : `Due ${task.data.due}`) : 'Reminder'
      this.show(task.data.title, due, 'tasks')
    }

    // Morning summary.
    const morning = at(now, s.morningTime).getTime()
    if (s.remindMorning && t >= morning && !fired[`m:${today}`]) {
      mark(`m:${today}`)
      const dueToday = tasks.filter((x) => x.data.due === today)
      const late = tasks.filter((x) => x.data.due && x.data.due < today)
      if (t - morning <= LATE_SUMMARY && (dueToday.length || late.length)) {
        const head = [dueToday.length ? `${dueToday.length} due today` : '', late.length ? `${late.length} overdue` : ''].filter(Boolean).join(', ')
        this.show(`Today: ${head}`, list([...late, ...dueToday].map((x) => x.data.title)), 'today')
      }
    }

    // Evening heads-up for tomorrow.
    const evening = at(now, s.eveningTime).getTime()
    if (s.remindEvening && t >= evening && !fired[`e:${today}`]) {
      mark(`e:${today}`)
      const due = tasks.filter((x) => x.data.due === tomorrow)
      if (t - evening <= LATE_SUMMARY && due.length) this.show(`Due tomorrow: ${due.length} ${due.length === 1 ? 'task' : 'tasks'}`, list(due.map((x) => x.data.title)), 'tasks')
    }

    // Forget what's over a week old.
    for (const [k, v] of Object.entries(fired)) if (t - v > 7 * 86400_000) delete fired[k]
    try {
      st.setMeta('reminders_fired', JSON.stringify(fired))
    } catch {
      /* the database closed meanwhile */
    }
  }
}
