import type { Folder, Rec } from '@shared/types'
import { db, useRecords } from '../data/store'

/** Folders of one kind (notes or subjects), in their order. */
export function useFolders(scope: Folder['scope']): Rec<'folder'>[] {
  const { items } = useRecords('folder')
  return items
    .filter((f) => f.data.scope === scope)
    .sort((a, b) => (a.data.order ?? Infinity) - (b.data.order ?? Infinity) || a.data.name.localeCompare(b.data.name))
}

export async function newFolder(scope: Folder['scope'], name: string): Promise<Rec<'folder'>> {
  return db.put('folder', { name: name.trim(), scope })
}

export async function renameFolder(f: Rec<'folder'>, name: string): Promise<void> {
  if (name.trim()) await db.put('folder', { ...f.data, name: name.trim() }, f.id)
}

/**
 * Deletes a folder. What was in it stays, just out of the folder.
 * Returns an undo that puts the folder and its contents back.
 */
export async function deleteFolder(f: Rec<'folder'>): Promise<() => Promise<void>> {
  const kind = f.data.scope === 'note' ? 'note' : 'subject'
  const inside = (await db.list(kind)).filter((r) => (r.data as { folderId?: string | null }).folderId === f.id)
  for (const r of inside) await db.put(kind, { ...r.data, folderId: null } as never, r.id)
  await db.remove('folder', f.id)
  return async () => {
    await db.put('folder', f.data, f.id)
    for (const r of inside) await db.put(kind, r.data as never, r.id)
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
