import type { Note, Rec, Task } from '@shared/types'
import { docPlain, markdownToDoc, noteMarkdown } from '@shared/notetext'
import { db } from './store'
import { groupCall } from './groups'
import { keepVersion } from '../lib/history'
import { liveNotes, scoreNote, searchTerms, snippet, trashNotes } from '../lib/notes'

/* =====================================================================
   The Assistant (Veyra AI agent) on this device: starts a task on the
   Veyra server (server/agent.mjs), reads what happens, and runs the tools
   that touch notes and tasks here, asking before any change unless Turbo
   is on. Every change can be undone.
===================================================================== */

export type AgentEvent =
  | { t: 'model'; label: string; downgraded: boolean }
  | { t: 'text'; a: string; s: string }
  | { t: 'think'; a: string }
  | { t: 'tool'; a: string; name: string; label: string }
  | { t: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'done' }[] }
  | { t: 'sub'; id: string; title: string; state: 'running' | 'done' | 'error'; note?: string }
  | { t: 'call'; id: string; a: string; name: string; input: Record<string, unknown>; write: boolean }
  | { t: 'sources'; items: { url: string; title: string }[] }
  | { t: 'end'; error?: string; note?: string }

/** What the open note gives the Assistant: what it is, and a way to add to it through the editor. */
export interface NoteContext {
  id: string
  title: string
  markdown: () => string
  /** Adds Markdown at the end of the open note, through the editor. */
  append: (markdown: string) => void
  /** The open note as it is now, and putting an earlier copy back (for Undo). */
  snapshot: () => Note
  restore: (was: Note) => void
}

/** A change the Assistant made, with how to take it back. */
export interface AgentChange {
  id: string
  label: string
  undo?: () => Promise<void>
  undone?: boolean
}

export interface ToolAsk {
  name: string
  input: Record<string, unknown>
  /** Short description of the change for the approval card. */
  label: string
  preview?: string
}

const str = (v: unknown, max = 200_000) => (typeof v === 'string' ? v.slice(0, max) : '')
const subjectName = async (id: string | null | undefined) => (id ? ((await db.list('subject')) as Rec<'subject'>[]).find((s) => s.id === id)?.data.name ?? null : null)

/** How a change is described in its approval card. */
export async function describeChange(name: string, input: Record<string, unknown>, ctx: NoteContext | null): Promise<ToolAsk> {
  if (name === 'create_note') return { name, input, label: `Create a note “${str(input.title, 120) || 'Untitled'}”`, preview: str(input.markdown, 4000) }
  if (name === 'append_to_note') {
    const id = str(input.id, 100)
    const title = id === 'current' || id === ctx?.id ? ctx?.title || 'this note' : ((await db.list('note')) as Rec<'note'>[]).find((n) => n.id === id)?.data.title || 'a note'
    return { name, input, label: `Add to “${title}”`, preview: str(input.markdown, 4000) }
  }
  if (name === 'add_task') return { name, input, label: `Add a task: ${str(input.title, 200)}${input.due ? ` (due ${str(input.due, 10)})` : ''}`, preview: str(input.notes, 2000) || undefined }
  return { name, input, label: name }
}

