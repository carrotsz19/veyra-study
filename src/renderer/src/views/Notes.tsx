import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, ArrowUpDown, CheckSquare, ChevronLeft, Copy, Download, FileText, FolderInput, HardDrive, NotebookPen, Pin, PinOff, Plus, Search, Square, SquarePen, Trash2, X
} from 'lucide-react'
import type { NoteFont, NoteTemplate, Rec } from '@shared/types'
import { db, onExternalChange, useRecords } from '../data/store'
import { Empty, useToast } from '../components/ui'
import { NOTE_COVERS, NoteEditor, duplicateNote, exportNotes } from '../components/notes/NoteEditor'
import { useSettings } from '../data/settings'
import { preview, section, shortDate } from '../components/notes/listing'
import { useNav } from '../nav'
import { onAndroid, usePhone } from '../lib/phone'
import { cleanError, importFromDrive, useDrive } from '../data/drive'

/** A new note, starting from the defaults in Settings → Notes. */
export async function newNote(subjectId: string | null, d?: { noteTemplate: NoteTemplate; noteFont: NoteFont; noteCover: string }): Promise<string> {
  const covers = Object.keys(NOTE_COVERS)
  const cover = !d || d.noteCover === 'none' ? null : d.noteCover === 'random' ? covers[Math.floor(Math.random() * covers.length)] : d.noteCover
  const rec = await db.put('note', { title: '', subjectId, content: null, excerpt: '', template: d?.noteTemplate, font: d?.noteFont, cover })
  return rec.id
}

type View = 'notes' | 'archived'

/** Right-click menu for one note. */
function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: [string, React.ReactNode, () => void, boolean?][]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => document.addEventListener('mousedown', away))
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - items.length * 36 - 16) }}>
      {items.map(([label, icon, run, danger]) => (
        <button
          key={label}
          role="menuitem"
          className={`menu-row ${danger ? 'danger' : ''}`}
          onClick={() => {
            run()
            onClose()
          }}
        >
          {icon} {label}
        </button>
      ))}
    </div>
  )
}

