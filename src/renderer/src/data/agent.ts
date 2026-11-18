import type { DriveRead, Note, Rec, Task } from '@shared/types'
import { docPlain, markdownToDoc, noteMarkdown } from '@shared/notetext'
import { db } from './store'
import { groupCall } from './groups'
import { keepVersion } from '../lib/history'
import { liveNotes, scoreNote, searchTerms, snippet, trashNotes } from '../lib/notes'
import { markdownHtml } from './drive'

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
  /** Where to see it (a Google Doc). */
  url?: string
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
  if (name === 'create_google_doc') return { name, input, label: `Make a Google Doc “${str(input.title, 120) || 'Untitled'}” in your Drive`, preview: str(input.markdown, 4000) }
  if (name === 'add_task') return { name, input, label: `Add a task: ${str(input.title, 200)}${input.due ? ` (due ${str(input.due, 10)})` : ''}`, preview: str(input.notes, 2000) || undefined }
  return { name, input, label: name }
}

/** What a tool gives back: text, or (drive_read) text and the file itself. */
export type ToolAnswer = string | { result: string; file: DriveRead['file'] }

/** Runs one note, task or Drive tool here. Returns what the agent gets back. */
export async function runAppTool(name: string, input: Record<string, unknown>, ctx: NoteContext | null, changed: (c: AgentChange) => void): Promise<ToolAnswer> {
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
    case 'drive_search': {
      const found = await window.veyra.drive.search(str(input.query, 300), Math.min(25, Math.max(1, Number(input.limit) || 10)))
      if (!found.length) return input.query ? 'No Drive files match.' : 'There are no files in this Drive.'
      return found
        .map((f) => `- id: ${f.id} · “${f.name}” · ${driveKind(f.mimeType)} · changed ${f.modified.slice(0, 10)}${f.owner ? ` · ${f.owner}` : ''}${f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ''}`)
        .join('\n')
    }
    case 'drive_read': {
      const r = await window.veyra.drive.read(str(input.id, 200))
      const about = `“${r.name}” (${driveKind(r.mime)}).${r.note ? ` ${r.note}` : ''}`
      // Text goes in the result itself; PDFs and pictures go along as the file.
      return r.file.type === 'text' ? `${about}\n\n${r.file.data}` : { result: about, file: r.file }
    }
    case 'create_google_doc': {
      const title = str(input.title, 200).trim() || 'Untitled'
      const doc = await window.veyra.drive.createDoc(title, markdownHtml(str(input.markdown)))
      changed({ id: doc.id, label: `Made the Google Doc “${title}”`, url: doc.url, undo: async () => void (await window.veyra.drive.trash(doc.id)) })
      return `Made the Google Doc “${title}”: ${doc.url}`
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
  req: { message: string; history: { role: 'user' | 'assistant'; text: string }[]; model?: string; note: NoteContext | null; web: boolean; subagents: boolean; files?: AgentFile[]; drive?: boolean },
  on: { event: (e: AgentEvent) => void; approve: (ask: ToolAsk) => Promise<boolean>; changed: (c: AgentChange) => void; tool: (label: string) => void }
): AgentRun {
  let id: string | null = null
  let stopped = false
  void (async () => {
    try {
      const note = req.note ? { title: req.note.title, markdown: req.note.markdown() } : undefined
      const run = await groupCall<{ id: string }>('POST', '/ai/agent/runs', {
        message: req.message,
        history: req.history,
        model: req.model,
        note,
        web: req.web,
        subagents: req.subagents,
        ...(req.files?.length ? { attachments: req.files.map(({ type, name, mime, data }) => ({ type, name, mime, data })) } : {}),
        ...(req.drive ? { drive: true } : {})
      })
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
      const out = await runAppTool(ev.name, ev.input, req.note, on.changed)
      await reply(typeof out === 'string' ? { result: out } : out)
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
  if (name === 'drive_search') return input.query ? `Searched your Google Drive for “${str(input.query, 60)}”` : 'Looked through your recent Drive files'
  if (name === 'drive_read') return 'Read a file from your Google Drive'
  return name
}

/* ---------- saved chats (this device) ---------- */
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  /** Names of the files sent with this message (never the files: chats are kept in localStorage). */
  files?: string[]
  /** The assistant's steps, plan, subagents and sources, for showing again. */
  steps?: { label: string; state?: 'done' | 'error' | 'running' }[]
  plan?: Extract<AgentEvent, { t: 'plan' }>['items']
  sources?: { url: string; title: string }[]
  changes?: { label: string }[]
  error?: string
  note?: string
}
/**
 * Chats by id, on this device, one list per account (the guest's is the old shared one):
 * - a note's current chat under the note's id, and its earlier ones as `<noteId>~<time>` (New chat);
 * - chats of their own, from the Veyra AI tab, as `chat:<uuid>`.
 * The Veyra AI tab lists them all; a note's Assistant shows that note's current chat.
 * Chats changed here are marked, so chat sync (data/chat-sync.ts) sends just those.
 */
export interface SavedChat {
  at: number
  turns: ChatTurn[]
  /** The note it belongs to (null: a chat of its own). Older saves leave it out: see noteOf. */
  noteId?: string | null
  /** The note's name, or the chat's: from the first question, unless renamed (named). */
  title?: string
  named?: boolean
  /** Chats of the Veyra AI tab each keep their model. */
  model?: string
}
type Saved = Record<string, SavedChat>
const LEGACY_KEY = 'veyra.assistant.chats'
let owner: string | null = null
const chatsKey = () => (owner ? `${LEGACY_KEY}.${owner}` : LEGACY_KEY)
const dirtyKey = () => `${chatsKey()}.dirty`
/**
 * Whose chats these are (the signed-in username, or null for no account). Set before anything reads
 * them. The first account to sign in after this update takes over the chats kept before it.
 */
export function setChatOwner(username: string | null): void {
  owner = username ? username.toLowerCase() : null
  if (!owner) return
  try {
    if (localStorage.getItem(chatsKey()) === null) {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) {
        localStorage.setItem(chatsKey(), legacy)
        localStorage.removeItem(LEGACY_KEY)
      }
    }
  } catch {
    /* storage unavailable */
  }
}
export const chatOwner = () => owner

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}
const readChats = (): Saved => readJson<Saved>(chatsKey(), {})
/** Chats changed here and not yet synced: id → when it was marked. */
const readDirty = (): Record<string, number> => readJson<Record<string, number>>(dirtyKey(), {})
function writeChats(all: Saved, touched: string[] = []): void {
  // Keep the 300 most recent chats.
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 300)
  try {
    localStorage.setItem(chatsKey(), JSON.stringify(Object.fromEntries(keep)))
    if (touched.length && owner) {
      const dirty = readDirty()
      const at = Date.now()
      for (const id of touched) dirty[id] = at
      localStorage.setItem(dirtyKey(), JSON.stringify(dirty))
    }
  } catch {
    /* storage full or unavailable */
  }
  window.dispatchEvent(new Event('veyra:chats'))
}
const noteOf = (id: string, c: Partial<SavedChat>): string | null => (c.noteId !== undefined ? c.noteId : id.startsWith('chat:') ? null : id.split('~')[0])
/** A new chat of its own (saved once something is asked). */
export const newChatId = () => `chat:${crypto.randomUUID()}`
const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t
}

