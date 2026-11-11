/**
 * Reminders on Android. Android stops apps in the background, so instead of
 * checking every 30 seconds (as the desktop does) the phone schedules its
 * notifications ahead: each task's own reminder, and the morning summary and
 * evening heads-up for the next week. They're rebuilt whenever tasks or
 * settings change, a sync brings changes, or the app opens.
 */
import { LocalNotifications } from '@capacitor/local-notifications'
import { withDefaults } from '@shared/settings'
import type { Rec } from '@shared/types'
import * as idb from './idb'

const DAYS = 7
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const at = (d: Date, hhmm: string) => {
  const [h, m] = (/^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '08:00').split(':').map(Number)
  const t = new Date(d)
  t.setHours(h, m, 0, 0)
  return t
}
const list = (titles: string[]) => (titles.length > 3 ? `${titles.slice(0, 3).join(', ')} and ${titles.length - 3} more` : titles.join(', '))
/** A stable notification id from a string (Android wants a 32-bit number). */
const idOf = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h) % 2_000_000_000
}

let timer: ReturnType<typeof setTimeout> | null = null
let asked = false
const navSubs = new Set<(screen: string) => void>()

/** The tray-and-reminder "open this screen" signal (window.veyra.app.onNav). */
export function onNav(cb: (screen: string) => void): () => void {
  navSubs.add(cb)
  return () => void navSubs.delete(cb)
}

export function startReminders(): void {
  void LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const screen = (e.notification.extra as { screen?: string } | undefined)?.screen
    if (screen) navSubs.forEach((f) => f(screen))
  })
  schedule(3000)
}

/** Rebuild the schedule soon (changes come in bursts). */
export function schedule(ms = 1500): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void rebuild().catch(() => {}), ms)
}

async function rebuild(): Promise<void> {
  const s = withDefaults(((await idb.list('settings'))[0]?.data as object) ?? {})
  const pending = await LocalNotifications.getPending()
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) })
  if (!s.remindersOn) return

  const tasks = ((await idb.list('task')) as Rec<'task'>[]).filter((t) => !t.data.done)
  const now = new Date()
  const out: { id: number; title: string; body: string; schedule: { at: Date; allowWhileIdle: boolean }; extra: { screen: string } }[] = []
  const add = (key: string, when: Date, title: string, body: string, screen: string) => {
    if (when.getTime() > now.getTime() + 5000) out.push({ id: idOf(key), title, body, schedule: { at: when, allowWhileIdle: true }, extra: { screen } })
  }

  // Each task's own reminder (up to a month ahead).
  for (const t of tasks) {
    const r = t.data.remindAt
    if (!r || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r)) continue
    const when = new Date(r)
    if (when.getTime() - now.getTime() > 31 * 86400_000) continue
    const due = t.data.due ? (t.data.due === dayKey(when) ? 'Due today' : `Due ${t.data.due}`) : 'Reminder'
    add(`t:${t.id}:${r}`, when, t.data.title, due, 'tasks')
  }

  // Morning summaries and evening heads-ups for the next week, from what's known now.
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const day = dayKey(d)
    const tomorrow = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
    if (s.remindMorning) {
      const due = tasks.filter((x) => x.data.due === day)
      const late = tasks.filter((x) => x.data.due && x.data.due < day)
      if (due.length || late.length) {
        const head = [due.length ? `${due.length} due today` : '', late.length ? `${late.length} overdue` : ''].filter(Boolean).join(', ')
        add(`m:${day}`, at(d, s.morningTime), `Today: ${head}`, list([...late, ...due].map((x) => x.data.title)), 'today')
      }
    }
    if (s.remindEvening) {
      const due = tasks.filter((x) => x.data.due === tomorrow)
      if (due.length) add(`e:${day}`, at(d, s.eveningTime), `Due tomorrow: ${due.length} ${due.length === 1 ? 'task' : 'tasks'}`, list(due.map((x) => x.data.title)), 'tasks')
    }
  }
  if (!out.length) return

  // Android 13+ asks before an app may show notifications (once).
  if (!asked) {
    asked = true
    const p = await LocalNotifications.checkPermissions()
    if (p.display !== 'granted') {
      const r = await LocalNotifications.requestPermissions()
      if (r.display !== 'granted') return
    }
  }
  await LocalNotifications.schedule({ notifications: out.slice(0, 60) })
}
