import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { FileText, NotebookPen, Pin, Plus, Search } from 'lucide-react'
import { db, useRecords } from '../data/store'
import { Empty } from '../components/ui'
import { NOTE_COVERS, NoteEditor } from '../components/notes/NoteEditor'
import { useSettings } from '../data/settings'
import type { NoteFont, NoteTemplate } from '@shared/types'
import { SubjectSelect } from '../components/editors'
import { useNav } from '../nav'

/** A new note, starting from the defaults in Settings → Notes. */
export async function newNote(subjectId: string | null, d?: { noteTemplate: NoteTemplate; noteFont: NoteFont; noteCover: string }): Promise<string> {
  const covers = Object.keys(NOTE_COVERS)
  const cover = !d || d.noteCover === 'none' ? null : d.noteCover === 'random' ? covers[Math.floor(Math.random() * covers.length)] : d.noteCover
  const rec = await db.put('note', { title: '', subjectId, content: null, excerpt: '', template: d?.noteTemplate, font: d?.noteFont, cover })
  return rec.id
}

export function Notes({ noteId, subjectFilter }: { noteId?: string; subjectFilter?: string }) {
  const { items: notes, loaded } = useRecords('note')
  const { items: subjects } = useRecords('subject')
  const { go } = useNav()
  const { s: settings } = useSettings()
  const [q, setQ] = useState('')
  const [subjectId, setSubjectId] = useState<string | null>(subjectFilter ?? null)
  const [selected, setSelected] = useState<string | undefined>(noteId)

  useEffect(() => setSelected(noteId), [noteId])

  const query = q.trim().toLowerCase()
  const shown = notes
    .filter((n) => !subjectId || n.data.subjectId === subjectId)
    .filter((n) => !query || n.data.title.toLowerCase().includes(query) || n.data.excerpt.toLowerCase().includes(query))
    .sort((a, b) => Number(!!b.data.pinned) - Number(!!a.data.pinned) || b.updatedAt - a.updatedAt)
  const current = notes.find((n) => n.id === selected)

  // Open the most recent note when nothing is picked yet.
  useEffect(() => {
    if (loaded && !selected && shown.length) setSelected(shown[0].id)
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const id = await newNote(subjectId, settings)
    setSelected(id)
    if (!subjectFilter) go({ name: 'notes', noteId: id })
  }

  return (
    <div className={subjectFilter ? '' : 'view'} style={subjectFilter ? undefined : { maxWidth: 1400, margin: '0 auto' }}>
      {!subjectFilter && (
        <div className="topbar">
          <h1>Notes</h1>
          <button className="btn" onClick={create}>
            <Plus size={16} /> New note
          </button>
        </div>
      )}
      <div className="notes-layout" style={subjectFilter ? { height: 680 } : undefined}>
        <div className="notes-list">
          <div className="card row" style={{ padding: '4px 10px', marginBottom: 8 }}>
            <Search size={16} className="dim" />
            <input style={{ border: 0 }} placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
          </div>
          {subjectFilter ? (
            <button className="btn sec full" style={{ width: '100%', marginBottom: 8 }} onClick={create}>
              <Plus size={15} /> New note
            </button>
          ) : (
            <div style={{ marginBottom: 8 }}>
              <SubjectSelect value={subjectId} onChange={setSubjectId} noneLabel="All subjects" />
            </div>
          )}
          {shown.length > 0 && (
            <div className="ig">
              {shown.map((n) => {
                const s = subjects.find((x) => x.id === n.data.subjectId)
                return (
                  <button key={n.id} className="ig-row tap note-row" aria-current={n.id === selected} onClick={() => setSelected(n.id)}>
                    <span className="note-row-icon" style={!n.data.icon && s ? { color: s.data.color } : undefined}>
                      {n.data.icon ?? <FileText size={17} />}
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="note-row-title trunc">
                        {n.data.pinned && <Pin size={11} className="tert" style={{ marginRight: 4 }} />}
                        {n.data.title || 'Untitled'}
                      </span>
                      <span className="ig-sub note-row-excerpt">{n.data.excerpt || 'Empty note'}</span>
                      <span className="xs tert row" style={{ gap: 6, marginTop: 2 }}>
                        {s && <span style={{ width: 7, height: 7, borderRadius: 9, background: s.data.color }} />}
                        {s ? `${s.data.name} · ` : ''}
                        {formatDistanceToNowStrict(n.updatedAt, { addSuffix: true })}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {loaded && !shown.length && <div className="sm dim" style={{ padding: 12 }}>{query ? 'No notes match.' : 'No notes yet.'}</div>}
        </div>
        {current ? (
          <NoteEditor key={current.id} note={current} onDeleted={() => setSelected(undefined)} />
        ) : (
          <div className="card note-empty">
            <Empty
              icon={NotebookPen}
              title="Pick a note or start one"
              text="Notes save automatically as you type."
              action={
                <button className="btn" onClick={create}>
                  <Plus size={16} /> New note
                </button>
              }
            />
          </div>
        )}
      </div>
    </div>
  )
}