export const loadChat = (id: string): ChatTurn[] => readChats()[id]?.turns ?? []
export function chatInfo(id: string): { noteId: string | null; title?: string; model?: string } | null {
  const c = readChats()[id]
  return c ? { noteId: noteOf(id, c), title: c.title, model: c.model } : null
}
export function saveChat(id: string, turns: ChatTurn[], meta: { title?: string; noteId?: string | null; model?: string } = {}): void {
  const all = readChats()
  const was = all[id]
  if (turns.length) {
    const noteId = meta.noteId !== undefined ? meta.noteId : noteOf(id, was ?? {})
    const first = turns.find((t) => t.role === 'user')?.text ?? ''
    const title = was?.named ? was.title : noteId ? meta.title || was?.title : was?.title || titleFrom(first)
    all[id] = { ...was, at: Date.now(), turns: turns.slice(-40), noteId, title, ...(meta.model ? { model: meta.model } : {}) }
  } else {
    if (!was) return
    delete all[id]
  }
  writeChats(all, [id])
}
export function renameChat(id: string, title: string): void {
  const all = readChats()
  if (!all[id]) return
  all[id] = { ...all[id], title: title.trim() || all[id].title, named: !!title.trim(), at: Date.now() }
  writeChats(all, [id])
}

export interface PastChat {
  id: string
  /** The note it belongs to, or null for a chat of its own. */
  noteId: string | null
  /** The chat's name (a chat of its own), or the note's name when it was last saved. */
  title?: string
  at: number
  /** The first question asked, for the list. */
  first: string
  count: number
  /** It's the note's current chat (not one put away by New chat). */
  current: boolean
}
/** Every saved chat, newest first. */
export function listChats(): PastChat[] {
  return Object.entries(readChats())
    .filter(([, c]) => c.turns?.length)
    .map(([id, c]) => {
      const noteId = noteOf(id, c)
      return { id, noteId, title: c.title, at: c.at, first: c.turns.find((t) => t.role === 'user')?.text ?? '', count: c.turns.length, current: !!noteId && id === noteId }
    })
    .sort((a, b) => b.at - a.at)
}
/** New chat: the note's current chat is kept in Past chats. */
export function archiveChat(noteId: string): void {
  const all = readChats()
  const cur = all[noteId]
  if (!cur?.turns?.length) return
  const kept = `${noteId}~${cur.at}`
  all[kept] = { ...cur, noteId, at: Date.now() }
  delete all[noteId]
  writeChats(all, [noteId, kept])
}
/**
 * Makes a saved chat the current chat of a note (that note's current chat is kept in Past chats).
 * Used to reopen a chat on its own note, or to continue one from a deleted note in this one.
 */