/** Runs one note or task tool here. Returns the text the agent gets back. */
export async function runAppTool(name: string, input: Record<string, unknown>, ctx: NoteContext | null, changed: (c: AgentChange) => void): Promise<string> {
  const notes = () => db.list('note') as Promise<Rec<'note'>[]>
  const find = async (id: string) => {
    const n = (await notes()).find((x) => x.id === (id === 'current' && ctx ? ctx.id : id))
    if (!n || n.data.trashedAt) throw new Error('There’s no note with that id. Use search_notes to find it.')
    return n
  }
  switch (name) {
    case 'search_notes': {
      const terms = searchTerms(str(input.query, 300))
      const limit = Math.min(30, Math.max(1, Number(input.limit) || 10))
      const found = liveNotes(await notes())
        .filter((n) => !n.data.archived)
        .map((n) => ({ n, score: scoreNote(n, terms) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.n.updatedAt - a.n.updatedAt)
        .slice(0, limit)
      if (!found.length) return 'No notes match.'
      const rows = await Promise.all(
        found.map(async ({ n }) => `- id: ${n.id} · “${n.data.title || 'Untitled'}”${(await subjectName(n.data.subjectId)) ? ` · ${await subjectName(n.data.subjectId)}` : ''} · ${new Date(n.updatedAt).toISOString().slice(0, 10)}\n  ${(snippet(n, terms) ?? n.data.excerpt ?? '').slice(0, 200)}`)
      )
      return rows.join('\n')
    }
    case 'read_note': {
      const id = str(input.id, 100)
      if ((id === 'current' || id === ctx?.id) && ctx) return `# ${ctx.title || 'Untitled'}\n\n${ctx.markdown()}`
      return noteMarkdown((await find(id)).data)
    }
    case 'list_tasks': {
      const all = (await db.list('task')) as Rec<'task'>[]
      const list = all.filter((t) => input.include_done || !t.data.done).sort((a, b) => (a.data.due ?? '9999').localeCompare(b.data.due ?? '9999')).slice(0, 100)
      if (!list.length) return 'No tasks.'
      const rows = await Promise.all(list.map(async (t) => `- ${t.data.done ? '[done] ' : ''}${t.data.title}${t.data.due ? ` · due ${t.data.due}` : ''}${(await subjectName(t.data.subjectId)) ? ` · ${await subjectName(t.data.subjectId)}` : ''}`))
      return rows.join('\n')
    }
    case 'create_note': {
      const content = markdownToDoc(str(input.markdown))
      const title = str(input.title, 200).trim() || 'Untitled'
      const rec = await db.put('note', { title, subjectId: null, content, excerpt: docPlain(content).slice(0, 300) } as Note)
      changed({ id: rec.id, label: `Created “${title}”`, undo: async () => void (await trashNotes([rec])) })
      return `Created the note “${title}” (id ${rec.id}).`
    }
    case 'append_to_note': {
      const id = str(input.id, 100)
      const md = str(input.markdown)
      if ((id === 'current' || id === ctx?.id) && ctx) {
        // The note as it was goes into its Version history first (Undo below, or Version history).
        const before = ctx.snapshot()
        await keepVersion(ctx.id, before, Date.now()).catch(() => false)
        ctx.append(md)
        changed({ id: `${ctx.id}:${Date.now()}`, label: `Added to “${ctx.title || 'this note'}”`, undo: async () => ctx.restore(before) })
        return `Added to the open note “${ctx.title}”.`
      }
      const n = await find(id)
      // The note as it was goes into its Version history first.
      await keepVersion(n.id, n.data, Date.now()).catch(() => false)
      const doc = (n.data.content as { type: string; content?: unknown[] } | null) ?? { type: 'doc', content: [] }
      const content = { type: 'doc', content: [...(doc.content ?? []), ...markdownToDoc(md).content] }
      const was = n.data
      await db.put('note', { ...n.data, content, excerpt: docPlain(content).slice(0, 300) }, n.id)
      changed({ id: `${n.id}:${Date.now()}`, label: `Added to “${n.data.title || 'Untitled'}”`, undo: async () => void (await db.put('note', was, n.id)) })
      return `Added to “${n.data.title}”.`
    }
    case 'add_task': {
      const title = str(input.title, 300).trim()
      if (!title) throw new Error('A task needs a title.')
      const due = /^\d{4}-\d{2}-\d{2}$/.test(str(input.due, 10)) ? str(input.due, 10) : null
      const rec = await db.put('task', { title, subjectId: null, done: false, completedAt: null, due, priority: 'normal', ...(input.notes ? { details: str(input.notes, 5000) } : {}) } as Task)
      changed({ id: rec.id, label: `Added the task “${title}”`, undo: async () => void (await db.remove('task', rec.id)) })
      return `Added the task “${title}”${due ? `, due ${due}` : ''}.`
    }
    default:
      throw new Error('That tool isn’t available.')
  }
}

export interface AgentRun {
  stop: () => void
}

/**
 * Starts a task and follows it. `approve` is asked before each change (it resolves false to
 * decline); `onEvent` gets everything that happens, in order.
 */
export function startAgent(
  req: { message: string; history: { role: 'user' | 'assistant'; text: string }[]; model?: string; note: NoteContext | null; web: boolean; subagents: boolean },
  on: { event: (e: AgentEvent) => void; approve: (ask: ToolAsk) => Promise<boolean>; changed: (c: AgentChange) => void; tool: (label: string) => void }
): AgentRun {
  let id: string | null = null
  let stopped = false
  void (async () => {
    try {
      const note = req.note ? { title: req.note.title, markdown: req.note.markdown() } : undefined
      const run = await groupCall<{ id: string }>('POST', '/ai/agent/runs', { message: req.message, history: req.history, model: req.model, note, web: req.web, subagents: req.subagents })
      id = run.id
      if (stopped) return void groupCall('DELETE', `/ai/agent/runs/${encodeURIComponent(run.id)}`).catch(() => {})
      let from = 0
      for (let fails = 0; !stopped; ) {
        let page: { events: AgentEvent[]; next: number; done: boolean }
        try {
          page = await groupCall('GET', `/ai/agent/runs/${encodeURIComponent(run.id)}?from=${from}`)
          fails = 0
        } catch (e) {
          if (++fails >= 4) throw e
          await new Promise((r) => setTimeout(r, 1000 * fails))
          continue
        }
        from = page.next
        for (const ev of page.events) {
          if (stopped) return
          on.event(ev)
          if (ev.t === 'call') void answer(run.id, ev)
        }
        if (page.done) return
      }
    } catch (e) {
      if (!stopped) on.event({ t: 'end', error: e instanceof Error ? e.message : 'Couldn’t reach Veyra AI.' })
    }
  })()

  async function answer(runId: string, ev: Extract<AgentEvent, { t: 'call' }>) {
    const reply = (body: Record<string, unknown>) => groupCall('POST', `/ai/agent/runs/${encodeURIComponent(runId)}/calls/${encodeURIComponent(ev.id)}`, body).catch(() => {})
    try {
      if (ev.write) {
        const ok = await on.approve(await describeChange(ev.name, ev.input, req.note))
        if (!ok) return void (await reply({ denied: true }))
      } else on.tool(readLabel(ev.name, ev.input))
      await reply({ result: await runAppTool(ev.name, ev.input, req.note, on.changed) })
    } catch (e) {
      await reply({ error: e instanceof Error ? e.message : 'That didn’t work.' })
    }
  }

  return {
    stop: () => {
      stopped = true
      if (id) void groupCall('DELETE', `/ai/agent/runs/${encodeURIComponent(id)}`).catch(() => {})
    }
  }
}

/** "Searching your notes for “cells”" etc., for the steps list. */
export function readLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'search_notes') return input.query ? `Searched your notes for “${str(input.query, 60)}”` : 'Looked through your recent notes'
  if (name === 'read_note') return input.id === 'current' ? 'Read this note' : 'Read a note'
  if (name === 'list_tasks') return 'Looked at your tasks'
  return name
}

