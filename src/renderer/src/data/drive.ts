import { useCallback, useEffect, useState } from 'react'
import { generateHTML } from '@tiptap/core'
import type { DriveState, Note } from '@shared/types'
import { onRecordsChanged } from './store'
import { noteExtensions } from '../components/notes/extensions'
import { noteToMarkdown } from '../components/notes/markdown'

const api = window.veyra.drive
export const cleanError = (e: unknown, fallback = 'Something went wrong. Try again.') =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

/* ---------- state, shared by Settings and the note menu ---------- */
let current: DriveState | null = null
const subs = new Set<(s: DriveState) => void>()
const publish = (s: DriveState) => {
  current = s
  subs.forEach((f) => f(s))
}
export const refreshDrive = () => api.state().then(publish)

export function useDrive() {
  const [state, setState] = useState<DriveState | null>(current)
  useEffect(() => {
    subs.add(setState)
    void refreshDrive()
    return () => void subs.delete(setState)
  }, [])
  const run = useCallback(async (fn: () => Promise<DriveState>) => publish(await fn()), [])
  return { state, run }
}

/* ---------- Save to Google Docs ---------- */
let extensions: ReturnType<typeof noteExtensions> | null = null
const html = (doc: unknown) => {
  if (!doc || typeof doc !== 'object') return ''
  extensions ??= noteExtensions('')
  try {
    return generateHTML(doc as any, extensions)
  } catch {
    return ''
  }
}

/** The note as a web page, which Google turns into a Doc (Cornell notes keep their cues and summary). */
export function noteHtml(n: Note): string {
  const parts = [html(n.content)]
  if (n.template === 'cornell') {
    const cues = html(n.cues)
    const summary = html(n.summary)
    if (cues) parts.unshift(`<h2>Cues</h2>${cues}<h2>Notes</h2>`)
    if (summary) parts.push(`<h2>Summary</h2>${summary}`)
  }
  return parts.join('')
}

export async function saveNoteToDocs(id: string, n: Note): Promise<string> {
  const r = await api.saveDoc(id, n.title || 'Untitled', noteHtml(n))
  return r.url
}

/* ---------- automatic backup ---------- */
let backupError = ''
let backingUp = false
const errSubs = new Set<() => void>()
export const backupStatus = () => ({ error: backupError, running: backingUp })
export function onBackupStatus(f: () => void) {
  errSubs.add(f)
  return () => void errSubs.delete(f)
}
const setBackup = (running: boolean, error?: string) => {
  backingUp = running
  if (error !== undefined) backupError = error
  errSubs.forEach((f) => f())
}

/** Uploads notes changed since the last backup (and bins deleted ones). */
export async function backupNow(): Promise<{ uploaded: number; removed: number } | null> {
  if (backingUp) return null
  const st = await api.state()
  publish(st)
  if (!st.connected || !st.backup) return null
  setBackup(true)
  try {
    const changes = (await window.veyra.db.changesSince(st.backupThrough)).filter((r) => r.kind === 'note')
    if (!changes.length) {
      setBackup(false, '')
      return { uploaded: 0, removed: 0 }
    }
    const files = changes.map((r) => {
      const n = r.data as Note
      return { id: r.id, name: n.title || 'Untitled', markdown: r.deletedAt ? '' : noteToMarkdown(n), updatedAt: r.updatedAt, deleted: !!r.deletedAt }
    })
    const through = Math.max(...changes.map((r) => r.updatedAt))
    const r = await api.backup(files, through)
    publish(r)
    setBackup(false, '')
    return { uploaded: r.uploaded, removed: r.removed }
  } catch (e) {
    setBackup(false, cleanError(e, 'The Drive backup didn’t finish.'))
    return null
  }
}

/** Keeps the Drive backup up to date: shortly after notes change, and every half hour. */
export function startDriveBackup(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = (ms: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void backupNow(), ms)
  }
  const off = onRecordsChanged((kind) => kind === 'note' && soon(30_000))
  soon(8_000)
  const every = setInterval(() => void backupNow(), 30 * 60_000)
  return () => {
    off()
    clearInterval(every)
    if (timer) clearTimeout(timer)
  }
}