export function resumeChat(id: string, intoNoteId: string, title?: string): ChatTurn[] {
  const all = readChats()
  const chat = all[id]
  if (!chat) return []
  if (id !== intoNoteId) {
    const cur = all[intoNoteId]
    const touched = [id, intoNoteId]
    if (cur?.turns?.length) {
      all[`${intoNoteId}~${cur.at}`] = { ...cur, noteId: intoNoteId, at: Date.now() }
      touched.push(`${intoNoteId}~${cur.at}`)
    }
    delete all[id]
    all[intoNoteId] = { ...chat, at: Date.now(), noteId: intoNoteId, title: title ?? chat.title }
    writeChats(all, touched)
  }
  return chat.turns
}
export function deleteChat(id: string): void {
  const all = readChats()
  delete all[id]
  writeChats(all, [id])
}

/* ---------- for chat sync (data/chat-sync.ts) ---------- */
/** What changed here since the last sync: chats to send, chats deleted, and the marks to clear once sent. */
export function pendingChats(): { put: { id: string; chat: SavedChat }[]; del: { id: string; at: number }[]; marks: Record<string, number> } {
  const marks = readDirty()
  const all = readChats()
  const put: { id: string; chat: SavedChat }[] = []
  const del: { id: string; at: number }[] = []
  for (const [id, at] of Object.entries(marks)) {
    if (all[id]) put.push({ id, chat: all[id] })
    else del.push({ id, at })
  }
  return { put, del, marks }
}
/** Clears the marks that were sent (a chat changed again meanwhile keeps its newer mark). */
export function clearPending(sent: Record<string, number>): void {
  const dirty = readDirty()
  for (const [id, at] of Object.entries(sent)) if (dirty[id] === at) delete dirty[id]
  try {
    localStorage.setItem(dirtyKey(), JSON.stringify(dirty))
  } catch {
    /* storage unavailable */
  }
}
/** Marks every chat here to be sent (sync just turned on, or started over). */
export function markAllChats(): void {
  const all = readChats()
  const dirty = readDirty()
  const at = Date.now()
  for (const id of Object.keys(all)) dirty[id] = at
  try {
    localStorage.setItem(dirtyKey(), JSON.stringify(dirty))
  } catch {
    /* storage unavailable */
  }
}
/** Chats from your other devices: the newest edit of each wins (a delete too). */
export function applyRemoteChats(list: ({ id: string; at: number; deleted: true } | { id: string; at: number; deleted?: false; chat: SavedChat })[]): number {
  if (!list.length) return 0
  const all = readChats()
  const dirty = readDirty()
  let changed = 0
  for (const r of list) {
    const local = all[r.id]
    // A local delete not yet sent counts as newer when it was marked after the remote edit.
    if (!local && dirty[r.id] && dirty[r.id] >= r.at) continue
    if (local && local.at >= r.at) continue
    if (r.deleted) {
      if (local) {
        delete all[r.id]
        changed++
      }
    } else {
      all[r.id] = { ...r.chat, at: r.at }
      changed++
    }
    delete dirty[r.id]
  }
  if (changed) {
    try {
      localStorage.setItem(dirtyKey(), JSON.stringify(dirty))
    } catch {
      /* storage unavailable */
    }
    writeChats(all)
  }
  return changed
}