/* ---------- saved chats (this device) ---------- */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** The assistant's steps, plan, subagents and sources, for showing again. */
  steps?: { label: string; state?: 'done' | 'error' | 'running' }[]
  plan?: Extract<AgentEvent, { t: 'plan' }>['items']
  sources?: { url: string; title: string }[]
  changes?: { label: string }[]
  error?: string
  note?: string
}
const CHATS_KEY = 'veyra.assistant.chats'
type Saved = Record<string, { at: number; turns: ChatTurn[] }>
const readChats = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) ?? '{}') as Saved
  } catch {
    return {}
  }
}
export const loadChat = (noteId: string): ChatTurn[] => readChats()[noteId]?.turns ?? []
export function saveChat(noteId: string, turns: ChatTurn[]): void {
  const all = readChats()
  if (turns.length) all[noteId] = { at: Date.now(), turns: turns.slice(-40) }
  else delete all[noteId]
  // Keep the 30 most recent chats.
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30)
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(Object.fromEntries(keep)))
  } catch {
    /* storage full or unavailable */
  }
}

export const TURBO_KEY = 'veyra.assistant.turbo'
/** The person's Web search and Subagents switches ('1' on, '0' off; on unless set). */
export const WEB_KEY = 'veyra.assistant.web'
export const SUBAGENTS_KEY = 'veyra.assistant.subagents'
