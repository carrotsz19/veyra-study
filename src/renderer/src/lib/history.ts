import type { Note, NoteVersion, Rec } from '@shared/types'
import { db, onExternalChange } from '../data/store'
import { docText, wordCount } from '../components/notes/extensions'
import { toKeep } from './history-keep'

/**
 * Note history. A version is the note as it was just before a stretch of editing:
 * when you change a note and it has no version from the last 10 minutes, what it
 * looked like until then is kept. The note itself is always the newest version.
 *
 * Versions are records ('noteVersion'), so they're kept on this device and, with
 * sync on (and "Sync note history" on), on your other devices too. Older ones are
 * thinned out (thin): everything from the last day, then one an hour for a week,
 * one a day for a month and one a week after that, at most 50 per note.
 */

const MIN = 60_000
/** A new version at most this often while editing. */
export const VERSION_EVERY = 10 * MIN

/* ---------- all versions, read once and kept up to date here ---------- */
let all: Promise<Rec<'noteVersion'>[]> | null = null
const load = () => (all ??= db.list('noteVersion').catch(() => []))
// Another device sent versions (or deleted some): read them again when next needed.
onExternalChange(() => void (all = null))
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())
export const onVersionsChanged = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** A note's versions, newest first. */
export async function versionsOf(noteId: string): Promise<Rec<'noteVersion'>[]> {
  return (await load()).filter((v) => v.data.noteId === noteId).sort((a, b) => b.data.at - a.data.at)
}

const words = (n: Pick<Note, 'content' | 'cues' | 'summary'>) => wordCount([docText(n.content), docText(n.cues), docText(n.summary)].join(' '))
const sameText = (a: Pick<Note, 'title' | 'content' | 'cues' | 'summary'>, b: Pick<NoteVersion, 'title' | 'content' | 'cues' | 'summary'>) =>
  a.title === b.title && JSON.stringify(a.content ?? null) === JSON.stringify(b.content ?? null) && JSON.stringify(a.cues ?? null) === JSON.stringify(b.cues ?? null) && JSON.stringify(a.summary ?? null) === JSON.stringify(b.summary ?? null)

/** Keeps a version of the note as it was (at = when it was like that). Skipped if the newest version already says the same. */
export async function keepVersion(noteId: string, was: Note, at: number): Promise<boolean> {
  const list = await versionsOf(noteId)
  if (list[0] && sameText(was, list[0].data)) return false
  const rec = await db.put('noteVersion', {
    noteId,
    at,
    title: was.title,
    content: was.content ?? null,
    ...(was.cues ? { cues: was.cues } : {}),
    ...(was.summary ? { summary: was.summary } : {}),
    ...(was.template ? { template: was.template } : {}),
    words: words(was)
  })
  ;(await load()).push(rec)
  await thin(noteId)
  changed()
  return true
}

/**
 * Called on every save of a note. `before` is the note as last saved (and `beforeAt` when);
 * if it has no version from the last 10 minutes, `before` is kept as one.
 */
const busy = new Map<string, Promise<void>>()
export function beforeSave(noteId: string, before: Note, beforeAt: number, after: Note): Promise<void> {
  if (sameText(after, before)) return Promise.resolve()
  // One at a time per note, so quick saves can't both make a version.
  const run = (busy.get(noteId) ?? Promise.resolve()).then(async () => {
    const newest = (await versionsOf(noteId))[0]
    if (newest && Date.now() - newest.createdAt < VERSION_EVERY) return
    await keepVersion(noteId, before, beforeAt)
  })
  const settled = run.catch(() => {})
  busy.set(noteId, settled)
  void settled.then(() => busy.get(noteId) === settled && busy.delete(noteId))
  return run
}

async function thin(noteId: string): Promise<void> {
  const list = await versionsOf(noteId)
  const keep = toKeep(list.map((v) => ({ id: v.id, at: v.data.at })))
  const drop = list.filter((v) => !keep.has(v.id))
  for (const v of drop) await db.remove('noteVersion', v.id)
  if (drop.length) all = load().then((l) => l.filter((v) => !drop.some((d) => d.id === v.id)))
}

/** Deletes a note's whole history (the note is gone for good). */
export async function dropHistory(noteIds: string[]): Promise<void> {
  const ids = new Set(noteIds)
  const gone = (await load()).filter((v) => ids.has(v.data.noteId))
  for (const v of gone) await db.remove('noteVersion', v.id)
  all = load().then((l) => l.filter((v) => !ids.has(v.data.noteId)))
  if (gone.length) changed()
}

/** Tidies up now and then: history of notes that no longer exist (deleted on another device), and thinning. */
export async function tidyHistory(): Promise<void> {
  const notes = new Set((await db.list('note')).map((n) => n.id))
  const versions = await load()
  const orphans = [...new Set(versions.filter((v) => !notes.has(v.data.noteId)).map((v) => v.data.noteId))]
  if (orphans.length) await dropHistory(orphans)
  for (const id of new Set(versions.map((v) => v.data.noteId))) if (notes.has(id)) await thin(id)
}
