/**
 * Veyra for AI apps (MCP). A small JSON-RPC server on 127.0.0.1 inside the
 * app, so AI apps on this computer (Claude Desktop, Claude Code, Gemini CLI,
 * ChatGPT desktop…) can read and, if allowed, change your tasks and notes with
 * your own AI subscription. AI apps start veyra-mcp.cjs (a stdio bridge,
 * written to the profile folder), which forwards to this server.
 *
 * Safety: off until switched on; read-only until "Allow changes" is on; only
 * 127.0.0.1; a random token from mcp.json on every request; requests from web
 * pages (an Origin header, or a Host that isn't 127.0.0.1) are refused.
 */
import { app } from 'electron'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GoogleEvent, Kind, Rec, Repeat, Task, TaskStep } from '../shared/types'
import { nextInSeries, repeatLabel } from '../shared/repeat'
import type { Store } from './db'
import { docPlain, markdownToDoc, noteMarkdown } from './notetext'

export const MCP_PORT = Number(process.env['VEYRA_MCP_PORT'] || 47821)
const VERSION = '1.0.0'

interface Hooks {
  store: () => Store | null
  allowWrites: () => boolean
  /** A write happened: refresh the screens, sync, Google. */
  changed: (kinds: Kind[], ids: string[]) => void
  /** Calendar events (Google, calendar links, group deadlines). */
  events?: (fromIso: string, toIso: string) => Promise<{ events: GoogleEvent[] }>
  /** One request to the group server (group work). */
  group?: (method: string, path: string, body?: unknown) => Promise<any>
}

class ToolError extends Error {}

const configFile = () => join(app.getPath('userData'), 'mcp.json')
export const bridgeFile = () => join(app.getPath('userData'), 'veyra-mcp.cjs')

export class McpServer {
  private server: Server | null = null
  private token = ''
  port = 0

  constructor(private hooks: Hooks) {}

  running(): boolean {
    return !!this.server
  }

  async start(): Promise<void> {
    if (this.server) return
    try {
      const saved = JSON.parse(readFileSync(configFile(), 'utf8'))
      if (typeof saved.token === 'string' && saved.token.length >= 32) this.token = saved.token
    } catch {
      /* first time */
    }
    this.token ||= randomBytes(32).toString('hex')
    for (let port = MCP_PORT; port < MCP_PORT + 10; port++) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = createServer((req, res) => void this.http(req, res))
        s.once('error', () => resolve(false))
        s.listen(port, '127.0.0.1', () => {
          this.server = s
          this.port = port
          resolve(true)
        })
      })
      if (ok) break
    }
    if (!this.server) throw new Error('No free port for the AI connector.')
    writeFileSync(configFile(), JSON.stringify({ port: this.port, token: this.token }), { mode: 0o600 })
    // The bridge knows the tools, so AI apps see them even while Veyra is closed.
    const tools = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    writeFileSync(bridgeFile(), BRIDGE.replace('const TOOLS_WHEN_CLOSED = []', `const TOOLS_WHEN_CLOSED = ${JSON.stringify(tools)}`))
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async http(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    }
    // Only programs on this computer, never a web page.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`) return send(403, { error: 'Not allowed.' })
    const auth = String(req.headers.authorization || '')
    const want = Buffer.from(`Bearer ${this.token}`)
    const got = Buffer.from(auth)
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(401, { error: 'Wrong token.' })
    if (req.url !== '/mcp') return send(404, { error: 'Not found.' })
    if (req.method !== 'POST') return send(405, { error: 'Use POST.' })
    let body = ''
    for await (const c of req) {
      body += c
      if (body.length > 2_000_000) return send(413, { error: 'Too large.' })
    }
    let msg: any
    try {
      msg = JSON.parse(body)
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const reply = await this.rpc(msg)
    if (reply === null) {
      res.writeHead(202).end()
      return
    }
    send(200, reply)
  }

  /** One JSON-RPC message; null for notifications (no reply). */
  async rpc(msg: any): Promise<unknown> {
    const id = msg?.id
    if (id === undefined || id === null) return null
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'veyra-study', version: VERSION },
          instructions:
            'Veyra Study is the user’s study app: subjects, tasks with due dates, notes and focus-timer study sessions. Dates are local, YYYY-MM-DD. Read before you change anything, and tell the user what you changed.'
        })
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: TOOLS.filter((t) => !t.write || this.hooks.allowWrites()).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === msg.params?.name)
        try {
          if (!tool) throw new ToolError(`There’s no tool called ${msg.params?.name}.`)
          if (tool.write && !this.hooks.allowWrites()) throw new ToolError('Changes from AI apps are turned off. The user can allow them in Veyra Study → Settings → Connections.')
          const st = this.hooks.store()
          if (!st) throw new ToolError('Veyra Study is still opening. Try again in a moment.')
          const out = await tool.run(st, msg.params?.arguments ?? {}, this.hooks)
          return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] })
        } catch (e) {
          return ok({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Something went wrong in Veyra Study.' }], isError: true })
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
    }
  }
}

