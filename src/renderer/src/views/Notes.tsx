import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, CheckSquare, ChevronLeft, ChevronRight, Copy, Download, FileText, Folder as FolderIcon, FolderInput, FolderOpen, FolderPlus, HardDrive, MoreHorizontal, NotebookPen, Pencil, Pin, PinOff, Plus, RotateCcw, Search, Square, SquarePen, Trash2, Users, X, SlidersHorizontal } from 'lucide-react'
import { childrenOf, deleteFolder, drag, folderPath, moveFolder, newFolder, parentOf, renameFolder, useFolders, withDescendants } from '../lib/folders'
import { FolderNameDialog, FolderPickDialog } from '../components/FolderDialogs'
import type { NoteFont, NoteTemplate, Rec } from '@shared/types'
import { db, onExternalChange, useRecords } from '../data/store'
import { ContextMenu as RowMenu, Dialog, Empty, useToast } from '../components/ui'
import { SharedList, SharedPane, recentLinks, takePendingShare, type SharedPick } from '../components/notes/Share'
import { myShares, onSharesChanged, type ShareInfo } from '../lib/share'
import { groupCall } from '../data/groups'
import { useAccount } from '../components/account'
import { formatDistanceToNowStrict } from 'date-fns'
import { NOTE_COVERS, NoteEditor, duplicateNote, exportNotes } from '../components/notes/NoteEditor'
import { useSettings } from '../data/settings'
import { preview, section, shortDate } from '../components/notes/listing'
import { useNav } from '../nav'
import { onAndroid, usePhone } from '../lib/phone'
import { transition } from '../lib/motion'
import { cleanError, importFromDrive, useDrive } from '../data/drive'
import { TRASH_DAYS, daysLeft, deleteForever, emptyOldTrash, restoreNotes, scoreNote, searchTerms, snippet, trashNotes } from '../lib/notes'

/** A new note, starting from the defaults in Settings → Notes. */
export async function newNote(subjectId: string | null, d?: { noteTemplate: NoteTemplate; noteFont: NoteFont; noteCover: string }, folderId?: string | null): Promise<string> {
  const covers = Object.keys(NOTE_COVERS)
  const cover = !d || d.noteCover === 'none' ? null : d.noteCover === 'random' ? covers[Math.floor(Math.random() * covers.length)] : d.noteCover
  const rec = await db.put('note', { title: '', subjectId, folderId: folderId ?? null, content: null, excerpt: '', template: d?.noteTemplate, font: d?.noteFont, cover })
  return rec.id
}

type View = 'notes' | 'shared' | 'archived' | 'trash'

/** Text with the words you searched for marked. */
export function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </>
  )
}

