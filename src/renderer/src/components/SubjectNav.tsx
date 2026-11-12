import { useState } from 'react'
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react'
import type { Rec } from '@shared/types'
import { sortSubjects } from '../lib/subjects'
import { childrenOf, collapsedFolders, drag, moveFolder, parentOf, saveCollapsed, useFolders, withDescendants } from '../lib/folders'
import { db, useRecords } from '../data/store'
import { useToast } from './ui'
import type { Route } from '../nav'

/**
 * The sidebar's subjects: folders (which can hold folders) first, each
 * folding away when clicked (remembered on this device), then the subjects
 * that aren't in a folder.
 *
 * Drag and drop: a subject onto a folder puts it in; onto another subject
 * puts it just before that one (in the same folder); onto the Subjects
 * heading takes it out of every folder. A folder onto a folder nests it.
 * Notes dragged from the Notes list onto a subject get that subject.
 */
export function SubjectNav({ subjects, route, go, tip, heading }: { subjects: Rec<'subject'>[]; route: Route; go: (r: Route) => void; tip: (label: string) => string | undefined; heading: React.ReactNode }) {
  const folders = useFolders('subject')
  const { items: notes } = useRecords('note')
  const toast = useToast()
  const [closed, setClosed] = useState(collapsedFolders)
  // Where a drag would land: into a folder, before a subject, onto a subject (notes), or the top level.
  const [over, setOver] = useState<string | null>(null)
  const active = sortSubjects(subjects).filter((s) => !s.data.archived)
  const inFolder = (s: Rec<'subject'>) => (s.data.folderId && folders.some((f) => f.id === s.data.folderId) ? s.data.folderId : null)
  const isCurrent = (id: string) => route.name === 'subject' && 'id' in route && route.id === id
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setClosed(next)
    saveCollapsed(next)
  }

  /* ---------- dropping ---------- */
  const subjectInto = async (id: string, folderId: string | null) => {
    const s = active.find((x) => x.id === id)
    if (!s || inFolder(s) === folderId) return
    const before = s.data
    await db.put('subject', { ...s.data, folderId }, s.id)
    const name = folders.find((f) => f.id === folderId)?.data.name
    toast(name ? `Moved ${s.data.name} into ${name}` : `Took ${s.data.name} out of its folder`, { label: 'Undo', run: () => void db.put('subject', before, s.id) })
  }
  const subjectBefore = async (id: string, target: Rec<'subject'>) => {
    const s = active.find((x) => x.id === id)
    if (!s || s.id === target.id) return
    const list = active.filter((x) => x.id !== s.id)
    list.splice(list.indexOf(target), 0, s)
    const folderId = inFolder(target)
    for (const [n, x] of list.entries()) {
      const data = x.id === s.id ? { ...x.data, order: n, folderId } : { ...x.data, order: n }
      if (x.data.order !== n || x.id === s.id) await db.put('subject', data, x.id)
    }
  }
  const folderInto = async (id: string, into: string | null) => {
    const f = folders.find((x) => x.id === id)
    if (!f) return
    const before = f.data
    if (!(await moveFolder(folders, f, into))) return
    const name = folders.find((x) => x.id === into)?.data.name
    toast(name ? `Moved ${f.data.name} into ${name}` : `Moved ${f.data.name} to the top level`, { label: 'Undo', run: () => void db.put('folder', before, f.id) })
  }
  const notesTo = async (ids: string[], s: Rec<'subject'>) => {
    const list = notes.filter((n) => ids.includes(n.id) && n.data.subjectId !== s.id)
    if (!list.length) return
    const before = list.map((n) => [n.id, n.data] as const)
    for (const n of list) await db.put('note', { ...n.data, subjectId: s.id }, n.id)
    toast(list.length === 1 ? `Moved “${list[0].data.title || 'Untitled'}” to ${s.data.name}` : `Moved ${list.length} notes to ${s.data.name}`, {
      label: 'Undo',
      run: () => before.forEach(([id, data]) => void db.put('note', data, id))
    })
  }

  /** Drag-and-drop props for a spot. `spot` names where the drag would land here (null: it can't). */
  const target = (spot: () => string | null, land: () => void) => ({
    onDragOver: (e: React.DragEvent) => {
      const key = drag.get() ? spot() : null
      if (!key) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (over !== key) setOver(key)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setOver(null)
      land()
      drag.end()
    }
  })
  const source = (start: () => void, label: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      start()
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', label)
    },
    onDragEnd: () => {
      drag.end()
      setOver(null)
    }
  })
  const folderAccepts = (folderId: string | null) => () => {
    const d = drag.get()
    if (d?.kind === 'subject') return true
    if (d?.kind === 'folder' && d.scope === 'subject') {
      const f = folders.find((x) => x.id === d.id)
      return !!f && !(folderId && withDescendants(folders, f.id).has(folderId)) && parentOf(folders, f) !== folderId
    }
    return false
  }
  const landInFolder = (folderId: string | null) => () => {
    const d = drag.get()
    if (d?.kind === 'subject') void subjectInto(d.id, folderId)
    else if (d?.kind === 'folder') void folderInto(d.id, folderId)
  }

  /* ---------- drawing ---------- */
  const subjectBtn = (s: Rec<'subject'>, depth: number) => (
    <button
      key={s.id}
      className={`navbtn ${depth ? 'nested' : ''} ${over === `before:${s.id}` ? 'drop-before' : ''} ${over === `notes:${s.id}` ? 'drop-into' : ''}`}
      style={depth ? ({ '--depth': depth } as React.CSSProperties) : undefined}
      aria-current={isCurrent(s.id)}
      onClick={() => go({ name: 'subject', id: s.id })}
      title={tip(s.data.name)}
      aria-label={s.data.name}
      {...source(() => drag.start({ kind: 'subject', id: s.id }), s.data.name)}
      {...target(
        // Notes land on the subject; a subject lands just before it.
        () => {
          const d = drag.get()
          return d?.kind === 'notes' ? `notes:${s.id}` : d?.kind === 'subject' && d.id !== s.id ? `before:${s.id}` : null
        },
        () => {
          const d = drag.get()
          if (d?.kind === 'notes') void notesTo(d.ids, s)
          else if (d?.kind === 'subject') void subjectBefore(d.id, s)
        }
      )}
    >
      <span className="dot" style={{ background: s.data.color }} />
      <span className="trunc nav-label">{s.data.name}</span>
    </button>
  )

  const folderBlock = (f: Rec<'folder'>, depth: number): React.ReactNode => {
    const subs = childrenOf(folders, f.id)
    const list = active.filter((s) => inFolder(s) === f.id)
    const inside = withDescendants(folders, f.id)
    const total = active.filter((s) => inside.has(inFolder(s) ?? '')).length
    const open = !closed.has(f.id)
    // A closed folder still shows that the subject you're on is inside it.
    const current = !open && active.some((s) => inside.has(inFolder(s) ?? '') && isCurrent(s.id))
    return (
      <div key={f.id} className={`side-folder ${open ? 'open' : ''}`}>
        <button
          className={`navbtn side-folder-head ${depth ? 'nested' : ''} ${current ? 'has-current' : ''} ${over === `into:${f.id}` ? 'drop-into' : ''}`}
          style={depth ? ({ '--depth': depth } as React.CSSProperties) : undefined}
          aria-expanded={open}
          onClick={() => toggle(f.id)}
          title={tip(`${f.data.name} (${total})`)}
          aria-label={`${f.data.name} folder`}
          {...source(() => drag.start({ kind: 'folder', id: f.id, scope: 'subject' }), f.data.name)}
          {...target(() => (folderAccepts(f.id)() ? `into:${f.id}` : null), landInFolder(f.id))}
        >
          <ChevronRight size={13} className="side-folder-chev" />
          {open || over === `into:${f.id}` ? <FolderOpen size={16} /> : <FolderIcon size={16} />}
          <span className="trunc nav-label">{f.data.name}</span>
          {!open && total > 0 && <span className="count">{total}</span>}
        </button>
        <div className="side-folder-body">
          <div>
            {depth < 12 && subs.map((x) => folderBlock(x, depth + 1))}
            {list.map((s) => subjectBtn(s, depth + 1))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={`side-drop-top ${over === 'top' ? 'drop-into' : ''}`} {...target(() => (folderAccepts(null)() ? 'top' : null), landInFolder(null))}>
        {heading}
      </div>
      <nav aria-label="Subjects">
        {childrenOf(folders, null).map((f) => folderBlock(f, 0))}
        {active.filter((s) => !inFolder(s)).map((s) => subjectBtn(s, 0))}
      </nav>
    </>
  )
}
