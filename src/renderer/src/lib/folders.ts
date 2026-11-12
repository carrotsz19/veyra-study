import type { Folder, Rec } from '@shared/types'
import { db, useRecords } from '../data/store'

/** Folders of one kind (notes or subjects), in their order. */
export function useFolders(scope: Folder['scope']): Rec<'folder'>[] {
  const { items } = useRecords('folder')
  return items
    .filter((f) => f.data.scope === scope)
    .sort((a, b) => (a.data.order ?? Infinity) - (b.data.order ?? Infinity) || a.data.name.localeCompare(b.data.name))
}

/* ---------- the tree: folders can hold folders ---------- */

/** The folder a folder sits in, or null at the top (also when its parent is gone, or the chain loops). */
export function parentOf(all: Rec<'folder'>[], f: Rec<'folder'>): string | null {
  const p = f.data.parentId
  if (!p || !all.some((x) => x.id === p)) return null
  // A loop (two devices moving folders into each other at once): treat this one as top level.
  const seen = new Set([f.id])
  for (let at: string | null | undefined = p; at; at = all.find((x) => x.id === at)?.data.parentId) {
    if (seen.has(at)) return null
    seen.add(at)
  }
  return p
}
export const childrenOf = (all: Rec<'folder'>[], id: string | null) => all.filter((f) => parentOf(all, f) === id)

/** A folder and everything inside it, however deep. */
export function withDescendants(all: Rec<'folder'>[], id: string): Set<string> {
  const out = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const f of all) if (!out.has(f.id) && out.has(parentOf(all, f) ?? '')) (out.add(f.id), (grew = true))
  }
  return out
}

/** From the top down to this folder. */
export function folderPath(all: Rec<'folder'>[], id: string | null): Rec<'folder'>[] {
  const path: Rec<'folder'>[] = []
  for (let f = all.find((x) => x.id === id); f && path.length < 50; f = all.find((x) => x.id === parentOf(all, f!))) path.unshift(f)
  return path
}

/** Every folder in tree order with its depth (for pickers and lists). */
export function folderTree(all: Rec<'folder'>[]): { folder: Rec<'folder'>; depth: number }[] {
  const out: { folder: Rec<'folder'>; depth: number }[] = []
  const walk = (id: string | null, depth: number) => {
    for (const f of childrenOf(all, id)) {
      out.push({ folder: f, depth })
      if (depth < 30) walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/* ---------- changes ---------- */

export async function newFolder(scope: Folder['scope'], name: string, parentId: string | null = null): Promise<Rec<'folder'>> {
  return db.put('folder', { name: name.trim(), scope, parentId })
}

export async function renameFolder(f: Rec<'folder'>, name: string): Promise<void> {
  if (name.trim()) await db.put('folder', { ...f.data, name: name.trim() }, f.id)
}

/** Puts a folder inside another (null: the top level). Refuses to put it inside itself. */
export async function moveFolder(all: Rec<'folder'>[], f: Rec<'folder'>, parentId: string | null): Promise<boolean> {
  if (parentId && withDescendants(all, f.id).has(parentId)) return false
  if (parentOf(all, f) === parentId) return false
  await db.put('folder', { ...f.data, parentId }, f.id)
  return true
}

/**
 * Deletes a folder. What was in it (notes or subjects, and folders) moves up
 * a level. Returns an undo that puts everything back.
 */
export async function deleteFolder(f: Rec<'folder'>): Promise<() => Promise<void>> {
  const kind = f.data.scope === 'note' ? 'note' : 'subject'
  const folders = await db.list('folder')
  const up = folders.some((x) => x.id === f.data.parentId) ? (f.data.parentId ?? null) : null
  const inside = (await db.list(kind)).filter((r) => (r.data as { folderId?: string | null }).folderId === f.id)
  const subfolders = folders.filter((x) => x.data.parentId === f.id)
  for (const r of inside) await db.put(kind, { ...r.data, folderId: up } as never, r.id)
  for (const x of subfolders) await db.put('folder', { ...x.data, parentId: up }, x.id)
  await db.remove('folder', f.id)
  return async () => {
    await db.put('folder', f.data, f.id)
    for (const r of inside) await db.put(kind, r.data as never, r.id)
    for (const x of subfolders) await db.put('folder', x.data, x.id)
  }
}

/** Collapsed sidebar folders: per device, so each screen keeps its own tidy view. */
const COLLAPSED = 'veyra.folders.collapsed'
export function collapsedFolders(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]'))
  } catch {
    return new Set()
  }
}
export function saveCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED, JSON.stringify([...s]))
  } catch {
    /* storage unavailable */
  }
}

/* ---------- dragging between screens (a note from the list onto a sidebar subject, …) ---------- */
export type Dragged = { kind: 'notes'; ids: string[] } | { kind: 'subject'; id: string } | { kind: 'folder'; id: string; scope: Folder['scope'] }
let dragged: Dragged | null = null
export const drag = {
  start: (d: Dragged) => void (dragged = d),
  end: () => void (dragged = null),
  get: () => dragged
}
