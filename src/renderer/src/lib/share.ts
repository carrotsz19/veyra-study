import type { Note } from '@shared/types'
import { groupCall } from '../data/groups'

/**
 * Sharing a note without a group (server: /shares). A share is a read-only copy of the
 * note, kept up to date from here: after you edit a shared note, its newest text is sent.
 * A link opens on the website for anyone who has it; a note sent to someone shows under
 * "Shared with you" in their Notes. Pictures and attachments stay on your device.
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
}

const payload = (n: Note) => ({
  title: n.title?.trim() || 'Untitled',
  content: JSON.stringify({ content: n.content ?? null, cues: n.cues ?? null, summary: n.summary ?? null, template: n.template ?? 'page', icon: n.icon ?? '' } satisfies SharedBody)
})
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
  const r = await groupCall<{ share: ShareInfo }>('POST', '/shares', { noteId, ...payload(note), ...(to ? { to } : {}) })
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
      void groupCall('POST', '/shares/update', { noteId, ...payload(note) }).catch(() => {})
    }, 4000)
  )
}
// Know early which notes are shared (quietly: not signed in or offline just means none yet).
setTimeout(() => void myShares().catch(() => {}), 4000)

/* ---------- notes shared with you ---------- */
export const sharedWithMe = () => groupCall<{ shares: Received[] }>('GET', '/shares/inbox').then((r) => r.shares)
export const readShare = (id: string) => groupCall<{ title: string; content: string; from: Received['from']; updatedAt: number }>('GET', `/shares/${encodeURIComponent(id)}`)
