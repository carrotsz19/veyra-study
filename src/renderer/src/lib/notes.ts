import type { Note, Rec } from '@shared/types'
import { db } from '../data/store'
import { dropHistory, tidyHistory } from './history'

/**
 * Notes helpers shared by the notes list, Today and the Ctrl+K palette:
 * the trash (deleted notes wait 30 days before they're gone) and search
 * through a note's whole text, not just its title and opening lines.
 */

export const TRASH_DAYS = 30
const DAY = 86_400_000

export const isTrashed = (n: Rec<'note'>): boolean => !!n.data.trashedAt
export const liveNotes = (list: Rec<'note'>[]): Rec<'note'>[] => list.filter((n) => !n.data.trashedAt)

/** Days until a note in the trash is removed for good (at least 0). */
export const daysLeft = (n: Rec<'note'>): number => Math.max(0, Math.ceil(((n.data.trashedAt ?? 0) + TRASH_DAYS * DAY - Date.now()) / DAY))

// Notes open in an editor: hands over the editor's newest copy (and stops its pending save),
// so trashing an open note keeps the last words typed and isn't undone by that save.
const openEditors = new Map<string, (trashedAt: number) => Note>()
export function registerOpenNote(id: string, take: (trashedAt: number) => Note): () => void {
  openEditors.set(id, take)
  return () => void (openEditors.get(id) === take && openEditors.delete(id))
}

/** Moves notes to the trash; returns what to run to put them back. */
export async function trashNotes(list: Rec<'note'>[]): Promise<() => void> {
  const at = Date.now()
  const newest = list.map((n) => [n.id, openEditors.get(n.id)?.(at) ?? n.data] as const)
  const before = newest.map(([id, data]) => [id, { ...data, trashedAt: null }] as const)
  for (const [id, data] of newest) await db.put('note', { ...data, trashedAt: at, pinned: false }, id)
  return () => before.forEach(([id, data]) => void db.put('note', { ...data, trashedAt: null }, id))
}

export async function restoreNotes(list: Rec<'note'>[]): Promise<void> {
  for (const n of list) await db.put('note', { ...n.data, trashedAt: null }, n.id)
}

/** Deletes for good (this syncs as a delete to your other devices). */
export async function deleteForever(list: Rec<'note'>[]): Promise<void> {
  for (const n of list) await db.remove('note', n.id)
  await dropHistory(list.map((n) => n.id)).catch(() => {})
}

/** Removes notes that have been in the trash longer than 30 days. */
export async function emptyOldTrash(): Promise<void> {
  const cutoff = Date.now() - TRASH_DAYS * DAY
  const old = (await db.list('note')).filter((n) => n.data.trashedAt && n.data.trashedAt < cutoff)
  if (old.length) await deleteForever(old)
  await tidyHistory().catch(() => {})
}

/* ---------- search through whole notes ---------- */

function plain(doc: unknown): string {
  const out: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text)
    if (Array.isArray(n.content)) {
      n.content.forEach(walk)
      out.push(' ')
    }
  }
  walk(doc)
  return out.join('').replace(/\s+/g, ' ').trim()
}

// Worked out once per version of each note.
const cache = new Map<string, { at: number; text: string; low: string }>()

/** A note's whole text: the page, plus a Cornell note's cues and summary. */
export function noteBody(n: Rec<'note'>): { text: string; low: string } {
  const hit = cache.get(n.id)
  if (hit && hit.at === n.updatedAt) return hit
  const text = [plain(n.data.content), plain(n.data.cues), plain(n.data.summary)].filter(Boolean).join(' · ') || n.data.excerpt || ''
  const entry = { at: n.updatedAt, text, low: text.toLowerCase() }
  cache.set(n.id, entry)
  return entry
}

export const searchTerms = (q: string): string[] => q.toLowerCase().replace(/^#/, '').split(/\s+/).filter(Boolean)

/**
 * Does the note have every word you typed (in its title, text or tags)?
 * Returns a score (title hits count most), or 0 for no match.
 */
export function scoreNote(n: Rec<'note'>, terms: string[]): number {
  if (!terms.length) return 1
  const title = (n.data.title || '').toLowerCase()
  const tags = (n.data.tags ?? []).join(' ')
  const { low } = noteBody(n)
  let score = 0
  for (const t of terms) {
    if (title.includes(t)) score += title.startsWith(t) ? 6 : 4
    else if (tags.includes(t)) score += 3
    else if (low.includes(t)) score += 1
    else return 0
  }
  return score
}

/** A short piece of the note around the first word you searched for. */
export function snippet(n: Rec<'note'>, terms: string[], size = 110): string | null {
  const { text, low } = noteBody(n)
  const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (at === undefined) return null
  const start = Math.max(0, at - 36)
  const from = start === 0 ? 0 : text.indexOf(' ', start) + 1 || start
  return (from > 0 ? '…' : '') + text.slice(from, from + size).trim() + (from + size < text.length ? '…' : '')
}