/* ---------- tools ---------- */
type Args = Record<string, any>
interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  write?: boolean
  run: (st: Store, a: Args, hooks: Hooks) => unknown | Promise<unknown>
}

const isDay = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const subjects = (st: Store) => (st.list('subject') as Rec<'subject'>[]).filter((s) => !s.data.archived)
const subjectName = (st: Store, id: string | null) => (id ? (st.list('subject') as Rec<'subject'>[]).find((s) => s.id === id)?.data.name ?? null : null)
function subjectId(st: Store, name: unknown): string | null {
  if (name === undefined || name === null || name === '') return null
  const n = String(name).trim().toLowerCase()
  const s = subjects(st).find((x) => x.data.name.toLowerCase() === n) ?? subjects(st).find((x) => x.data.name.toLowerCase().includes(n))
  if (!s) throw new ToolError(`No subject called “${name}”. Subjects: ${subjects(st).map((x) => x.data.name).join(', ') || 'none yet'}. Use create_subject to add it.`)
  return s.id
}
const taskView = (st: Store, t: Rec<'task'>) => ({
  id: t.id,
  title: t.data.title,
  subject: subjectName(st, t.data.subjectId),
  due: t.data.due,
  done: t.data.done,
  priority: t.data.priority,
  details: t.data.details || undefined,
  remindAt: t.data.remindAt || undefined,
  steps: t.data.steps?.length ? t.data.steps.map((x) => ({ text: x.text, done: x.done })) : undefined,
  repeats: t.data.repeat ? repeatLabel(t.data.repeat, t.data.due) : undefined
})
const REPEATS: Record<string, Repeat> = {
  daily: { unit: 'day', every: 1 },
  weekdays: { unit: 'week', every: 1, days: [1, 2, 3, 4, 5] },
  weekly: { unit: 'week', every: 1 },
  fortnightly: { unit: 'week', every: 2 },
  monthly: { unit: 'month', every: 1 },
  yearly: { unit: 'year', every: 1 }
}
const stepsFrom = (v: unknown): TaskStep[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const steps = v.map((x) => str(x, 300).trim()).filter(Boolean).slice(0, 50).map((text) => ({ id: randomUUID().slice(0, 8), text, done: false }))
  return steps.length ? steps : undefined
}
const noteFind = (st: Store, id: unknown) => {
  const n = (st.list('note') as Rec<'note'>[]).find((x) => x.id === id && !x.data.trashedAt)
  if (!n) throw new ToolError('No note with that id. Use search_notes to find it.')
  return n
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

const PALETTE = ['#b3492b', '#2f5f8a', '#3f6b4a', '#7a4f9a', '#a86f1d', '#2f7d7a', '#9a3f63', '#5b5a55']
/** A subject by name (or id), archived ones too when asked. */
function findSubject(st: Store, name: unknown, includeArchived = false): Rec<'subject'> {
  const n = String(name ?? '').trim().toLowerCase()
  const all = (st.list('subject') as Rec<'subject'>[]).filter((s) => includeArchived || !s.data.archived)
  const s = all.find((x) => x.id === name) ?? all.find((x) => x.data.name.toLowerCase() === n) ?? all.find((x) => x.data.name.toLowerCase().includes(n))
  if (!s) throw new ToolError(`No subject called “${name}”. Subjects: ${all.map((x) => x.data.name).join(', ') || 'none yet'}. Use create_subject to add it.`)
  return s
}
async function groupCall(h: Hooks, method: string, path: string, body?: unknown) {
  if (!h.group) throw new ToolError('Group work isn’t available here.')
  try {
    return await h.group(method, path, body)
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : 'The group server didn’t answer.')
  }
}
async function findGroup(h: Hooks, name: unknown): Promise<{ id: string; name: string }> {
  const { groups } = await groupCall(h, 'GET', '/groups')
  const n = String(name ?? '').trim().toLowerCase()
  const g = groups.find((x: any) => x.id === name) ?? groups.find((x: any) => x.name.toLowerCase() === n) ?? groups.find((x: any) => x.name.toLowerCase().includes(n))
  if (!g) throw new ToolError(`No group called “${name}”. Groups: ${groups.map((x: any) => x.name).join(', ') || 'none yet'}.`)
  return g
}

