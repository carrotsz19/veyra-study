import { useState } from 'react'
import { Archive, ChevronRight, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, ListPlus, NotebookPen, Pencil, Plus, Timer, Trash2 } from 'lucide-react'
import type { Rec } from '@shared/types'
import { sortSubjects } from '../lib/subjects'
import { childrenOf, collapsedFolders, deleteFolder, drag, moveFolder, newFolder, parentOf, renameFolder, saveCollapsed, useFolders, withDescendants } from '../lib/folders'
import { db, useRecords } from '../data/store'
import { useSettings } from '../data/settings'
import { ContextMenu, Dialog, useToast, type MenuItem } from './ui'
import { SubjectDialog, TaskDialog } from './editors'
import { FolderNameDialog, FolderPickDialog } from './FolderDialogs'
import { useTimer } from './timer'
import { newNote } from '../views/Notes'
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
 *
 * Right-click a subject, a folder or the Subjects heading for its tools.
 */
export function SubjectNav({ subjects, route, go, tip, heading }: { subjects: Rec<'subject'>[]; route: Route; go: (r: Route) => void; tip: (label: string) => string | undefined; heading: React.ReactNode }) {
  const folders = useFolders('subject')
  const { items: notes } = useRecords('note')
  const { items: tasks } = useRecords('task')
  const { s: settings } = useSettings()
  const timer = useTimer()
  const toast = useToast()
  // Right-click menus and the dialogs they open.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<
    | { kind: 'edit'; subject: Rec<'subject'> }
    | { kind: 'new-subject'; folderId: string | null }
    | { kind: 'task'; subjectId: string }
    | { kind: 'move-subject'; subject: Rec<'subject'> }
    | { kind: 'delete'; subject: Rec<'subject'> }
    | { kind: 'new-folder'; parent: string | null }
    | { kind: 'rename-folder'; folder: Rec<'folder'> }
    | { kind: 'move-folder'; folder: Rec<'folder'> }
    | null
  >(null)
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

  /* ---------- right-click menus ---------- */
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const removeSubject = async (x: Rec<'subject'>) => {
    // As in Settings → Subjects: the subject goes; its tasks and notes stay, without a subject.
    const ownTasks = tasks.filter((t) => t.data.subjectId === x.id)
    const ownNotes = notes.filter((n) => n.data.subjectId === x.id)
    for (const t of ownTasks) await db.put('task', { ...t.data, subjectId: null }, t.id)
    for (const n of ownNotes) await db.put('note', { ...n.data, subjectId: null }, n.id)
    await db.remove('subject', x.id)
    if (isCurrent(x.id)) go({ name: 'today' })
    toast(`Deleted ${x.data.name}`, {
      label: 'Undo',
      run: async () => {
        await db.put('subject', x.data, x.id)
        for (const t of ownTasks) await db.put('task', t.data, t.id)
        for (const n of ownNotes) await db.put('note', n.data, n.id)
      }
    })
  }
  const archiveSubject = async (x: Rec<'subject'>) => {
    await db.put('subject', { ...x.data, archived: true }, x.id)
    if (isCurrent(x.id)) go({ name: 'today' })
    toast(`Archived ${x.data.name}`, { label: 'Undo', run: () => void db.put('subject', { ...x.data, archived: false }, x.id) })
  }
  const removeFolder = async (f: Rec<'folder'>) => {
    const undo = await deleteFolder(f)
    toast(`Deleted the folder ${f.data.name}. What was in it moved up a level.`, { label: 'Undo', run: () => void undo() })
  }
  const openFolder = (id: string) => {
    if (closed.has(id)) toggle(id)
  }
  const subjectMenu = (s: Rec<'subject'>): MenuItem[] => [
    ['Open', <FolderOpen size={15} key="o" />, () => go({ name: 'subject', id: s.id })],
    ['Study now', <Timer size={15} key="t" />, () => (timer.study(s.id), go({ name: 'timer' }))],
    ['New task', <ListPlus size={15} key="k" />, () => setDialog({ kind: 'task', subjectId: s.id })],
    ['New note', <NotebookPen size={15} key="n" />, () => void newNote(s.id, settings).then((id) => go({ name: 'notes', noteId: id }))],
    'sep',
    ['Edit subject', <Pencil size={15} key="e" />, () => setDialog({ kind: 'edit', subject: s })],
    ['Move to folder…', <FolderInput size={15} key="m" />, () => setDialog({ kind: 'move-subject', subject: s })],
    ['Archive', <Archive size={15} key="a" />, () => void archiveSubject(s)],
    'sep',
    ['Delete subject', <Trash2 size={15} key="x" />, () => setDialog({ kind: 'delete', subject: s }), true]
  ]
  const folderMenu = (f: Rec<'folder'>): MenuItem[] => [
    [closed.has(f.id) ? 'Open' : 'Fold', <FolderOpen size={15} key="o" />, () => toggle(f.id)],
    ['New subject here', <Plus size={15} key="s" />, () => setDialog({ kind: 'new-subject', folderId: f.id })],
    ['New folder inside', <FolderPlus size={15} key="n" />, () => setDialog({ kind: 'new-folder', parent: f.id })],
    'sep',
    ['Rename', <Pencil size={15} key="r" />, () => setDialog({ kind: 'rename-folder', folder: f })],
    ['Move to…', <FolderInput size={15} key="m" />, () => setDialog({ kind: 'move-folder', folder: f })],
    'sep',
    ['Delete folder', <Trash2 size={15} key="x" />, () => void removeFolder(f), true]
  ]
  const headingMenu: MenuItem[] = [
    ['New subject', <Plus size={15} key="s" />, () => setDialog({ kind: 'new-subject', folderId: null })],
    ['New folder', <FolderPlus size={15} key="n" />, () => setDialog({ kind: 'new-folder', parent: null })]
  ]

  /* ---------- drawing ---------- */
  const subjectBtn = (s: Rec<'subject'>, depth: number) => (
    <button
      key={s.id}
      className={`navbtn ${depth ? 'nested' : ''} ${over === `before:${s.id}` ? 'drop-before' : ''} ${over === `notes:${s.id}` ? 'drop-into' : ''}`}
      style={depth ? ({ '--depth': depth } as React.CSSProperties) : undefined}
      aria-current={isCurrent(s.id)}
      onClick={() => go({ name: 'subject', id: s.id })}
      onContextMenu={(e) => openMenu(e, subjectMenu(s))}
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
          onContextMenu={(e) => openMenu(e, folderMenu(f))}
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
      <div className={`side-drop-top ${over === 'top' ? 'drop-into' : ''}`} {...target(() => (folderAccepts(null)() ? 'top' : null), landInFolder(null))} onContextMenu={(e) => openMenu(e, headingMenu)}>
        {heading}
      </div>
      <nav aria-label="Subjects">
        {childrenOf(folders, null).map((f) => folderBlock(f, 0))}
        {active.filter((s) => !inFolder(s)).map((s) => subjectBtn(s, 0))}
      </nav>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'edit' && <SubjectDialog subject={dialog.subject} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-subject' && (
        <SubjectDialog
          folderId={dialog.folderId}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            if (dialog.folderId) openFolder(dialog.folderId)
            go({ name: 'subject', id })
          }}
        />
      )}
      {dialog?.kind === 'task' && <TaskDialog defaults={{ subjectId: dialog.subjectId }} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'move-subject' && (
        <FolderPickDialog
          scope="subject"
          folders={folders}
          title={`Move ${dialog.subject.data.name} to…`}
          noneLabel="No folder"
          current={inFolder(dialog.subject)}
          onPick={(id) => void subjectInto(dialog.subject.id, id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Dialog title={`Delete ${dialog.subject.data.name}?`} onClose={() => setDialog(null)}>
          <p className="sm dim" style={{ marginTop: 0 }}>
            Its tasks and notes stay, without a subject. You can undo this straight after.
          </p>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              className="btn dan"
              onClick={() => {
                const x = dialog.subject
                setDialog(null)
                void removeSubject(x)
              }}
            >
              <Trash2 size={15} /> Delete
            </button>
          </div>
        </Dialog>
      )}
      {(dialog?.kind === 'new-folder' || dialog?.kind === 'rename-folder') && (
        <FolderNameDialog
          title={dialog.kind === 'new-folder' ? 'New folder' : 'Rename folder'}
          action={dialog.kind === 'new-folder' ? 'Create' : 'Rename'}
          initial={dialog.kind === 'rename-folder' ? dialog.folder.data.name : ''}
          onClose={() => setDialog(null)}
          onSave={(name) => {
            if (dialog.kind === 'rename-folder') void renameFolder(dialog.folder, name)
            else {
              if (dialog.parent) openFolder(dialog.parent)
              void newFolder('subject', name, dialog.parent)
            }
          }}
        />
      )}
      {dialog?.kind === 'move-folder' && (
        <FolderPickDialog
          scope="subject"
          folders={folders}
          title={`Move ${dialog.folder.data.name} to…`}
          noneLabel="Top level"
          current={parentOf(folders, dialog.folder)}
          exclude={withDescendants(folders, dialog.folder.id)}
          onPick={(id) => void folderInto(dialog.folder.id, id)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}