/** Asks the next note editor for this note to open with the Assistant showing. */
export const OPEN_ASSISTANT_KEY = 'veyra.openAssistant'

export const TURBO_KEY = 'veyra.assistant.turbo'
/** The person's Web search and Subagents switches ('1' on, '0' off; on unless set). */
export const WEB_KEY = 'veyra.assistant.web'
export const SUBAGENTS_KEY = 'veyra.assistant.subagents'
/** The person's Google Drive switch (on unless set; only shown when Drive allows it). */
export const DRIVE_KEY = 'veyra.assistant.drive'

const driveKind = (mime: string) =>
  ({
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/pdf': 'PDF'
  })[mime] ?? (mime.startsWith('image/') ? 'picture' : mime.startsWith('text/') ? 'text file' : mime || 'file')

/* ---------- files sent with a message ---------- */
/** A file ready to send (server/agent.mjs checks it again): pictures shrunk, PDFs as they are, text as text. */
export interface AgentFile {
  type: 'image' | 'pdf' | 'text'
  name: string
  mime?: string
  data: string
  /** Bytes sent, roughly (for the chip). */
  size: number
}
export const MAX_FILES = 5
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|jsx|ts|tsx|py|java|c|cc|cpp|h|cs|go|rs|rb|php|swift|kt|sql|ya?ml|tex|log|ini|toml)$/i

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** About 1.15 megapixels (1568 px at most), as JPEG: the most detail Claude uses, for the fewest tokens. */
async function shrink(file: File): Promise<AgentFile> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error(`“${file.name}” is a kind of picture that can’t be read here. Try a JPEG or PNG.`)
  }
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height), Math.sqrt(1_150_000 / (bmp.width * bmp.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  const g = canvas.getContext('2d')!
  g.fillStyle = '#fff' // transparent parts (JPEG has none)
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  return { type: 'image', name: file.name || 'picture.jpg', mime: 'image/jpeg', data, size: Math.round((data.length * 3) / 4) }
}

/** Gets a picked, pasted or dropped file ready to send, or says why it can't be. */
export async function prepareFile(file: File): Promise<AgentFile> {
  const name = file.name || 'file'
  if (file.type.startsWith('image/')) return shrink(file)
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`“${name}” is over 10 MB, which is too big to send.`)
    return { type: 'pdf', name, mime: 'application/pdf', data: toBase64(await file.arrayBuffer()), size: file.size }
  }
  if (file.type.startsWith('text/') || /^application\/(json|xml)/.test(file.type) || TEXT_EXT.test(name)) {
    if (file.size > 2 * 1024 * 1024) throw new Error(`“${name}” is too long to send.`)
    const text = await file.text()
    if (text.length > 150_000) throw new Error(`“${name}” is too long to send (up to 150,000 characters).`)
    return { type: 'text', name, data: text, size: file.size }
  }
  throw new Error(`The Assistant can read pictures, PDFs and text files, not “${name}”. For Word or PowerPoint files, save them as PDF first.`)
}