const TOOLS: Tool[] = [
  {
    name: 'list_subjects',
    description: 'The user’s subjects (courses), with how many tasks are open and done in each.',
    inputSchema: { type: 'object', properties: {} },
    run: (st) => {
      const tasks = st.list('task') as Rec<'task'>[]
      return subjects(st).map((s) => ({
        name: s.data.name,
        open: tasks.filter((t) => t.data.subjectId === s.id && !t.data.done).length,
        done: tasks.filter((t) => t.data.subjectId === s.id && t.data.done).length
      }))
    }
  },
  {
    name: 'list_tasks',
    description: 'Tasks, open ones by default, sorted by due date. Filter by subject, status and due dates (YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'overdue', 'all'], description: 'Default open.' },
        subject: { type: 'string', description: 'Subject name.' },
        due_before: { type: 'string', description: 'Due on or before this day.' },
        due_after: { type: 'string', description: 'Due on or after this day.' },
        limit: { type: 'number', description: 'Default 50.' }
      }
    },
    run: (st, a) => {
      const sid = a.subject ? subjectId(st, a.subject) : undefined
      const status = ['open', 'done', 'overdue', 'all'].includes(a.status) ? a.status : 'open'
      const t0 = today()
      return (st.list('task') as Rec<'task'>[])
        .filter((t) => (sid === undefined || t.data.subjectId === sid) && (status === 'all' || (status === 'done' ? t.data.done : !t.data.done)))
        .filter((t) => status !== 'overdue' || (!!t.data.due && t.data.due < t0))
        .filter((t) => (!isDay(a.due_before) || (!!t.data.due && t.data.due <= a.due_before)) && (!isDay(a.due_after) || (!!t.data.due && t.data.due >= a.due_after)))
        .sort((x, y) => (x.data.due ?? '9999').localeCompare(y.data.due ?? '9999'))
        .slice(0, Math.min(500, Number(a.limit) || 50))
        .map((t) => taskView(st, t))
    }
  },
  {
    name: 'add_task',
    description: 'Add a task. Due date and reminder are optional.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD' },
        subject: { type: 'string', description: 'Subject name (must exist).' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        details: { type: 'string' },
        remind_at: { type: 'string', description: 'Local time for a reminder, YYYY-MM-DDTHH:MM.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Smaller steps inside the task, in order.' },
        repeat: { type: 'string', enum: Object.keys(REPEATS), description: 'Makes it a repeating task: ticking it off makes the next one.' }
      }
    },
    run: (st, a, h) => {
      const title = str(a.title, 300).trim()
      if (!title) throw new ToolError('A task needs a title.')
      const data: Task = {
        title,
        subjectId: subjectId(st, a.subject),
        done: false,
        completedAt: null,
        due: isDay(a.due) ? a.due : null,
        priority: ['low', 'normal', 'high'].includes(a.priority) ? a.priority : 'normal',
        ...(a.details ? { details: str(a.details, 4000) } : {}),
        ...(typeof a.remind_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.remind_at) ? { remindAt: a.remind_at } : {}),
        ...(stepsFrom(a.steps) ? { steps: stepsFrom(a.steps) } : {}),
        ...(REPEATS[a.repeat] ? { repeat: REPEATS[a.repeat], due: isDay(a.due) ? a.due : today() } : {})
      }
      const rec = st.put('task', data) as Rec<'task'>
      h.changed(['task'], [rec.id])
      return { added: taskView(st, rec) }
    }
  },
  {
    name: 'update_task',
    description: 'Change a task (by id from list_tasks): mark it done or not, rename, move the due date, priority, details or reminder. Use null to clear due or remind_at.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        done: { type: 'boolean' },
        due: { type: ['string', 'null'] },
        subject: { type: ['string', 'null'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        details: { type: 'string' },
        remind_at: { type: ['string', 'null'] }
      }
    },
    run: (st, a, h) => {
      const t = (st.list('task') as Rec<'task'>[]).find((x) => x.id === a.id)
      if (!t) throw new ToolError('No task with that id. Use list_tasks to find it.')
      const d: Task = { ...t.data }
      if (typeof a.title === 'string' && a.title.trim()) d.title = a.title.trim().slice(0, 300)
      let next: Rec<'task'> | null = null
      if (typeof a.done === 'boolean' && a.done !== d.done) {
        d.done = a.done
        d.completedAt = a.done ? Date.now() : null
        // A repeating task carries on: its next one is made (once), same as ticking it in the app.
        if (a.done) {
          const n = nextInSeries(t.id, t.data, today())
          if (n) {
            const all = st.list('task') as Rec<'task'>[]
            next = all.find((x) => x.id === n.id) ?? (st.put('task', n.data, n.id) as Rec<'task'>)
            d.nextId = n.id
          }
        } else d.nextId = null
      }
      if (a.due === null) d.due = null
      else if (isDay(a.due)) d.due = a.due
      if (a.subject === null) d.subjectId = null
      else if (a.subject !== undefined) d.subjectId = subjectId(st, a.subject)
      if (['low', 'normal', 'high'].includes(a.priority)) d.priority = a.priority
      if (typeof a.details === 'string') d.details = a.details.slice(0, 4000)
      if (a.remind_at === null) d.remindAt = null
      else if (typeof a.remind_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.remind_at)) d.remindAt = a.remind_at
      const rec = st.put('task', d, t.id) as Rec<'task'>
      h.changed(['task'], next ? [rec.id, next.id] : [rec.id])
      return { updated: taskView(st, rec), ...(next ? { next: taskView(st, next) } : {}) }
    }
  },
  {
    name: 'search_notes',
    description: 'Find notes by words in the title or text (empty query: the most recent). Returns ids for read_note.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, subject: { type: 'string' }, limit: { type: 'number', description: 'Default 20.' } } },
    run: (st, a) => {
      const q = str(a.query, 200).toLowerCase().split(/\s+/).filter(Boolean)
      const sid = a.subject ? subjectId(st, a.subject) : undefined
      return (st.list('note') as Rec<'note'>[])
        .filter((n) => !n.data.trashedAt)
        .filter((n) => !n.data.archived && (sid === undefined || n.data.subjectId === sid))
        .map((n) => ({ n, text: `${n.data.title} ${docPlain(n.data.content)} ${docPlain(n.data.cues)} ${docPlain(n.data.summary)}`.toLowerCase() }))
        .filter(({ text }) => q.every((w) => text.includes(w)))
        .sort((x, y) => y.n.updatedAt - x.n.updatedAt)
        .slice(0, Math.min(100, Number(a.limit) || 20))
        .map(({ n }) => ({ id: n.id, title: n.data.title || 'Untitled', subject: subjectName(st, n.data.subjectId), excerpt: (n.data.excerpt || '').slice(0, 160), updated: new Date(n.updatedAt).toISOString().slice(0, 16) }))
    }
  },
  {
    name: 'read_note',
    description: 'A whole note as Markdown (attachments and drawings are mentioned, not included).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (st, a) => noteMarkdown(noteFind(st, a.id).data)
  },
  {
    name: 'create_note',
    description: 'Make a new note from Markdown (headings, lists, checklists, quotes, code, bold/italic/links).',
    write: true,
    inputSchema: { type: 'object', required: ['title', 'markdown'], properties: { title: { type: 'string' }, markdown: { type: 'string' }, subject: { type: 'string' } } },
    run: (st, a, h) => {
      const content = markdownToDoc(str(a.markdown, 200_000))
      const rec = st.put('note', { title: str(a.title, 200).trim() || 'Untitled', subjectId: subjectId(st, a.subject), content, excerpt: docPlain(content).slice(0, 300) })
      h.changed(['note'], [rec.id])
      return { created: { id: rec.id, title: (rec.data as { title: string }).title } }
    }
  },
  {
    name: 'append_to_note',
    description: 'Add Markdown to the end of an existing note.',
    write: true,
    inputSchema: { type: 'object', required: ['id', 'markdown'], properties: { id: { type: 'string' }, markdown: { type: 'string' } } },
    run: (st, a, h) => {
      const n = noteFind(st, a.id)
      const add = markdownToDoc(str(a.markdown, 200_000)).content
      const doc = (n.data.content as { type: string; content?: unknown[] } | null) ?? { type: 'doc', content: [] }
      const content = { type: 'doc', content: [...(doc.content ?? []), ...add] }
      st.put('note', { ...n.data, content, excerpt: docPlain(content).slice(0, 300) }, n.id)
      h.changed(['note'], [n.id])
      return { appended: true, id: n.id }
    }
  },
  {
    name: 'study_stats',
    description: 'Focus-timer study time: total minutes per day and per subject over the last N days (default 7).',
    inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    run: (st, a) => {
      const days = Math.min(365, Math.max(1, Number(a.days) || 7))
      const from = Date.now() - days * 86400_000
      const sessions = (st.list('session') as Rec<'session'>[]).filter((s) => s.data.startedAt >= from)
      const byDay: Record<string, number> = {}
      const bySubject: Record<string, number> = {}
      for (const s of sessions) {
        const d = new Date(s.data.startedAt)
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        byDay[k] = (byDay[k] ?? 0) + s.data.durationSec / 60
        const sub = subjectName(st, s.data.subjectId) ?? 'No subject'
        bySubject[sub] = (bySubject[sub] ?? 0) + s.data.durationSec / 60
      }
      const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]))
      return { days, totalMinutes: Math.round(sessions.reduce((m, s) => m + s.data.durationSec / 60, 0)), sessions: sessions.length, minutesByDay: round(byDay), minutesBySubject: round(bySubject) }
    }
  },
  /* ---------- subjects ---------- */
  {
    name: 'create_subject',
    description: 'Add a subject (course). Returns it; notes and tasks can then go in it. Archived ones with the same name come back instead of duplicating.',
    write: true,
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string', description: 'A #rrggbb colour (optional; one is picked otherwise).' } } },
    run: (st, a, h) => {
      const name = str(a.name, 80).trim()
      if (!name) throw new ToolError('A subject needs a name.')
      const all = st.list('subject') as Rec<'subject'>[]
      const same = all.find((s) => s.data.name.toLowerCase() === name.toLowerCase())
      if (same && !same.data.archived) return { exists: { name: same.data.name, id: same.id } }
      const color = /^#[0-9a-f]{6}$/i.test(a.color ?? '') ? a.color : PALETTE[all.length % PALETTE.length]
      const rec = same ? (st.put('subject', { ...same.data, archived: false }, same.id) as Rec<'subject'>) : (st.put('subject', { name, color, order: all.length }) as Rec<'subject'>)
      h.changed(['subject'], [rec.id])
      return { created: { name: rec.data.name, id: rec.id, color: rec.data.color } }
    }
  },
  {
    name: 'update_subject',
    description: 'Rename, recolour, archive (hide) or bring back a subject, found by its current name.',
    write: true,
    inputSchema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', description: 'Current name.' }, new_name: { type: 'string' }, color: { type: 'string' }, archived: { type: 'boolean' } } },
    run: (st, a, h) => {
      const s = findSubject(st, a.subject, true)
      const d = { ...s.data }
      if (typeof a.new_name === 'string' && a.new_name.trim()) d.name = a.new_name.trim().slice(0, 80)
      if (/^#[0-9a-f]{6}$/i.test(a.color ?? '')) d.color = a.color
      if (typeof a.archived === 'boolean') d.archived = a.archived
      st.put('subject', d, s.id)
      h.changed(['subject'], [s.id])
      return { updated: { name: d.name, color: d.color, archived: !!d.archived } }
    }
  },
  {
    name: 'delete_subject',
    description: 'Delete a subject. Its notes and tasks are kept and become "no subject" (or are deleted too with delete_contents).',
    write: true,
    inputSchema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, delete_contents: { type: 'boolean' } } },
    run: (st, a, h) => {
      const s = findSubject(st, a.subject, true)
      const ids: string[] = [s.id]
      for (const kind of ['task', 'note'] as const) {
        for (const r of st.list(kind) as Rec<'task' | 'note'>[]) {
          if (r.data.subjectId !== s.id) continue
          if (a.delete_contents) st.remove(r.id)
          else st.put(kind, { ...r.data, subjectId: null } as never, r.id)
          ids.push(r.id)
        }
      }
      st.remove(s.id)
      h.changed(['subject', 'task', 'note'], ids)
      return { deleted: s.data.name, [a.delete_contents ? 'alsoDeleted' : 'movedToNoSubject']: ids.length - 1 }
    }
  },

  /* ---------- tasks ---------- */
  {
    name: 'delete_task',
    description: 'Delete a task (by id from list_tasks).',
    write: true,
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (st, a, h) => {
      const t = (st.list('task') as Rec<'task'>[]).find((x) => x.id === a.id)
      if (!t) throw new ToolError('No task with that id. Use list_tasks to find it.')
      st.remove(t.id)
      h.changed(['task'], [t.id])
      return { deleted: t.data.title }
    }
  },

  /* ---------- notes ---------- */
  {
    name: 'update_note',
    description:
      'Change a note: rename it, replace its whole text with new Markdown, move it to a subject (null: none), set its tags, pin or archive it. Only what you pass changes. To add text, append_to_note keeps what is there.',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        markdown: { type: 'string', description: 'Replaces the note’s text.' },
        subject: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
        archived: { type: 'boolean' },
        icon: { type: 'string', description: 'An emoji.' }
      }
    },
    run: (st, a, h) => {
      const n = noteFind(st, a.id)
      const d = { ...n.data }
      if (typeof a.title === 'string') d.title = a.title.trim().slice(0, 200)
      if (typeof a.markdown === 'string') {
        d.content = markdownToDoc(str(a.markdown, 200_000))
        d.excerpt = docPlain(d.content).slice(0, 300)
      }
      if (a.subject === null) d.subjectId = null
      else if (a.subject !== undefined) d.subjectId = subjectId(st, a.subject)
      if (Array.isArray(a.tags)) d.tags = a.tags.map((t: unknown) => String(t).toLowerCase().replace(/^#/, '').trim().slice(0, 40)).filter(Boolean).slice(0, 30)
      if (typeof a.pinned === 'boolean') d.pinned = a.pinned
      if (typeof a.archived === 'boolean') d.archived = a.archived
      if (typeof a.icon === 'string') d.icon = a.icon.slice(0, 8)
      st.put('note', d, n.id)
      h.changed(['note'], [n.id])
      return { updated: { id: n.id, title: d.title || 'Untitled', subject: subjectName(st, d.subjectId) } }
    }
  },
  {
    name: 'delete_note',
    description: 'Delete a note (by id from search_notes). archived notes can be found with search_notes include_archived.',
    write: true,
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (st, a, h) => {
      const n = noteFind(st, a.id)
      st.remove(n.id)
      h.changed(['note'], [n.id])
      return { deleted: n.data.title || 'Untitled' }
    }
  },

  /* ---------- study time ---------- */
  {
    name: 'log_study_session',
    description: 'Record study time (as if the focus timer had run): minutes, optional subject, and when it ended (default now).',
    write: true,
    inputSchema: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'number' }, subject: { type: 'string' }, ended_at: { type: 'string', description: 'Local time, YYYY-MM-DDTHH:MM.' }, label: { type: 'string' } } },
    run: (st, a, h) => {
      const minutes = Math.round(Number(a.minutes))
      if (!(minutes > 0 && minutes <= 24 * 60)) throw new ToolError('Minutes must be between 1 and 1440.')
      const end = typeof a.ended_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.ended_at) ? new Date(a.ended_at).getTime() : Date.now()
      const rec = st.put('session', { subjectId: subjectId(st, a.subject), startedAt: end - minutes * 60_000, endedAt: end, durationSec: minutes * 60, ...(a.label ? { label: str(a.label, 120) } : {}) })
      h.changed(['session'], [rec.id])
      return { logged: { minutes, subject: subjectName(st, (rec.data as { subjectId: string | null }).subjectId) } }
    }
  },

  /* ---------- calendar ---------- */
  {
    name: 'list_calendar',
    description: 'Events in the user’s calendars (Google Calendar, calendar links and group deadlines) between two days, plus tasks due then.',
    inputSchema: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD (default today).' }, to: { type: 'string', description: 'YYYY-MM-DD (default a week on).' } } },
    run: async (st, a, h) => {
      const from = isDay(a.from) ? a.from : today()
      const end = new Date((isDay(a.to) ? a.to : '') || new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10))
      const to = isDay(a.to) ? a.to : end.toISOString().slice(0, 10)
      const r = h.events ? await h.events(new Date(from + 'T00:00:00').toISOString(), new Date(to + 'T23:59:59').toISOString()) : { events: [] }
      const tasks = (st.list('task') as Rec<'task'>[]).filter((t) => t.data.due && t.data.due >= from && t.data.due <= to && !t.data.done).map((t) => taskView(st, t))
      return {
        from,
        to,
        events: r.events.map((e) => ({ title: e.title, calendar: e.calendar, start: e.start, end: e.end, allDay: e.allDay, location: e.location || undefined })),
        tasksDue: tasks
      }
    }
  },

  /* ---------- group work ---------- */
  {
    name: 'list_groups',
    description: 'The user’s group-work groups, with their members.',
    inputSchema: { type: 'object', properties: {} },
    run: async (_st, _a, h) => {
      const r = await groupCall(h, 'GET', '/groups')
      return r.groups.map((g: any) => ({ id: g.id, name: g.name, role: g.role, members: g.members.map((m: any) => `${m.displayName} (@${m.username})`) }))
    }
  },
  {
    name: 'list_group_items',
    description: 'What is in a group: its tasks, shared notes (as Markdown), chat messages and deadlines. Filter by kind.',
    inputSchema: { type: 'object', required: ['group'], properties: { group: { type: 'string', description: 'Group name or id.' }, kind: { type: 'string', enum: ['task', 'note', 'message', 'event'] } } },
    run: async (_st, a, h) => {
      const g = await findGroup(h, a.group)
      const r = await groupCall(h, 'GET', `/groups/${encodeURIComponent(g.id)}/items`)
      return r.items
        .filter((i: any) => !a.kind || i.kind === a.kind)
        .map((i: any) => ({
          id: i.id,
          kind: i.kind,
          by: i.createdBy,
          at: new Date(i.updatedAt).toISOString().slice(0, 16),
          ...(i.kind === 'note' ? { title: i.data.title, markdown: noteMarkdown(i.data) } : i.data)
        }))
    }
  },
  {
    name: 'add_to_group',
    description: 'Add to a group: a task (title, due, assignee @username), a shared note (title + markdown), a chat message (text), or a deadline (title, date, time).',
    write: true,
    inputSchema: {
      type: 'object',
      required: ['group', 'kind'],
      properties: {
        group: { type: 'string' },
        kind: { type: 'string', enum: ['task', 'note', 'message', 'event'] },
        title: { type: 'string' },
        markdown: { type: 'string' },
        text: { type: 'string' },
        due: { type: 'string' },
        assignee: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string', description: 'HH:MM' },
        details: { type: 'string' }
      }
    },
    run: async (_st, a, h) => {
      const g = await findGroup(h, a.group)
      const data =
        a.kind === 'task'
          ? { title: str(a.title, 300), details: str(a.details, 4000), assignee: a.assignee ? String(a.assignee).replace(/^@/, '').toLowerCase() : null, due: isDay(a.due) ? a.due : null, done: false, doneBy: null, doneAt: null, priority: 'normal' }
          : a.kind === 'note'
            ? (() => {
                const content = markdownToDoc(str(a.markdown, 200_000))
                return { title: str(a.title, 200), icon: '', content, excerpt: docPlain(content).slice(0, 300) }
              })()
            : a.kind === 'message'
              ? { text: str(a.text, 4000) }
              : { title: str(a.title, 200), date: isDay(a.date) ? a.date : null, time: /^\d{2}:\d{2}$/.test(a.time ?? '') ? a.time : null, details: str(a.details, 2000) }
      const r = await groupCall(h, 'POST', `/groups/${encodeURIComponent(g.id)}/items`, { kind: a.kind, data })
      return { added: { group: g.name, kind: a.kind, id: r.item.id } }
    }
  }
]

