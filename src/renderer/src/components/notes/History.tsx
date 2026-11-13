import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns'
import { Copy, History as HistoryIcon, RotateCcw, X } from 'lucide-react'
import type { NoteVersion, Rec } from '@shared/types'
import { noteExtensions } from './extensions'
import { noteToMarkdown } from './markdown'
import { onVersionsChanged, versionsOf } from '../../lib/history'
import { usePhone } from '../../lib/phone'
import { useToast } from '../ui'

const when = (at: number) => (isToday(at) ? `Today, ${format(at, 'HH:mm')}` : isYesterday(at) ? `Yesterday, ${format(at, 'HH:mm')}` : format(at, 'EEE d MMM yyyy, HH:mm'))

/** One version, read-only, laid out like the note. */
function Preview({ v }: { v: NoteVersion }) {
  const editor = useEditor({ extensions: noteExtensions('', false, false), content: (v.content as object) ?? '', editable: false, immediatelyRender: true }, [v])
  return (
    <div className="hist-preview">
      <h1 className="hist-title">{v.title || 'Untitled'}</h1>
      <EditorContent editor={editor} className="hist-doc" />
    </div>
  )
}

/**
 * Note history (lib/history.ts): the note's earlier versions, newest first. Pick one to
 * see it; Restore brings it back (the current text is kept as a version first, so a
 * restore can be undone the same way).
 */
export function NoteHistory({ noteId, currentWords, onRestore, onClose }: { noteId: string; currentWords: number; onRestore: (v: NoteVersion) => void; onClose: () => void }) {
  const toast = useToast()
  const phone = usePhone()
  const [list, setList] = useState<Rec<'noteVersion'>[] | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  useEffect(() => {
    const read = () => void versionsOf(noteId).then(setList)
    read()
    return onVersionsChanged(read)
  }, [noteId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const shown = list?.find((v) => v.id === pick) ?? (phone ? null : list?.[0]) ?? null

  const copy = async (v: NoteVersion) => {
    await navigator.clipboard.writeText(noteToMarkdown(v))
    toast('Copied that version’s text')
  }

  return (
    <div className="scrim hist-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`hist ${shown && phone ? 'hist-reading' : ''}`} role="dialog" aria-modal="true" aria-label="Version history">
        <aside className="hist-list">
          <div className="hist-head">
            <HistoryIcon size={17} />
            <b>Version history</b>
            <button className="iconbtn plain" aria-label="Close" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
          {list === null ? (
            <p className="hist-empty">Loading…</p>
          ) : list.length === 0 ? (
            <p className="hist-empty">No earlier versions yet. Veyra keeps one when you come back to change a note (at most every 10 minutes).</p>
          ) : (
            <ul>
              {list.map((v, i) => {
                const newer = i === 0 ? currentWords : list[i - 1].data.words
                const diff = newer - v.data.words
                return (
                  <li key={v.id}>
                    <button className="hist-row" aria-current={shown?.id === v.id || undefined} onClick={() => setPick(v.id)}>
                      <b>{when(v.data.at)}</b>
                      <span>
                        {formatDistanceToNowStrict(v.data.at, { addSuffix: true })} · {v.data.words} words
                        {diff !== 0 && <em className={diff > 0 ? 'more' : 'less'}>{` (${diff > 0 ? '+' : '−'}${Math.abs(diff)} after)`}</em>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="hist-foot">Kept: everything from the last day, then one an hour for a week, one a day for a month, and one a week after that.</p>
        </aside>
        <section className="hist-main">
          {shown ? (
            <>
              <div className="hist-bar">
                {phone && (
                  <button className="btn ghost sm" onClick={() => setPick(null)}>
                    ‹ Versions
                  </button>
                )}
                <span className="hist-when">{when(shown.data.at)}</span>
                <button className="btn sec sm" onClick={() => void copy(shown.data)}>
                  <Copy size={14} /> Copy text
                </button>
                <button className="btn sm" onClick={() => onRestore(shown.data)}>
                  <RotateCcw size={14} /> Restore
                </button>
              </div>
              <Preview key={shown.id} v={shown.data} />
            </>
          ) : (
            !phone && <p className="hist-empty center">Pick a version to see it.</p>
          )}
        </section>
      </div>
    </div>
  )
}
