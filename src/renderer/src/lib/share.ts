import type { Note } from '@shared/types'
import { groupCall } from '../data/groups'

/**
 * Sharing a note without a group (server: /shares). A share is a read-only copy of the
 * note, kept up to date from here: after you edit a shared note, its newest text is sent.
 * A link opens on the website for anyone who has it; a note sent to someone shows under
 * "Shared with you" in their Notes. Its pictures, attachments and picture cover are uploaded
 * once each and the copy points at them ("sf_..." ids on the server).
 */

/** Where share links open: the website (the same for every build). */
export const SHARE_SITE = 'https://veyra-study-web.igreenrobotz.workers.dev'
export const shareLink = (id: string) => `${SHARE_SITE}/s/${id}`

export interface ShareInfo {
  id: string
  noteId: string
  to: { username: string; displayName: string; photoUrl?: string } | null
  updatedAt: number
}
export interface Received {
  id: string
  title: string
  from: { username: string; displayName: string; photoUrl?: string }
  updatedAt: number
}
/** What a share carries: the note's text areas (as TipTap documents) and how it's laid out. */
export interface SharedBody {
  content: unknown
  cues?: unknown
  summary?: unknown
  template?: string
  icon?: string
  /** A cover gradient's name, or "img:sf_..." for a picture. */
  cover?: string | null
}

/* ---------- files: uploaded once, then the shared copy points at them ---------- */
const toB64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
// Files already on the server this session (the server keeps them while a share uses them).
const known = new Map<string, Promise<string | null>>()
/** The server's id for one of your files: asked by its fingerprint, uploaded only if it's new. Null if it can't be read here. */
function serverFile(localId: string, name: string, mime: string): Promise<string | null> {
  if (localId.startsWith('sf_')) return Promise.resolve(localId)
  let p = known.get(localId)
  if (!p) {
    p = (async () => {
      let bytes: Uint8Array
      try {
        bytes = await window.veyra.files.read(localId)
      } catch {
        return null
      }
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const have = await groupCall<{ id: string | null }>('POST', '/files/have', { sha })
      return have.id ?? (await groupCall<{ id: string }>('POST', '/files', { name, mime, data: toB64(bytes) })).id
    })()
    p.catch(() => known.delete(localId))
    known.set(localId, p)
  }
  return p
}
type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] }
/** A copy of a document with each attachment's id swapped (or left alone when swap gives null). */
export async function swapFiles(doc: unknown, swap: (id: string, name: string, mime: string) => Promise<string | null>): Promise<unknown> {
  const walk = async (n: Node): Promise<Node> => {
    if (!n || typeof n !== 'object') return n
    const out: Node = { ...n }
    if (n.type === 'attachment' && typeof n.attrs?.id === 'string') {
      const id = await swap(n.attrs.id, String(n.attrs.name ?? 'File'), String(n.attrs.mime ?? ''))
      if (id) out.attrs = { ...n.attrs, id }
    }
    if (Array.isArray(n.content)) out.content = await Promise.all(n.content.map(walk))
    return out
  }
  return doc ? walk(doc as Node) : doc
}

async function payload(n: Note) {
  const up = (id: string, name: string, mime: string) => serverFile(id, name, mime)
  let cover: string | null = n.cover ?? null
  if (cover?.startsWith('img:')) {
    const id = await serverFile(cover.slice(4), 'cover', 'image/jpeg').catch(() => null)
    cover = id ? `img:${id}` : null
  }
  const body: SharedBody = {
    content: await swapFiles(n.content ?? null, up),
    cues: await swapFiles(n.cues ?? null, up),
    summary: await swapFiles(n.summary ?? null, up),
    template: n.template ?? 'page',
    icon: n.icon ?? '',
    cover
  }
  return { title: n.title?.trim() || 'Untitled', content: JSON.stringify(body) }
}
export const parseBody = (text: string): SharedBody => {
  try {
    return JSON.parse(text) as SharedBody
  } catch {
    return { content: null }
  }
}

/* ---------- which of your notes are shared (so edits get sent) ---------- */
let mine: ShareInfo[] | null = null
let loading: Promise<ShareInfo[]> | null = null
export function myShares(fresh = false): Promise<ShareInfo[]> {
  if (mine && !fresh) return Promise.resolve(mine)
  loading ??= groupCall<{ shares: ShareInfo[] }>('GET', '/shares/mine')
    .then((r) => (mine = r.shares))
    .finally(() => (loading = null))
  return loading
}
export const sharesOf = async (noteId: string) => (await myShares()).filter((s) => s.noteId === noteId)

export async function shareNote(noteId: string, note: Note, to?: string): Promise<ShareInfo> {
  const r = await groupCall<{ share: ShareInfo }>('POST', '/shares', { noteId, ...(await payload(note)), ...(to ? { to } : {}) })
  await myShares(true)
  return r.share
}
export async function stopSharing(id: string): Promise<void> {
  await groupCall('DELETE', `/shares/${encodeURIComponent(id)}`)
  if (mine) mine = mine.filter((s) => s.id !== id)
}

/** After a shared note is saved: send its newest text (a few seconds after the last change). */
const waiting = new Map<string, ReturnType<typeof setTimeout>>()
export function noteSaved(noteId: string, note: Note): void {
  if (!mine?.some((s) => s.noteId === noteId)) return
  const t = waiting.get(noteId)
  if (t) clearTimeout(t)
  waiting.set(
    noteId,
    setTimeout(() => {
      waiting.delete(noteId)
      void payload(note)
        .then((p) => groupCall('POST', '/shares/update', { noteId, ...p }))
        .catch(() => {})
    }, 4000)
  )
}
// Know early which notes are shared (quietly: not signed in or offline just means none yet).
setTimeout(() => void myShares().catch(() => {}), 4000)

/* ---------- notes shared with you ---------- */
export const sharedWithMe = () => groupCall<{ shares: Received[] }>('GET', '/shares/inbox').then((r) => r.shares)
/** A shared file, read while signed in (the person it was sent to, or its owner). */
export const readSharedFile = (id: string) => groupCall<{ mime: string; data: string; name: string }>('GET', `/files/${encodeURIComponent(id)}`)
export const readShare = (id: string) => groupCall<{ title: string; content: string; from: Received['from']; updatedAt: number }>('GET', `/shares/${encodeURIComponent(id)}`)