export function Notes({ noteId, subjectFilter }: { noteId?: string; subjectFilter?: string }) {
  const { items: notes, loaded } = useRecords('note')
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

  useEffect(() => setSelected(noteId), [noteId])

  const query = q.trim().toLowerCase()
  const inView = notes.filter((n) => (view === 'archived' ? !!n.data.archived : !n.data.archived))
  const allTags = useMemo(() => [...new Set(inView.flatMap((n) => n.data.tags ?? []))].sort(), [inView])
  const shown = inView
    .filter((n) => !subjectId || n.data.subjectId === subjectId)
    .filter((n) => !tag || (n.data.tags ?? []).includes(tag))
    .filter(
      (n) =>
        !query ||
        n.data.title.toLowerCase().includes(query) ||
        n.data.excerpt.toLowerCase().includes(query) ||
        (n.data.tags ?? []).some((t) => t.includes(query.replace(/^#/, '')))
    )
    .sort((a, b) => {
      const pin = Number(!!b.data.pinned) - Number(!!a.data.pinned)
      if (pin) return pin
      if (settings.noteSort === 'title') return (a.data.title || 'Untitled').localeCompare(b.data.title || 'Untitled')
      if (settings.noteSort === 'created') return b.createdAt - a.createdAt
      return b.updatedAt - a.updatedAt
    })
  const current = notes.find((n) => n.id === selected)
  const currentStamp = current?.updatedAt
  useEffect(() => {
    if (!remotePending.current) return
    remotePending.current = false
    setRemoteBump((b) => b + 1)
  }, [currentStamp])
  const archivedCount = notes.filter((n) => n.data.archived).length
  const pickedNotes = notes.filter((n) => picked.has(n.id))

  // Open the most recent note when nothing is picked yet (on a computer; a phone shows the list first).
  useEffect(() => {
    if (loaded && !selected && shown.length && !phone) setSelected(shown[0].id)
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus mode hides the sidebar and the list.
  useEffect(() => {
    document.body.classList.toggle('focus-mode', focus)
    return () => document.body.classList.remove('focus-mode')
  }, [focus])

  const create = async () => {
    const id = await newNote(subjectId, settings)
    if (view === 'archived') setView('notes')
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
        if (view === 'archived') setView('notes')
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
    if (current && !!current.data.archived !== (v === 'archived')) setSelected(undefined)
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
  const deleteMany = async (list: Rec<'note'>[]) => {
    const before = list.map((n) => [n.id, n.data] as const)
    for (const n of list) await db.remove('note', n.id)
    if (list.some((n) => n.id === selected)) setSelected(undefined)
    toast(list.length === 1 ? 'Note deleted' : `${list.length} notes deleted`, { label: 'Undo', run: () => before.forEach(([id, data]) => db.put('note', data, id)) })
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
    setSelected(id)
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
    const name = n.data.pinned ? 'Pinned' : settings.noteSort === 'title' ? 'Notes' : section(stampOf(n))
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

  return (
    <div className={`notes-page ${subjectFilter ? 'notes-embed' : 'view notes-full'} ${focus ? 'focus' : ''}`}>
      <div className={`notes-layout ${openOnPhone ? 'phone-open' : ''}`}>
        {!focus && (
          <div className="notes-list">
            <div className="np-head">
              <div className="np-titlebar">
                <div className="grow" style={{ minWidth: 0 }}>
                  {subjectFilter ? <h2 className="np-title sm-title">Notes</h2> : <h1 className="np-title">Notes</h1>}
                  <div className="np-count">
                    {plural(notes.filter((n) => !n.data.archived && (!subjectFilter || n.data.subjectId === subjectFilter)).length, 'note')}
                  </div>
                </div>
                <button
                  className={`iconbtn plain ${selecting ? 'on' : ''}`}
                  aria-pressed={selecting}
                  onClick={() => (selecting ? clearPick() : setSelecting(true))}
                  title={selecting ? 'Done selecting' : 'Select several notes (or Ctrl-click them)'}
                  aria-label={selecting ? 'Done selecting' : 'Select notes'}
                >
                  <CheckSquare size={17} />
                </button>
                {drive?.connected && drive.canPick && !onAndroid() && (
                  <button className="iconbtn plain" onClick={fromDrive} title={importing ? 'Closed the picker? Click to open it again.' : 'Open Google Docs and files from your Drive'} aria-label="From Google Drive">
                    <HardDrive size={17} />
                  </button>
                )}
                <button className="iconbtn np-new" onClick={create} title="New note (Ctrl+N)" aria-label="New note">
                  <SquarePen size={17} />
                </button>
              </div>

              <label className="np-search">
                <Search size={15} aria-hidden="true" />
                <input ref={searchRef} placeholder="Search notes and #tags" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
                {q && (
                  <button className="np-clear" aria-label="Clear search" onClick={() => setQ('')}>
                    <X size={12} />
                  </button>
                )}
              </label>

              {(!subjectFilter && activeSubjects.length > 0) || allTags.length > 0 ? (
                <div className="np-chips" aria-label="Filter notes">
                  {!subjectFilter && activeSubjects.length > 0 && (
                    <>
                      <button className="np-chip" aria-pressed={!subjectId} onClick={() => setSubjectId(null)}>
                        All
                      </button>
                      {activeSubjects.map((x) => (
                        <button key={x.id} className="np-chip" aria-pressed={subjectId === x.id} onClick={() => setSubjectId(subjectId === x.id ? null : x.id)}>
                          <i style={{ background: x.data.color }} /> {x.data.name}
                        </button>
                      ))}
                    </>
                  )}
                  {allTags.map((t) => (
                    <button key={t} className="np-chip tag-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                      #{t}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="np-tools">
                <div className="seg np-seg" role="tablist" aria-label="Which notes">
                  <button role="tab" aria-selected={view === 'notes'} onClick={() => switchView('notes')}>
                    Notes
                  </button>
                  <button role="tab" aria-selected={view === 'archived'} onClick={() => switchView('archived')}>
                    Archived{archivedCount ? ` ${archivedCount}` : ''}
                  </button>
                </div>
                <span className="grow" />
                <label className="np-sort">
                  <ArrowUpDown size={13} aria-hidden="true" />
                  <select aria-label="Sort notes" value={settings.noteSort} onChange={(e) => setSetting({ noteSort: e.target.value as typeof settings.noteSort })}>
                    <option value="edited">Last edited</option>
                    <option value="created">Newest</option>
                    <option value="title">A–Z</option>
                  </select>
                </label>
              </div>

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
              {sections.map(([name, list]) => (
                <section key={name} className="np-section">
                  {!(sections.length === 1 && name === 'Notes') && <h3 className="np-section-title">{name}</h3>}
                  <div className="np-group">
                    {list.map((n) => {
                      const s = subjects.find((x) => x.id === n.data.subjectId)
                      const isPicked = picked.has(n.id)
                      const text = preview(n.data.title, n.data.excerpt)
                      return (
                        <button
                          key={n.id}
                          className={`np-row ${isPicked ? 'picked' : ''}`}
                          aria-current={!selecting && n.id === selected}
                          aria-pressed={selecting ? isPicked : undefined}
                          onClick={(e) => onRow(e, n.id)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setCtx({ x: e.clientX, y: e.clientY, id: n.id })
                          }}
                        >
                          {selecting && <span className="pick">{isPicked ? <CheckSquare size={17} /> : <Square size={17} />}</span>}
                          <span className="np-row-body">
                            <span className="np-row-title">
                              {n.data.icon && <span className="np-row-emoji">{n.data.icon}</span>}
                              <span className="trunc">{n.data.title || 'Untitled'}</span>
                              {n.data.pinned && name !== 'Pinned' && <Pin size={11} className="tert" />}
                            </span>
                            <span className="np-row-text">
                              <span className="np-row-date">{shortDate(stampOf(n), hour12)}</span>
                              {text || <span className="tert">No additional text</span>}
                            </span>
                            {(s || (n.data.tags ?? []).length > 0) && (
                              <span className="np-row-meta">
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
                    })}
                  </div>
                </section>
              ))}
              {loaded && !shown.length && (
                <div className="np-empty">
                  <NotebookPen size={22} />
                  <p>{query || tag || subjectId ? 'No notes match.' : view === 'archived' ? 'No archived notes. Archive a note from its ••• menu to tidy your list without deleting it.' : 'No notes yet.'}</p>
                  {view === 'notes' && !query && !tag && (
                    <button className="btn sec sm" onClick={create}>
                      <Plus size={14} /> New note
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {selecting && picked.size > 0 ? (
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
              <button className="btn sec" onClick={bulk.export}>
                <Download size={15} /> Export
              </button>
              <button className="btn sec" onClick={bulk.archive}>
                {view === 'notes' ? <Archive size={15} /> : <ArchiveRestore size={15} />} {view === 'notes' ? 'Archive' : 'Unarchive'}
              </button>
              <button className="btn dan" onClick={bulk.remove}>
                <Trash2 size={15} /> Delete
              </button>
            </div>
            {!phone && (
              <p className="xs tert" style={{ marginTop: 14 }}>
                Ctrl+A selects all · Delete removes the selection · Esc cancels. Every action can be undone.
              </p>
            )}
          </div>
        ) : current ? (
          <div className="note-pane">
            {phone && (
              <div className="np-appbar">
                <button className="phone-back" onClick={() => setSelected(undefined)}>
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
            />
          </div>
        ) : (
          <div className="note-pane note-empty">
            <Empty
              icon={NotebookPen}
              title={view === 'archived' ? 'Pick an archived note' : 'Pick a note or start one'}
              text="Notes save automatically as you type. Ctrl+N makes a new one."
              action={
                <button className="btn" onClick={create}>
                  <Plus size={16} /> New note
                </button>
              }
            />
          </div>
        )}
      </div>

      {ctx && ctxNote && (
        <RowMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            ['Open', <FileText size={15} key="o" />, () => setSelected(ctxNote.id)],
            [ctxNote.data.pinned ? 'Unpin' : 'Pin to top', ctxNote.data.pinned ? <PinOff size={15} key="p" /> : <Pin size={15} key="p" />, () => db.put('note', { ...ctxNote.data, pinned: !ctxNote.data.pinned }, ctxNote.id)],
            ['Duplicate', <Copy size={15} key="d" />, async () => setSelected((await duplicateNote(ctxNote.data)).id)],
            ['Export as Markdown', <Download size={15} key="e" />, async () => (await exportNotes([ctxNote.data])) && toast('Note exported')],
            ['Select', <CheckSquare size={15} key="s" />, () => { setSelecting(true); setPicked(new Set([...picked, ctxNote.id])) }],
            [
              ctxNote.data.archived ? 'Unarchive' : 'Archive',
              ctxNote.data.archived ? <ArchiveRestore size={15} key="a" /> : <Archive size={15} key="a" />,
              () => patchMany([ctxNote], { archived: !ctxNote.data.archived }, ctxNote.data.archived ? 'Note restored' : 'Note archived')
            ],
            ['Delete', <Trash2 size={15} key="x" />, () => deleteMany([ctxNote]), true]
          ]}
        />
      )}
    </div>
  )
}