export function Notes({ noteId, subjectFilter }: { noteId?: string; subjectFilter?: string }) {
  const signedIn = useAccount()?.state.mode === 'account'
  const me = useAccount()?.state.user
  // The Shared tab: notes people shared with you (open in the pane), and yours that you've shared.
  const [sharedPick, setSharedPick] = useState<SharedPick | null>(null)
  const [sharedKey, setSharedKey] = useState(0)
  const [mineShared, setMineShared] = useState<ShareInfo[]>([])
  useEffect(() => {
    if (!signedIn) return
    const read = () => void myShares().then(setMineShared, () => {})
    read()
    return onSharesChanged(read)
  }, [signedIn])
  // A link opened on the website ("Open in Veyra Study" / "Sign in to edit"): kept in Shared, and opened.
  useEffect(() => {
    if (!signedIn) return
    const id = takePendingShare()
    if (!id) return
    void groupCall('POST', `/shares/${encodeURIComponent(id)}/save`)
      .catch(() => {})
      .finally(() => {
        setView('shared')
        setSharedPick({ id, link: true })
        setSharedKey((k) => k + 1)
      })
  }, [signedIn])
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen) return
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (filterRef.current?.contains(t) || t.closest?.('.np-filter-btn')) return
      setFilterOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFilterOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [filterOpen])
  const sharedIds = useMemo(() => new Set(mineShared.map((x) => x.noteId)), [mineShared])
  const { items: everyNote, loaded } = useRecords('note')
  // Notes in the trash only show under Trash.
  const notes = useMemo(() => everyNote.filter((n) => !n.data.trashedAt), [everyNote])
  const trash = useMemo(() => everyNote.filter((n) => n.data.trashedAt), [everyNote])
  // Notes in the trash for over 30 days go for good.
  useEffect(() => void emptyOldTrash(), [])
  const { items: subjects } = useRecords('subject')
  const { go } = useNav()
  const toast = useToast()
  const { s: settings, set: setSetting } = useSettings()
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('notes')
  const [subjectId, setSubjectId] = useState<string | null>(subjectFilter ?? null)
  const [tag, setTag] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | undefined>(noteId)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [selecting, setSelecting] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null)
  const [moving, setMoving] = useState(false)
  const [focus, setFocus] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  // Folders: the open one (none: the top level, with the folders listed first).
  const folders = useFolders('note')
  const [folderId, setFolderId] = useState<string | null>(null)
  const folder = folders.find((f) => f.id === folderId) ?? null
  const [folderDialog, setFolderDialog] = useState<{ mode: 'new'; parent?: string | null } | { mode: 'rename'; folder: Rec<'folder'> } | null>(null)
  const [movingFolder, setMovingFolder] = useState<Rec<'folder'> | null>(null)
  const parent = folder ? folders.find((f) => f.id === parentOf(folders, folder)) ?? null : null
  const [moveTo, setMoveTo] = useState<Rec<'note'>[] | null>(null)
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; folder: Rec<'folder'> } | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)

  useEffect(() => setSelected(noteId), [noteId])

  const query = q.trim().toLowerCase()
  const terms = useMemo(() => searchTerms(query), [query])
  const inView = view === 'trash' ? trash : notes.filter((n) => (view === 'archived' ? !!n.data.archived : !n.data.archived))
  // The folder a note is in (none if it was in one that's gone).
  const folderOf = (n: Rec<'note'>) => (n.data.folderId && folders.some((f) => f.id === n.data.folderId) ? n.data.folderId : null)
  // Searching or filtering looks through every folder; otherwise you're in one folder (or the top level).
  const filtering = !!terms.length || !!tag || (!!subjectId && subjectId !== subjectFilter)
  const browsing = view === 'notes' && !filtering
  // Notes in a folder, counting the folders inside it.
  const folderCount = (id: string) => {
    const ids = withDescendants(folders, id)
    return inView.filter((n) => ids.has(folderOf(n) ?? '') && (!subjectId || n.data.subjectId === subjectId)).length
  }
  // The folders here (at the top level, or inside the open folder). On a subject's page, only those holding its notes.
  const folderRows = browsing ? childrenOf(folders, folder?.id ?? null).filter((f) => !subjectFilter || folderCount(f.id) > 0) : []
  const allTags = useMemo(() => [...new Set(inView.flatMap((n) => n.data.tags ?? []))].sort(), [inView])
  const shown = inView
    .filter((n) => !subjectId || n.data.subjectId === subjectId)
    .filter((n) => !browsing || folderOf(n) === (folder?.id ?? null))
    .filter((n) => !tag || (n.data.tags ?? []).includes(tag))
    // Search looks through every word of every note (title, text, Cornell cues and summary, tags).
    .filter((n) => !terms.length || scoreNote(n, terms) > 0)
    .sort((a, b) => {
      if (view === 'trash') return (b.data.trashedAt ?? 0) - (a.data.trashedAt ?? 0)
      const pin = Number(!!b.data.pinned) - Number(!!a.data.pinned)
      if (pin) return pin
      if (settings.noteSort === 'title') return (a.data.title || 'Untitled').localeCompare(b.data.title || 'Untitled')
      if (settings.noteSort === 'created') return b.createdAt - a.createdAt
      return b.updatedAt - a.updatedAt
    })
  const current = everyNote.find((n) => n.id === selected)
  const currentStamp = current?.updatedAt
  useEffect(() => {
    if (!remotePending.current) return
    remotePending.current = false
    setRemoteBump((b) => b + 1)
  }, [currentStamp])
  const archivedCount = notes.filter((n) => n.data.archived).length
  const pickedNotes = notes.filter((n) => picked.has(n.id))


  // Focus mode hides the sidebar and the list.
  useEffect(() => {
    document.body.classList.toggle('focus-mode', focus)
    return () => document.body.classList.remove('focus-mode')
  }, [focus])

  const create = async () => {
    const id = await newNote(subjectId, settings, browsing ? folder?.id : null)
    if (view !== 'notes') setView('notes')
    setSelected(id)
    if (!subjectFilter) go({ name: 'notes', noteId: id })
  }

  const { state: drive } = useDrive()
  const phone = usePhone()
  // Another computer changed the open note: show its version (anything you were typing is saved first, and newer wins).
  // The list reloads a moment after the change arrives, so reopen the editor once the new version is here.
  const [remoteBump, setRemoteBump] = useState(0)
  const openId = useRef<string | undefined>(undefined)
  const remotePending = useRef(false)
  openId.current = selected
  useEffect(
    () =>
      onExternalChange((ids) => {
        if (openId.current && ids.includes(openId.current)) remotePending.current = true
      }),
    []
  )
  const [importing, setImporting] = useState(false)
  const fromDrive = async () => {
    setImporting(true)
    toast('Pick files in the browser window that opened…')
    try {
      const ids = await importFromDrive(subjectId)
      if (ids.length) {
        if (view !== 'notes') setView('notes')
        setSelected(ids[0])
        if (!subjectFilter) go({ name: 'notes', noteId: ids[0] })
        toast(ids.length === 1 ? 'Brought in from Google Drive' : `${ids.length} notes brought in from Google Drive`)
      }
    } catch (e) {
      toast(cleanError(e, 'Couldn’t bring that in from Drive.'))
    } finally {
      setImporting(false)
    }
  }

  const switchView = (v: View) => {
    setView(v)
    clearPick()
    // Don't leave a note open that isn't in the list you're looking at.
    if (current && (!!current.data.trashedAt !== (v === 'trash') || (v !== 'trash' && !!current.data.archived !== (v === 'archived')))) setSelected(undefined)
  }

  const clearPick = () => {
    setPicked(new Set())
    setSelecting(false)
    setMoving(false)
  }

  /* ---------- bulk actions (with undo) ---------- */
  const patchMany = async (list: Rec<'note'>[], patch: Partial<Rec<'note'>['data']>, message: string) => {
    const before = list.map((n) => [n.id, n.data] as const)
    for (const n of list) await db.put('note', { ...n.data, ...patch }, n.id)
    toast(message, { label: 'Undo', run: () => before.forEach(([id, data]) => db.put('note', data, id)) })
  }
  // Deleting moves notes to the trash; from the trash it's for good.
  const deleteMany = async (list: Rec<'note'>[]) => {
    if (list.some((n) => n.id === selected)) setSelected(undefined)
    if (view === 'trash' || list.every((n) => n.data.trashedAt)) return setForever(list)
    const undo = await trashNotes(list)
    toast(list.length === 1 ? 'Moved to the trash' : `${list.length} notes moved to the trash`, { label: 'Undo', run: undo })
  }
  const restoreMany = async (list: Rec<'note'>[]) => {
    await restoreNotes(list)
    toast(list.length === 1 ? 'Note restored' : `${list.length} notes restored`, { label: 'Open', run: () => {
      setView(list[0].data.archived ? 'archived' : 'notes')
      setSelected(list[0].id)
    } })
  }
  // Notes waiting for "Delete for good" to be confirmed.
  const [forever, setForever] = useState<Rec<'note'>[] | null>(null)
  const reallyDelete = async () => {
    if (!forever) return
    await deleteForever(forever)
    toast(forever.length === 1 ? 'Deleted for good' : `${forever.length} notes deleted for good`)
    setForever(null)
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  /* ---------- folders ---------- */
  const moveToFolder = (list: Rec<'note'>[], id: string | null, name: string) => {
    const changing = list.filter((n) => folderOf(n) !== id)
    if (!changing.length) return
    patchMany(changing, { folderId: id }, id ? `Moved ${plural(changing.length, 'note')} to ${name}` : `Took ${plural(changing.length, 'note')} out of the folder`)
  }
  const removeFolder = async (f: Rec<'folder'>) => {
    if (folderId && withDescendants(folders, f.id).has(folderId)) openFolder(parentOf(folders, f))
    const undo = await deleteFolder(f)
    toast(`Deleted the folder ${f.data.name}. What was in it moved up a level.`, { label: 'Undo', run: () => void undo() })
  }
  const putFolder = async (f: Rec<'folder'>, into: string | null) => {
    const before = f.data
    if (!(await moveFolder(folders, f, into))) return
    const name = folders.find((x) => x.id === into)?.data.name
    toast(name ? `Moved ${f.data.name} into ${name}` : `Moved ${f.data.name} to the top level`, { label: 'Undo', run: () => void db.put('folder', before, f.id) })
  }
  const openFolder = (id: string | null) => {
    if (id) return toggleFolder(id, true)
    setFolderId(null)
  }
  // Dragging onto a folder (desktop): notes (the picked ones if the dragged one is picked), or another folder.
  const canDrop = (id: string | null) => {
    const d = drag.get()
    if (d?.kind === 'notes') return true
    if (d?.kind !== 'folder' || d.scope !== 'note') return false
    const f = folders.find((x) => x.id === d.id)
    return !!f && !(id && withDescendants(folders, f.id).has(id)) && parentOf(folders, f) !== id
  }
  const dropProps = (id: string | null, name: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDrop(id)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropOn(id ?? 'root')
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropOn(null)
      const d = drag.get()
      drag.end()
      if (d?.kind === 'notes') moveToFolder(notes.filter((n) => d.ids.includes(n.id)), id, name)
      else if (d?.kind === 'folder') {
        const f = folders.find((x) => x.id === d.id)
        if (f && canDropFolder(f, id)) void putFolder(f, id)
      }
    }
  })
  const canDropFolder = (f: Rec<'folder'>, id: string | null) => !(id && withDescendants(folders, f.id).has(id))

  const bulk = {
    pin: () => {
      const allPinned = pickedNotes.every((n) => n.data.pinned)
      patchMany(pickedNotes, { pinned: !allPinned }, allPinned ? `Unpinned ${plural(pickedNotes.length, 'note')}` : `Pinned ${plural(pickedNotes.length, 'note')}`)
    },
    archive: () => {
      const archive = view === 'notes'
      patchMany(pickedNotes, { archived: archive }, `${archive ? 'Archived' : 'Restored'} ${plural(pickedNotes.length, 'note')}`)
      if (pickedNotes.some((n) => n.id === selected)) setSelected(undefined)
      clearPick()
    },
    move: (id: string | null) => {
      const name = subjects.find((x) => x.id === id)?.data.name ?? 'No subject'
      patchMany(pickedNotes, { subjectId: id }, `Moved ${plural(pickedNotes.length, 'note')} to ${name}`)
      setMoving(false)
    },
    export: async () => {
      const n = await exportNotes(pickedNotes.map((x) => x.data))
      if (n) toast(`Exported ${plural(n, 'note')}`)
    },
    remove: () => {
      deleteMany(pickedNotes)
      clearPick()
    },
    restore: () => {
      restoreMany(pickedNotes)
      clearPick()
    }
  }

  /* ---------- clicking rows: plain, Ctrl (toggle), Shift (range) ---------- */
  const onRow = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const ids = shown.map((n) => n.id)
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
      setPicked(new Set([...picked, ...ids.slice(a, b + 1)]))
      setSelecting(true)
      return
    }
    if (e.ctrlKey || e.metaKey || selecting) {
      const next = new Set(picked)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setPicked(next)
      setAnchor(id)
      setSelecting(next.size > 0 || selecting)
      return
    }
    setAnchor(id)
    // On a phone the note slides in over the list, like iOS.
    if (phone && id !== selected) transition(() => setSelected(id), 'push')
    else setSelected(id)
  }

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault()
        create()
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && !typing) {
        if (focus) setFocus(false)
        else if (selecting) clearPick()
      } else if (!typing && selecting && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setPicked(new Set(shown.map((n) => n.id)))
      } else if (!typing && selecting && picked.size && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        bulk.remove()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ctxNote = ctx ? notes.find((n) => n.id === ctx.id) : null

  // Notes fall into sections: Pinned, then by date (or one list when sorted A–Z).
  const hour12 = settings.timeFormat === '12h'
  const stampOf = (n: Rec<'note'>) => (settings.noteSort === 'created' ? n.createdAt : n.updatedAt)
  const sections: [string, Rec<'note'>[]][] = []
  for (const n of shown) {
    const name = view === 'trash' ? 'Notes' : n.data.pinned ? 'Pinned' : settings.noteSort === 'title' ? 'Notes' : section(stampOf(n))
    const last = sections[sections.length - 1]
    if (last && last[0] === name) last[1].push(n)
    else sections.push([name, [n]])
  }
  const activeSubjects = subjects.filter((x) => !x.data.archived)
  const openOnPhone = phone && !!(current || (selecting && picked.size))

  // On the phone an open note is its own page: the dock steps aside for the formatting bar.
  useEffect(() => {
    document.body.classList.toggle('note-open', !!(phone && current && !subjectFilter))
    return () => document.body.classList.remove('note-open')
  }, [phone, current, subjectFilter])

  // A folder opens in place (its folders and notes indented under it), so the rest of the list stays in view.
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('veyra.notes.openFolders') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggleFolder = (id: string, open?: boolean) =>
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (open ?? !next.has(id)) next.add(id)
      else next.delete(id)
      try {
        localStorage.setItem('veyra.notes.openFolders', JSON.stringify([...next]))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  const notesIn = (id: string) =>
    inView
      .filter((n) => folderOf(n) === id && (!subjectId || n.data.subjectId === subjectId) && (!tag || (n.data.tags ?? []).includes(tag)))
      .sort((a, b) =>
        settings.noteSort === 'title' ? (a.data.title || 'Untitled').localeCompare(b.data.title || 'Untitled') : settings.noteSort === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt
      )
  const tree = (parentId: string | null, depth: number): React.ReactNode[] =>
    childrenOf(folders, parentId)
      .filter((f) => !subjectFilter || folderCount(f.id) > 0)
      .flatMap((f) => {
        const open = openFolders.has(f.id)
        const inside = open ? notesIn(f.id) : []
        const sub = open ? tree(f.id, depth + 1) : []
        return [
          <button
            key={f.id}
            className={`np-row np-folder ${dropOn === f.id ? 'drop' : ''} ${open ? 'open' : ''}`}
            style={depth ? { paddingLeft: 12 + depth * 18 } : undefined}
            aria-expanded={open}
            onClick={() => toggleFolder(f.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setFolderCtx({ x: e.clientX, y: e.clientY, folder: f })
            }}
            {...dropProps(f.id, f.data.name)}
            draggable={!phone}
            onDragStart={(e) => {
              drag.start({ kind: 'folder', id: f.id, scope: 'note' })
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', f.data.name)
            }}
            onDragEnd={() => {
              drag.end()
              setDropOn(null)
            }}
          >
            <ChevronRight size={14} className="np-folder-chev" />
            {open || dropOn === f.id ? <FolderOpen size={17} className="np-folder-icon" /> : <FolderIcon size={17} className="np-folder-icon" />}
            <span className="grow trunc np-folder-name">{f.data.name}</span>
            <span className="np-folder-count">{folderCount(f.id)}</span>
          </button>,
          ...sub,
          ...inside.map((n) => renderRow(n, '', depth + 1)),
          ...(open && !sub.length && !inside.length
            ? [
                <p key={`${f.id}-empty`} className="np-folder-empty" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>
                  Empty. Drag notes here, or use a note’s Move to folder.
                </p>
              ]
            : [])
        ]
      })
  const renderRow = (n: Rec<'note'>, name: string, depth = 0) => {
                      const s = subjects.find((x) => x.id === n.data.subjectId)
                      const isPicked = picked.has(n.id)
                      const found = terms.length ? snippet(n, terms) : null
                      const text = found ?? preview(n.data.title, n.data.excerpt)
                      return (
                        <button
                          key={n.id}
                          style={depth ? { paddingLeft: 12 + depth * 18 } : undefined}
                          className={`np-row ${isPicked ? 'picked' : ''}`}
                          aria-current={!selecting && n.id === selected}
                          aria-pressed={selecting ? isPicked : undefined}
                          onClick={(e) => onRow(e, n.id)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setCtx({ x: e.clientX, y: e.clientY, id: n.id })
                          }}
                          draggable={!phone && view === 'notes'}
                          onDragStart={(e) => {
                            drag.start({ kind: 'notes', ids: (isPicked ? pickedNotes : [n]).map((x) => x.id) })
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', n.data.title || 'Untitled')
                          }}
                          onDragEnd={() => {
                            drag.end()
                            setDropOn(null)
                          }}
                        >
                          {selecting && <span className="pick">{isPicked ? <CheckSquare size={17} /> : <Square size={17} />}</span>}
                          <span className="np-row-body">
                            <span className="np-row-title">
                              {n.data.icon && <span className="np-row-emoji">{n.data.icon}</span>}
                              <span className="trunc">{terms.length ? <Marked text={n.data.title || 'Untitled'} terms={terms} /> : n.data.title || 'Untitled'}</span>
                              {n.data.pinned && name !== 'Pinned' && <Pin size={11} className="tert" />}
                              {sharedIds.has(n.id) && <Users size={11} className="tert" aria-label="Shared" />}
                            </span>
                            <span className="np-row-text">
                              <span className="np-row-date">{view === 'trash' ? `${daysLeft(n)}d left` : shortDate(stampOf(n), hour12)}</span>
                              {text ? terms.length ? <Marked text={text} terms={terms} /> : text : <span className="tert">No additional text</span>}
                            </span>
                            {(s || (n.data.tags ?? []).length > 0 || (!browsing && folderOf(n))) && (
                              <span className="np-row-meta">
                                {!browsing && folderOf(n) && (
                                  <span className="np-row-subject">
                                    <FolderIcon size={11} />
                                    {folderPath(folders, folderOf(n)).map((f) => f.data.name).join(' › ')}
                                  </span>
                                )}
                                {s && !subjectFilter && (
                                  <span className="np-row-subject">
                                    <i style={{ background: s.data.color }} />
                                    {s.data.name}
                                  </span>
                                )}
                                {(n.data.tags ?? []).slice(0, 3).map((t) => (
                                  <span key={t} className="mini-tag">
                                    #{t}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        </button>
                      )
  }

  return (
    <div className={`notes-page ${subjectFilter ? 'notes-embed' : 'view notes-full'} ${focus ? 'focus' : ''}`}>
      <div className={`notes-layout ${openOnPhone ? 'phone-open' : ''}`}>
        {!focus && (
          <div className="notes-list">
            <div className="np-head">
              <div className="np-titlebar">
                <div className="grow" style={{ minWidth: 0 }}>
                  {browsing && folder && (
                    <button
                      className={`np-back ${dropOn === (parent?.id ?? 'root') ? 'drop' : ''}`}
                      title={folderPath(folders, folder.id).map((f) => f.data.name).join(' › ')}
                      onClick={() => openFolder(parent?.id ?? null)}
                      {...dropProps(parent?.id ?? null, parent?.data.name ?? '')}
                    >
                      <ChevronLeft size={15} /> <span className="trunc">{parent?.data.name ?? 'Notes'}</span>
                    </button>
                  )}
                  {browsing && folder ? (
                    subjectFilter ? <h2 className="np-title sm-title np-folder-title">{folder.data.name}</h2> : <h1 className="np-title np-folder-title">{folder.data.name}</h1>
                  ) : subjectFilter ? (
                    <h2 className="np-title sm-title">Notes</h2>
                  ) : (
                    <h1 className="np-title">Notes</h1>
                  )}
                  <div className="np-count">
                    {browsing && folder
                      ? plural(folderCount(folder.id), 'note')
                      : plural(notes.filter((n) => !n.data.archived && (!subjectFilter || n.data.subjectId === subjectFilter)).length, 'note')}
                  </div>
                </div>
                {browsing && folder && (
                  <button
                    className="iconbtn plain"
                    title="Rename, move or delete this folder"
                    aria-label="Folder options"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect()
                      setFolderCtx({ x: r.left, y: r.bottom + 4, folder })
                    }}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                )}
                {/* One clear action; the rest is in ⋯ (and right-click). */}
                <button
                  className={`iconbtn plain ${moreMenu ? 'on' : ''}`}
                  aria-label="More"
                  title="New folder, select notes…"
                  aria-expanded={!!moreMenu}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMoreMenu({ x: r.right - 220, y: r.bottom + 4 })
                  }}
                >
                  <MoreHorizontal size={17} />
                </button>
                <button className="btn sm np-new-btn" onClick={create} title="New note (Ctrl+N)">
                  <SquarePen size={15} /> New
                </button>
              </div>

              {/* Search, with filters and sort behind one button. */}
              <div className="np-searchrow">
                <label className="np-search">
                  <Search size={15} aria-hidden="true" />
                  <input ref={searchRef} placeholder="Search notes and #tags" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
                  {q && (
                    <button className="np-clear" aria-label="Clear search" onClick={() => setQ('')}>
                      <X size={12} />
                    </button>
                  )}
                </label>
                <button
                  className={`iconbtn np-filter-btn ${filterOpen || subjectId || tag ? 'on' : ''}`}
                  aria-label="Filter and sort"
                  title="Filter by subject or tag, and sort"
                  aria-expanded={filterOpen}
                  onClick={() => setFilterOpen((v) => !v)}
                >
                  <SlidersHorizontal size={16} />
                  {(subjectId || tag) && <span className="np-filter-dot" />}
                </button>
                {filterOpen && (
                  <div className="popover np-filter-pop" ref={filterRef} role="dialog" aria-label="Filter and sort">
                    {!subjectFilter && activeSubjects.length > 0 && (
                      <>
                        <h2>Subject</h2>
                        <div className="np-filter-list">
                          <button className="np-chip" aria-pressed={!subjectId} onClick={() => setSubjectId(null)}>
                            All subjects
                          </button>
                          {activeSubjects.map((x) => (
                            <button key={x.id} className="np-chip" aria-pressed={subjectId === x.id} onClick={() => setSubjectId(subjectId === x.id ? null : x.id)}>
                              <i style={{ background: x.data.color }} /> {x.data.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    {allTags.length > 0 && (
                      <>
                        <h2>Tag</h2>
                        <div className="np-filter-list">
                          {allTags.map((t) => (
                            <button key={t} className="np-chip tag-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                              #{t}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                    <h2>Sort</h2>
                    <div className="seg np-sort-seg">
                      {(
                        [
                          ['edited', 'Edited'],
                          ['created', 'Newest'],
                          ['title', 'A–Z']
                        ] as const
                      ).map(([v, l]) => (
                        <button key={v} aria-selected={settings.noteSort === v} onClick={() => setSetting({ noteSort: v })}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* What's filtering the list right now (each one comes off with ×). */}
              {(subjectId || tag) && (
                <div className="np-active">
                  {subjectId && (
                    <button className="np-chip" aria-pressed="true" onClick={() => setSubjectId(null)} aria-label="Stop filtering by subject">
                      <i style={{ background: activeSubjects.find((x) => x.id === subjectId)?.data.color }} /> {activeSubjects.find((x) => x.id === subjectId)?.data.name ?? 'Subject'} <X size={11} />
                    </button>
                  )}
                  {tag && (
                    <button className="np-chip tag-chip" aria-pressed="true" onClick={() => setTag(null)} aria-label="Stop filtering by tag">
                      #{tag} <X size={11} />
                    </button>
                  )}
                </div>
              )}

              <div className="np-tools">
                <div className="seg np-seg" role="tablist" aria-label="Which notes">
                  <button role="tab" aria-selected={view === 'notes'} onClick={() => switchView('notes')}>
                    Notes
                  </button>
                  {(signedIn || recentLinks().length > 0) && !subjectFilter && (
                    <button role="tab" aria-selected={view === 'shared'} onClick={() => switchView('shared')}>
                      Shared
                    </button>
                  )}
                  <button role="tab" aria-selected={view === 'archived'} onClick={() => switchView('archived')}>
                    Archived{archivedCount ? ` ${archivedCount}` : ''}
                  </button>
                  {!subjectFilter && (
                    <button role="tab" aria-selected={view === 'trash'} onClick={() => switchView('trash')}>
                      Trash{trash.length ? ` ${trash.length}` : ''}
                    </button>
                  )}
                </div>
              </div>
              {view === 'trash' && trash.length > 0 && (
                <div className="np-trash-bar">
                  <span className="xs dim grow">Notes here are deleted for good after {TRASH_DAYS} days.</span>
                  <button className="linkbtn xs danger-link" onClick={() => setForever(trash)}>
                    Empty trash
                  </button>
                </div>
              )}

              {selecting && (
                <div className="bulk-bar">
                  <button className="linkbtn xs" onClick={() => setPicked(picked.size === shown.length ? new Set() : new Set(shown.map((n) => n.id)))}>
                    {picked.size === shown.length && shown.length ? 'Select none' : 'Select all'}
                  </button>
                  <span className="xs dim grow">{picked.size ? `${picked.size} selected` : phone ? 'Tap notes to pick them' : 'Pick notes, or Shift-click a range'}</span>
                </div>
              )}
            </div>

            <div className="np-scroll">
              {view === 'shared' ? (
                <SharedList
                  signedIn={signedIn}
                  picked={sharedPick?.id ?? null}
                  onPick={setSharedPick}
                  reloadKey={sharedKey}
                  mine={[...new Set(mineShared.map((x) => x.noteId))].flatMap((id) => {
                    const n = notes.find((x) => x.id === id)
                    const of = mineShared.filter((x) => x.noteId === id)
                    return n ? [{ id, title: n.data.title, people: of.filter((x) => x.to).length, link: of.some((x) => !x.to) }] : []
                  })}
                  onOpenMine={(id) => {
                    switchView('notes')
                    setSelected(id)
                  }}
                />
              ) : (
              <>
              {folderRows.length > 0 && (
                <section className="np-section">
                  <h3 className="np-section-title">Folders</h3>
                  <div className="np-group">{tree(null, 0)}</div>
                </section>
              )}
              {sections.map(([name, list]) => (
                <section key={name} className="np-section">
                  {!(sections.length === 1 && name === 'Notes') && <h3 className="np-section-title">{name}</h3>}
                  <div className="np-group">
                    {list.map((n) => renderRow(n, name))}
                  </div>
                </section>
              ))}
              {loaded && !shown.length && (
                <div className="np-empty">
                  <NotebookPen size={22} />
                  <p>
                    {filtering
                      ? 'No notes match.'
                      : browsing && folder
                        ? folderRows.length
                          ? 'No notes directly in this folder.'
                          : 'This folder is empty. Make a note here, or drag notes onto it.'
                      : view === 'trash'
                        ? `The trash is empty. Deleted notes wait here for ${TRASH_DAYS} days.`
                        : view === 'archived'
                          ? 'No archived notes. Archive a note from its ••• menu to tidy your list without deleting it.'
                          : 'No notes yet.'}
                  </p>
                  {view === 'notes' && !query && !tag && (
                    <button className="btn sec sm" onClick={create}>
                      <Plus size={14} /> New note
                    </button>
                  )}
                </div>
              )}
              </>
              )}
            </div>
          </div>
        )}

        {view === 'shared' ? (
          sharedPick ? (
            <SharedPane
              key={sharedPick.id}
              pick={sharedPick}
              who={me?.displayName || me?.username || 'Guest'}
              onBack={phone ? () => setSharedPick(null) : undefined}
              onCopied={(id) => {
                switchView('notes')
                setSelected(id)
              }}
              onRemoved={() => {
                setSharedPick(null)
                setSharedKey((k) => k + 1)
              }}
            />
          ) : (
            <div className="note-pane note-empty">
              <Empty icon={Users} title="Shared notes" text="Notes people share with you open here. Editors write together, and everyone sees changes as they happen." />
            </div>
          )
        ) : selecting && picked.size > 0 ? (
          <div className="note-pane bulk-panel">
            {phone && (
              <div className="np-appbar">
                <button className="phone-back" onClick={clearPick}>
                  <ChevronLeft size={20} /> Notes
                </button>
              </div>
            )}
            <div className="bulk-count">{plural(picked.size, 'note')} selected</div>
            <div className="bulk-actions">
              {view === 'trash' ? (
                <>
                  <button className="btn sec" onClick={bulk.restore}>
                    <RotateCcw size={15} /> Restore
                  </button>
                  <button className="btn dan" onClick={bulk.remove}>
                    <Trash2 size={15} /> Delete for good
                  </button>
                </>
              ) : (
              <>
              <button className="btn sec" onClick={bulk.pin}>
                {pickedNotes.every((n) => n.data.pinned) ? <PinOff size={15} /> : <Pin size={15} />}
                {pickedNotes.every((n) => n.data.pinned) ? 'Unpin' : 'Pin'}
              </button>
              <span className="anchor">
                <button className="btn sec" onClick={() => setMoving(!moving)}>
                  <FolderInput size={15} /> Move to subject
                </button>
                {moving && (
                  <div className="popover" style={{ left: 0, right: 'auto', width: 240 }}>
                    <button className="menu-row" onClick={() => bulk.move(null)}>
                      No subject
                    </button>
                    {activeSubjects.map((x) => (
                      <button key={x.id} className="menu-row" onClick={() => bulk.move(x.id)}>
                        <span style={{ width: 9, height: 9, borderRadius: 9, background: x.data.color }} /> {x.data.name}
                      </button>
                    ))}
                  </div>
                )}
              </span>
              <button className="btn sec" onClick={() => setMoveTo(pickedNotes)}>
                <FolderIcon size={15} /> Move to folder
              </button>
              <button className="btn sec" onClick={bulk.export}>
                <Download size={15} /> Export
              </button>
              <button className="btn sec" onClick={bulk.archive}>
                {view === 'notes' ? <Archive size={15} /> : <ArchiveRestore size={15} />} {view === 'notes' ? 'Archive' : 'Unarchive'}
              </button>
              <button className="btn dan" onClick={bulk.remove}>
                <Trash2 size={15} /> Delete
              </button>
              </>
              )}
            </div>
            {!phone && (
              <p className="xs tert" style={{ marginTop: 14 }}>
                {view === 'trash' ? 'Ctrl+A selects all · Esc cancels.' : 'Ctrl+A selects all · Delete moves the selection to the trash · Esc cancels. Every action can be undone.'}
              </p>
            )}
          </div>
        ) : current?.data.trashedAt ? (
          <div className="note-pane">
            {phone && (
              <div className="np-appbar">
                <button className="phone-back" onClick={() => transition(() => setSelected(undefined), 'pop')}>
                  <ChevronLeft size={20} /> Trash
                </button>
              </div>
            )}
            <TrashedNote note={current} onRestore={() => restoreMany([current])} onDelete={() => deleteMany([current])} />
          </div>
        ) : current ? (
          <div className="note-pane">
            {phone && (
              <div className="np-appbar">
                <button className="phone-back" onClick={() => transition(() => setSelected(undefined), 'pop')}>
                  <ChevronLeft size={20} /> Notes
                </button>
              </div>
            )}
            <NoteEditor
              key={`${current.id}:${remoteBump}`}
              note={current}
              onDeleted={() => setSelected(undefined)}
              onOpen={(id) => setSelected(id)}
              focusMode={focus}
              onToggleFocus={subjectFilter || phone ? undefined : () => setFocus(!focus)}
              onReplaced={() => (remotePending.current = true)}
            />
          </div>
        ) : (
          view === 'notes' && !subjectFilter && notes.some((n) => !n.data.archived) ? (
            // Nothing open: your most recent notes, to pick up where you left off.
            <div className="note-pane notes-home">
              <div className="nh-head">
                <h2>Pick up where you left off</h2>
                <button className="btn" onClick={create}>
                  <Plus size={16} /> New note
                </button>
              </div>
              <div className="nh-grid">
                {notes
                  .filter((n) => !n.data.archived)
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .slice(0, 8)
                  .map((n) => {
                    const sj = subjects.find((x) => x.id === n.data.subjectId)
                    return (
                      <button key={n.id} className="nh-card" onClick={() => setSelected(n.id)}>
                        <span className="nh-strip" style={{ background: n.data.cover && NOTE_COVERS[n.data.cover] ? NOTE_COVERS[n.data.cover] : sj?.data.color ?? 'var(--fill-secondary)' }} />
                        <span className="nh-title">
                          {n.data.icon && <span>{n.data.icon}</span>}
                          <span className="trunc">{n.data.title || 'Untitled'}</span>
                        </span>
                        <span className="nh-text">{preview(n.data.title, n.data.excerpt) || 'No text yet'}</span>
                        <span className="nh-meta">
                          {sj && <i style={{ background: sj.data.color }} />}
                          {sj ? `${sj.data.name} · ` : ''}
                          {formatDistanceToNowStrict(n.updatedAt, { addSuffix: true })}
                        </span>
                      </button>
                    )
                  })}
              </div>
              <p className="nh-tip">Ctrl+N makes a new note anywhere. Right-click a note for more.</p>
            </div>
          ) : (
          <div className="note-pane note-empty">
            <Empty
              icon={NotebookPen}
              title={view === 'trash' ? 'Pick a note to restore it' : view === 'archived' ? 'Pick an archived note' : 'Pick a note or start one'}
              text="Notes save automatically as you type. Ctrl+N makes a new one."
              action={
                <button className="btn" onClick={create}>
                  <Plus size={16} /> New note
                </button>
              }
            />
          </div>
          )
        )}
      </div>

      {ctx && ctxNote && (
        <RowMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={ctxNote.data.trashedAt ? [
            ['Restore', <RotateCcw size={15} key="r" />, () => restoreMany([ctxNote])],
            ['Select', <CheckSquare size={15} key="s" />, () => { setSelecting(true); setPicked(new Set([...picked, ctxNote.id])) }],
            ['Delete for good', <Trash2 size={15} key="x" />, () => deleteMany([ctxNote]), true]
          ] : [
            ['Open', <FileText size={15} key="o" />, () => setSelected(ctxNote.id)],
            [ctxNote.data.pinned ? 'Unpin' : 'Pin to top', ctxNote.data.pinned ? <PinOff size={15} key="p" /> : <Pin size={15} key="p" />, () => db.put('note', { ...ctxNote.data, pinned: !ctxNote.data.pinned }, ctxNote.id)],
            ['Move to folder…', <FolderIcon size={15} key="f" />, () => setMoveTo([ctxNote])],
            ['Duplicate', <Copy size={15} key="d" />, async () => setSelected((await duplicateNote(ctxNote.data)).id)],
            ['Export as Markdown', <Download size={15} key="e" />, async () => (await exportNotes([ctxNote.data])) && toast('Note exported')],
            ['Select', <CheckSquare size={15} key="s" />, () => { setSelecting(true); setPicked(new Set([...picked, ctxNote.id])) }],
            [
              ctxNote.data.archived ? 'Unarchive' : 'Archive',
              ctxNote.data.archived ? <ArchiveRestore size={15} key="a" /> : <Archive size={15} key="a" />,
              () => patchMany([ctxNote], { archived: !ctxNote.data.archived }, ctxNote.data.archived ? 'Note restored' : 'Note archived')
            ],
            ['Move to trash', <Trash2 size={15} key="x" />, () => deleteMany([ctxNote]), true]
          ]}
        />
      )}
      {folderCtx && (
        <RowMenu
          x={folderCtx.x}
          y={folderCtx.y}
          onClose={() => setFolderCtx(null)}
          items={[
            [openFolders.has(folderCtx.folder.id) ? 'Fold' : 'Open', <FolderOpen size={15} key="o" />, () => toggleFolder(folderCtx.folder.id)],
            ['New folder inside', <FolderPlus size={15} key="n" />, () => (toggleFolder(folderCtx.folder.id, true), setFolderDialog({ mode: 'new', parent: folderCtx.folder.id }))],
            ['Rename', <Pencil size={15} key="r" />, () => setFolderDialog({ mode: 'rename', folder: folderCtx.folder })],
            ['Move to…', <FolderInput size={15} key="m" />, () => setMovingFolder(folderCtx.folder)],
            ['Delete folder', <Trash2 size={15} key="x" />, () => removeFolder(folderCtx.folder), true]
          ]}
        />
      )}
      {moreMenu && (
        <RowMenu
          x={moreMenu.x}
          y={moreMenu.y}
          onClose={() => setMoreMenu(null)}
          items={[
            ...(browsing ? [[folder ? `New folder in ${folder.data.name}` : 'New folder', <FolderPlus size={15} key="i" />, () => setFolderDialog({ mode: 'new' })] as [string, React.ReactNode, () => void]] : []),
            [selecting ? 'Done selecting' : 'Select notes', <CheckSquare size={15} key="i" />, () => (selecting ? clearPick() : setSelecting(true))],
            ...(drive?.connected && drive.canPick && !onAndroid() ? [[importing ? 'Open the Drive picker again' : 'From Google Drive', <HardDrive size={15} key="i" />, () => void fromDrive()] as [string, React.ReactNode, () => void]] : [])
          ]}
        />
      )}
      {folderDialog && (
        <FolderNameDialog
          title={folderDialog.mode === 'new' ? 'New folder' : 'Rename folder'}
          action={folderDialog.mode === 'new' ? 'Create' : 'Rename'}
          initial={folderDialog.mode === 'rename' ? folderDialog.folder.data.name : ''}
          onClose={() => setFolderDialog(null)}
          onSave={(name) => void (folderDialog.mode === 'new' ? newFolder('note', name, folderDialog.parent ?? folder?.id ?? null) : renameFolder(folderDialog.folder, name))}
        />
      )}
      {movingFolder && (
        <FolderPickDialog
          scope="note"
          folders={folders}
          title={`Move ${movingFolder.data.name} to…`}
          noneLabel="Top level"
          current={parentOf(folders, movingFolder)}
          exclude={withDescendants(folders, movingFolder.id)}
          onPick={(id) => void putFolder(movingFolder, id)}
          onClose={() => setMovingFolder(null)}
        />
      )}
      {moveTo && (
        <FolderPickDialog
          scope="note"
          folders={folders}
          title={moveTo.length === 1 ? 'Move to folder' : `Move ${plural(moveTo.length, 'note')} to folder`}
          current={new Set(moveTo.map(folderOf)).size === 1 ? folderOf(moveTo[0]) : undefined}
          onPick={(id, name) => moveToFolder(moveTo, id, name)}
          onClose={() => setMoveTo(null)}
        />
      )}
      {forever && (
        <Dialog title={forever.length === trash.length && forever.length > 1 ? 'Empty the trash?' : forever.length === 1 ? 'Delete this note for good?' : `Delete ${forever.length} notes for good?`} onClose={() => setForever(null)}>
          <p className="dim" style={{ marginTop: 0 }}>
            {forever.length === 1 ? `“${forever[0].data.title || 'Untitled'}” is removed` : `${forever.length} notes are removed`} from this device and your other devices. This can’t be undone.
          </p>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setForever(null)}>
              Cancel
            </button>
            <button className="btn dan" onClick={reallyDelete}>
              Delete for good
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/** A note in the trash: what it was, when it goes for good, and putting it back. */
function TrashedNote({ note, onRestore, onDelete }: { note: Rec<'note'>; onRestore: () => void; onDelete: () => void }) {
  const left = daysLeft(note)
  const text = preview(note.data.title, note.data.excerpt)
  return (
    <div className="trashed-note">
      <div className="trashed-banner">
        <Trash2 size={16} />
        <span className="grow">
          In the trash. {left === 0 ? 'It’s removed for good today.' : `It’s removed for good in ${left} ${left === 1 ? 'day' : 'days'}.`}
        </span>
        <button className="btn sm" onClick={onRestore}>
          <RotateCcw size={14} /> Restore
        </button>
        <button className="btn sm ghost" onClick={onDelete}>
          Delete for good
        </button>
      </div>
      <h1 className="trashed-title">
        {note.data.icon && <span style={{ marginRight: 8 }}>{note.data.icon}</span>}
        {note.data.title || 'Untitled'}
      </h1>
      <p className="trashed-text">{text || <span className="tert">This note was empty.</span>}</p>
      <p className="xs tert">Restore it to read and edit the whole note.</p>
    </div>
  )
}