/**
 * The stdio bridge AI apps start. It speaks MCP's newline-delimited JSON on
 * stdin/stdout and forwards each message to the app. stdout carries only
 * protocol messages; anything else goes to stderr.
 */
const BRIDGE = `// Veyra Study — connects AI apps (MCP over stdio) to the Veyra Study app on this computer.
// Written by Veyra Study; it reads the port and token from mcp.json next to it.
'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const cfgPath = path.join(__dirname, 'mcp.json')
const TOOLS_WHEN_CLOSED = []
let buf = ''
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
function cfg() { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { return null } }
function post(msg) {
  return new Promise((resolve) => {
    const c = cfg()
    if (!c) return resolve(null)
    const body = JSON.stringify(msg)
    const req = http.request({ host: '127.0.0.1', port: c.port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + c.token }, timeout: 60000 }, (res) => {
      let d = ''
      res.on('data', (x) => (d += x))
      res.on('end', () => { if (res.statusCode === 202) return resolve(undefined); try { resolve(JSON.parse(d)) } catch { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end(body)
  })
}
async function handle(msg) {
  const r = await post(msg)
  if (msg.id === undefined || msg.id === null) return
  if (r) return out(r)
  // Veyra isn't running: still introduce ourselves, and explain on tool calls.
  if (msg.method === 'initialize') return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'veyra-study', version: '${VERSION}' } } })
  if (msg.method === 'ping') return out({ jsonrpc: '2.0', id: msg.id, result: {} })
  if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS_WHEN_CLOSED } })
  if (msg.method === 'tools/call') return out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Open Veyra Study first (and turn on Settings → Connections → AI apps), then try again.' }], isError: true } })
  out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Veyra Study isn’t running.' } })
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { process.stderr.write('veyra-mcp: not JSON\\n'); continue }
    handle(msg).catch((e) => process.stderr.write('veyra-mcp: ' + e + '\\n'))
  }
})
process.stdin.on('end', () => process.exit(0))
`

export const mcpExists = () => existsSync(bridgeFile())

/* ---------- adding Veyra to AI apps ---------- */
export type McpClient = 'claude' | 'gemini'
export const mcpEntry = () => ({ command: process.execPath, args: [bridgeFile()], env: { ELECTRON_RUN_AS_NODE: '1' } })

/** Where each AI app keeps its MCP servers (dev checks can point these elsewhere). */
export function clientConfigPath(client: McpClient): string {
  if (client === 'gemini') return process.env['VEYRA_GEMINI_CONFIG'] || join(homedir(), '.gemini', 'settings.json')
  if (process.env['VEYRA_CLAUDE_CONFIG']) return process.env['VEYRA_CLAUDE_CONFIG']
  const normal = join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  if (existsSync(normal) || existsSync(dirname(normal))) return normal
  // Claude from the Microsoft Store keeps its settings inside its package folder.
  try {
    const pk = join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'Packages')
    const dir = readdirSync(pk).find((d) => /^Claude_/i.test(d) || /^AnthropicPBC\.Claude/i.test(d))
    if (dir) return join(pk, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
  } catch {
    /* no Store apps */
  }
  return normal
}

export function clientHasVeyra(client: McpClient): boolean {
  try {
    return !!JSON.parse(readFileSync(clientConfigPath(client), 'utf8'))?.mcpServers?.['veyra-study']
  } catch {
    return false
  }
}

/** Adds (or updates) Veyra in an AI app's config, keeping everything else and a backup. */
export function addToClient(client: McpClient): string {
  const file = clientConfigPath(client)
  let cfg: any = {}
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8')
    try {
      cfg = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      throw new Error(`Couldn’t read ${file}, so it wasn’t changed. Fix or remove that file, then try again.`)
    }
    copyFileSync(file, file + '.veyra-backup')
  } else mkdirSync(dirname(file), { recursive: true })
  if (typeof cfg !== 'object' || Array.isArray(cfg) || cfg === null) throw new Error(`${file} isn’t a settings file Veyra understands, so it wasn’t changed.`)
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), 'veyra-study': mcpEntry() }
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  return file
}
