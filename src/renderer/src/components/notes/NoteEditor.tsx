import { onAndroid } from '../../lib/phone'
import { preview } from './listing'
import { useContext, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  Archive, ArchiveRestore, Bold, Code, Copy, Download, FileUp, Hash, Italic, Link2, Maximize2, Minimize2, MoreHorizontal, Palette, Pin, PinOff,
  Sparkles, Strikethrough, Trash2, Underline
} from 'lucide-react'
import type { Note, NoteFont, NoteTemplate, Rec } from '@shared/types'
import { db, useRecords } from '../../data/store'
import { useToast } from '../ui'
import { docText, noteExtensions, wordCount } from './extensions'
import { onAttachError } from './attachment'
import { onVoiceMessage } from '../../data/voice'
import { RecorderBar } from './Voice'
import { cleanError, saveNoteToDocs } from '../../data/drive'
import { SlashMenu } from './SlashMenu'
import { NoteToolbar } from './Toolbar'
import { LinkInput } from './LinkInput'
import { NoteAiCtx } from './aiContext'
import { AiPanel } from './AiPanel'
import { parseBullets, parseCards, type AiTask } from '../../data/ai'
import { noteToMarkdown } from './markdown'
import { useSettings } from '../../data/settings'
import { trashNotes } from '../../lib/notes'

export const NOTE_COVERS: Record<string, string> = {
  clay: 'linear-gradient(120deg,#e9b9a4,#d9825f 55%,#b3492b)',
  sage: 'linear-gradient(120deg,#cfe0c9,#8fb08a 60%,#3f6b4a)',
  sky: 'linear-gradient(120deg,#cfe0ee,#86aed0 60%,#2f5f8a)',
  dusk: 'linear-gradient(120deg,#ddd0ea,#a98bc6 60%,#5c3f80)',
  honey: 'linear-gradient(120deg,#f4e3b5,#e2b55a 60%,#a86f1d)',
  sand: 'linear-gradient(120deg,#f1ece2,#ddd2bf 60%,#b8a98e)',
  ink: 'linear-gradient(120deg,#5b5a55,#2f2e2b 60%,#1b1a18)'
}

export const NOTE_ICONS = ['📝', '📘', '📗', '📕', '📙', '🧪', '🧬', '🔬', '🧮', '📐', '📊', '💻', '🌍', '🏛️', '⚖️', '🎨', '🎵', '🗣️', '🧠', '💡', '⭐', '🎯', '📌', '🗂️', '✏️', '🔖', '🧭', '🌱', '⚛️', '🩺', '💰', '📜']

const HIGHLIGHTS = [
  ['yellow', 'var(--hl-yellow)'],
  ['green', 'var(--hl-green)'],
  ['blue', 'var(--hl-blue)'],
  ['pink', 'var(--hl-pink)'],
  ['purple', 'var(--hl-purple)']
]

const TEMPLATES: [NoteTemplate, string, string][] = [
  ['page', 'Page', 'Clean document'],
  ['cornell', 'Cornell', 'Cues · notes · summary'],
  ['lined', 'Lined', 'Ruled paper'],
  ['grid', 'Grid', 'Graph paper']
]

/* ---------- floating format bar ---------- */
function FormatBar({ editor }: { editor: Editor }) {
  const [colors, setColors] = useState(false)
  const [linking, setLinking] = useState(false)
  const ask = useContext(NoteAiCtx)
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      highlight: e.isActive('highlight'),
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p'
    })
  })
  const c = () => editor.chain().focus()
  const btn = (label: string, active: boolean, onClick: () => void, child: React.ReactNode) => (
    <button type="button" className="fb-btn" aria-label={label} title={label} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {child}
    </button>
  )
  return (
    <BubbleMenu
      editor={editor}
      className="format-bar"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: e, state }) => linking || (!state.selection.empty && e.isEditable && !e.isActive('codeBlock') && !e.isActive('drawing') && !e.isActive('attachment'))}
    >
      {linking ? (
        <LinkInput editor={editor} onDone={() => setLinking(false)} />
      ) : (
        <>
      <select
        className="fb-select"
        aria-label="Text style"
        value={s.block}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') c().setParagraph().run()
          else c().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
        }}
      >
        <option value="p">Text</option>
        <option value="h1">Heading</option>
        <option value="h2">Subheading</option>
        <option value="h3">Small heading</option>
      </select>
      <span className="fb-sep" />
      {btn('Bold', s.bold, () => c().toggleBold().run(), <Bold size={15} />)}
      {btn('Italic', s.italic, () => c().toggleItalic().run(), <Italic size={15} />)}
      {btn('Underline', s.underline, () => c().toggleUnderline().run(), <Underline size={15} />)}
      {btn('Strikethrough', s.strike, () => c().toggleStrike().run(), <Strikethrough size={15} />)}
      {btn('Code', s.code, () => c().toggleCode().run(), <Code size={15} />)}
      {btn('Link', s.link, () => setLinking(true), <Link2 size={15} />)}
      {ask && btn('Explain with AI', false, () => ask('explain', editor), <Sparkles size={15} />)}
      <span className="fb-sep" />
      <span className="fb-colors-wrap">
        {btn('Highlight', s.highlight, () => setColors((v) => !v), <Palette size={15} />)}
        {colors && (
          <span className="fb-colors">
            {HIGHLIGHTS.map(([name, color]) => (
              <button
                key={name}
                type="button"
                className="fb-swatch"
                aria-label={`Highlight ${name}`}
                style={{ background: color }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  c().toggleHighlight({ color }).run()
                  setColors(false)
                }}
              />
            ))}
            <button type="button" className="fb-swatch none" aria-label="Remove highlight" onMouseDown={(e) => e.preventDefault()} onClick={() => { c().unsetHighlight().run(); setColors(false) }}>
              ⌀
            </button>
          </span>
        )}
      </span>
        </>
      )}
    </BubbleMenu>
  )
}


/* ---------- one rich-text area ---------- */
export function Area({
  content,
  placeholder,
  slash = true,
  attach = true,
  className,
  onChange,
  onActive,
  onReady
}: {
  content: unknown
  placeholder: string
  slash?: boolean
  /** Off in shared group notes: attached files would only be on your computer. */
  attach?: boolean
  className?: string
  onChange: (json: unknown, text: string) => void
  /** Tells the page which area you're writing in, for the top toolbar. */
  onActive?: (editor: Editor) => void
  onReady?: (editor: Editor) => void
}) {
  const { s } = useSettings()
  const useSlash = slash && s.noteToolbar !== 'bar'
  const editor = useEditor(
    {
      extensions: noteExtensions(useSlash ? `${placeholder} Type / for blocks.` : placeholder, useSlash, attach),
      content: (content as object) ?? '',
      editorProps: { attributes: { class: `tiptap ${className ?? ''}`, spellcheck: s.spellcheck ? 'true' : 'false' } },
      onUpdate: ({ editor: e }) => onChange(e.getJSON(), e.getText()),
      onFocus: ({ editor: e }) => onActive?.(e),
      onCreate: ({ editor: e }) => onReady?.(e)
    },
    [useSlash, s.spellcheck, attach]
  )
  if (!editor) return null
  return (
    <>
      {s.noteBubble && <FormatBar editor={editor} />}
      <EditorContent
        editor={editor}
        onClick={(e) => {
          // Ctrl+click (or Cmd+click) opens a link in the browser.
          const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
          if (a && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            window.veyra.open(a.href)
          }
        }}
      />
    </>
  )
}

/* ---------- page options popover ---------- */
function PageMenu({
  data,
  set,
  onDelete,
  onDuplicate,
  onExport,
  onSaveDocs,
  onClose
}: {
  data: Note
  set: (p: Partial<Note>) => void
  onDelete: () => void
  onDuplicate: () => void
  onExport: () => void
  onSaveDocs: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { s, set: setSetting } = useSettings()
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
  const template = data.template ?? 'page'
  const font = data.font ?? 'sans'
  return (
    <div className="popover page-menu" ref={ref} role="dialog" aria-label="Page options">
      <h2>Layout</h2>
      <div className="tpl-picker">
        {TEMPLATES.map(([t, label, hint]) => (
          <button key={t} className={`tpl tpl-${t}`} aria-pressed={template === t} onClick={() => set({ template: t })}>
            <span className="tpl-art" aria-hidden="true" />
            <b>{label}</b>
            <span>{hint}</span>
          </button>
        ))}
      </div>
      <h2>Font</h2>
      <div className="seg" style={{ display: 'flex' }}>
        {(['sans', 'serif', 'mono'] as NoteFont[]).map((f) => (
          <button key={f} aria-selected={font === f} onClick={() => set({ font: f })} className={`font-${f}`} style={{ flex: 1 }}>
            {f === 'sans' ? 'Default' : f === 'serif' ? 'Serif' : 'Mono'}
          </button>
        ))}
      </div>
      <h2>Cover</h2>
      <div className="cover-row">
        <button className="cover-chip none" aria-pressed={!data.cover} onClick={() => set({ cover: null })} aria-label="No cover">
          ⌀
        </button>
        {Object.entries(NOTE_COVERS).map(([k, bg]) => (
          <button key={k} className="cover-chip" aria-pressed={data.cover === k} aria-label={`${k} cover`} style={{ background: bg }} onClick={() => set({ cover: k })} />
        ))}
      </div>
      <h2>Formatting tools</h2>
      <div className="seg" style={{ display: 'flex' }} title="Applies to all notes">
        {(
          [
            ['slash', 'Type “/”'],
            ['bar', 'Toolbar'],
            ['both', 'Both']
          ] as const
        ).map(([v, l]) => (
          <button key={v} aria-selected={s.noteToolbar === v} onClick={() => setSetting({ noteToolbar: v })} style={{ flex: 1 }}>
            {l}
          </button>
        ))}
      </div>
      <div className="menu-sep" />
      <button className="menu-row" onClick={() => set({ pinned: !data.pinned })}>
        {data.pinned ? <PinOff size={15} /> : <Pin size={15} />} {data.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      <button className="menu-row" onClick={onDuplicate}>
        <Copy size={15} /> Duplicate
      </button>
      <button className="menu-row" onClick={onExport}>
        <Download size={15} /> Export as Markdown
      </button>
      {!onAndroid() && (
        <button className="menu-row" onClick={onSaveDocs}>
          <FileUp size={15} /> Save to Google Docs
        </button>
      )}
      <button className="menu-row" onClick={() => set({ archived: !data.archived })}>
        {data.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {data.archived ? 'Unarchive' : 'Archive'}
      </button>
      <button className="menu-row danger" onClick={onDelete}>
        <Trash2 size={15} /> Move to trash
      </button>
    </div>
  )
}

function IconPicker({ value, onPick, onClose }: { value?: string; onPick: (v: string | undefined) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && onClose()
    setTimeout(() => document.addEventListener('mousedown', away))
    return () => document.removeEventListener('mousedown', away)
  }, [onClose])
  return (
    <div className="popover icon-picker" ref={ref} role="dialog" aria-label="Choose an icon">
      <div className="icon-grid">
        {NOTE_ICONS.map((i) => (
          <button key={i} aria-pressed={value === i} onClick={() => onPick(i)}>
            {i}
          </button>
        ))}
      </div>
      {value && (
        <button className="menu-row" onClick={() => onPick(undefined)}>
          Remove icon
        </button>
      )}
    </div>
  )
}

/* ---------- tags ---------- */
function Tags({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 30)
    if (t && !tags.includes(t)) onChange([...tags, t])
    setText('')
    setAdding(false)
  }
  return (
    <span className="tags">
      {tags.map((t) => (
        <span key={t} className="tag">
          #{t}
          <button aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="tag-input"
          autoFocus
          value={text}
          placeholder="tag"
          aria-label="New tag"
          onChange={(e) => setText(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
            if (e.key === 'Escape') {
              setText('')
              setAdding(false)
            }
          }}
        />
      ) : (
        <button className="tag add" onClick={() => setAdding(true)}>
          <Hash size={11} /> Tag
        </button>
      )}
    </span>
  )
}

/* ---------- the note page ---------- */
export function duplicateNote(n: Note): Promise<Rec<'note'>> {
  return db.put('note', { ...n, title: `${n.title || 'Untitled'} (copy)`, pinned: false, archived: false, trashedAt: null })
}

export async function exportNotes(notes: Note[]): Promise<number> {
  const r = await window.veyra.app.exportNotes(notes.map((n) => ({ name: n.title || 'Untitled', text: noteToMarkdown(n) })))
  return r.saved
}

/** Edits one note; saves shortly after you stop typing. Remount per note (key={note.id}). */
export function NoteEditor({
  note,
  onDeleted,
  onOpen,
  focusMode,
  onToggleFocus
}: {
  note: Rec<'note'>
  onDeleted: () => void
  onOpen?: (id: string) => void
  focusMode?: boolean
  onToggleFocus?: () => void
}) {
  const toast = useToast()
  useEffect(() => onAttachError(toast), [toast])
  useEffect(() => onVoiceMessage(toast), [toast])
  const { items: subjects } = useRecords('subject')
  // One copy of the note that every field writes into, saved as a whole.
  const latest = useRef<Note>(note.data)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const texts = useRef({ content: docText(note.data.content), cues: docText(note.data.cues), summary: docText(note.data.summary) })
  const [data, setData] = useState<Note>(note.data)
  const [words, setWords] = useState(() => wordCount(Object.values(texts.current).join(' ')))
  const [menu, setMenu] = useState<'page' | 'icon' | null>(null)
  const [savedAt, setSavedAt] = useState(note.updatedAt)
  const [active, setActive] = useState<Editor | null>(null)
  const mainEditor = useRef<Editor | null>(null)
  const [aiJob, setAiJob] = useState<{ task: AiTask; source: string; editor?: Editor; from?: number; to?: number } | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const { s: settings } = useSettings()

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    db.put('note', latest.current, note.id).then((r) => setSavedAt(r.updatedAt))
  }
  const update = (patch: Partial<Note>, now = false) => {
    latest.current = { ...latest.current, ...patch }
    setData(latest.current)
    if (timer.current) clearTimeout(timer.current)
    if (now) flush()
    else timer.current = setTimeout(flush, 500)
  }
  useEffect(() => () => void (timer.current && flush()), []) // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the window doesn't unmount React, so save anything pending right now.
  useEffect(() => {
    const onUnload = () => {
      if (!timer.current) return
      clearTimeout(timer.current)
      timer.current = null
      window.veyra.saveNow('note', latest.current, note.id)
    }
    // On the phone the app is put away, not closed: save as soon as it's hidden.
    const onHide = () => {
      if (document.visibilityState === 'hidden' && timer.current) flush()
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [note.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const onArea = (field: 'content' | 'cues' | 'summary') => (json: unknown, text: string) => {
    texts.current[field] = text
    const all = [texts.current.content, texts.current.cues, texts.current.summary].filter(Boolean).join(' · ')
    setWords(wordCount(all.replace(/·/g, ' ')))
    update({ [field]: json, excerpt: preview(latest.current.title, all).slice(0, 240) })
  }
  // The main area is the toolbar's target until you click into another one.
  const mainActive = (e: Editor) => {
    mainEditor.current = e
    setActive((cur) => cur ?? e)
  }

  /* ---------- AI study tools ---------- */
  const askAi = (task: AiTask, ed?: Editor) => {
    if (ed && (task === 'explain' || task === 'simplify')) {
      const { from, to } = ed.state.selection
      setAiJob({ task, source: ed.state.doc.textBetween(from, to, '\n'), editor: ed, from, to })
    } else {
      flush()
      setAiJob({ task, source: noteToMarkdown(latest.current).split('\n').slice(1).join('\n') })
    }
  }
  const P = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })
  const insertAi = (task: AiTask, text: string) => {
    const job = aiJob
    const ed = job?.editor ?? mainEditor.current
    if (!ed || ed.isDestroyed) return
    const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean).map(P)
    if (task === 'summary') {
      ed.chain().focus().insertContentAt(0, {
        type: 'callout',
        attrs: { tone: 'idea' },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Summary', marks: [{ type: 'bold' }] }] },
          { type: 'bulletList', content: parseBullets(text).map((b) => ({ type: 'listItem', content: [P(b)] })) }
        ]
      }).run()
    } else if (task === 'flashcards' || task === 'quiz') {
      const cards = parseCards(text)
      ed.chain().focus('end').insertContent([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: task === 'quiz' ? 'Quiz yourself' : 'Flashcards' }] },
        ...cards.map((c) => ({
          type: 'details',
          attrs: { open: false },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: c.q }] },
            { type: 'detailsContent', content: [P(c.a)] }
          ]
        }))
      ]).run()
    } else if (task === 'simplify' && job?.from !== undefined && job.to !== undefined) {
      ed.chain().focus().insertContentAt({ from: job.from, to: job.to }, paras).run()
    } else {
      // An explanation goes in a callout just below the block you selected.
      const at = job?.to !== undefined ? ed.state.doc.resolve(Math.min(job.to, ed.state.doc.content.size)).after(1) : ed.state.doc.content.size
      ed.chain().focus().insertContentAt(at, { type: 'callout', attrs: { tone: 'definition' }, content: paras.length ? paras : [P(text)] }).run()
    }
    setAiJob(null)
    toast('Added to your note')
  }

  // Grow the title box with its text.
  useEffect(() => {
    const t = titleRef.current
    if (!t) return
    t.style.height = '0'
    t.style.height = `${t.scrollHeight}px`
  }, [data.title])

  const remove = async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const undo = await trashNotes([{ ...note, data: latest.current }])
    toast('Moved to the trash', { label: 'Undo', run: undo })
    onDeleted()
  }
  const duplicate = async () => {
    flush()
    const copy = await duplicateNote(latest.current)
    setMenu(null)
    toast('Note duplicated')
    onOpen?.(copy.id)
  }
  const exportMd = async () => {
    setMenu(null)
    if (await exportNotes([latest.current])) toast('Note exported')
  }
  const saveDocs = async () => {
    setMenu(null)
    const drive = await window.veyra.drive.state()
    if (!drive.connected) return toast('Connect Google Drive first, in Settings → Connections.')
    toast('Saving to Google Docs…')
    try {
      const url = await saveNoteToDocs(note.id, latest.current)
      toast('Saved to Google Docs', { label: 'Open', run: () => window.veyra.open(url) })
    } catch (e) {
      toast(cleanError(e, 'Couldn’t save it to Google Docs.'))
    }
  }

  const template = data.template ?? 'page'
  const subject = subjects.find((s) => s.id === data.subjectId)
  const showBar = settings.noteToolbar !== 'slash'

  return (
    <NoteAiCtx.Provider value={onAndroid() ? null : askAi}>
    <div
      className={`note-page font-${data.font ?? 'sans'} layout-${template} width-${settings.noteWidth} ${aiJob ? 'with-ai' : ''}`}
      style={{ ['--note-base' as string]: `${settings.noteSize}px` }}
    >
      {showBar && <NoteToolbar editor={active} />}
      <div className="note-scroll">
        {data.archived && (
          <div className="note-banner">
            <Archive size={14} /> This note is archived, so it’s hidden from your notes list.
            <button className="linkbtn" onClick={() => update({ archived: false }, true)}>
              Unarchive
            </button>
          </div>
        )}
        {data.cover && NOTE_COVERS[data.cover] && <div className="note-cover" style={{ background: NOTE_COVERS[data.cover] }} />}
        <div className={`note-sheet ${data.cover ? 'has-cover' : ''}`}>
          <div className="note-actions">
            {!data.icon && (
              <button className="ghost-chip" onClick={() => setMenu('icon')}>
                ☺ Add icon
              </button>
            )}
            {!data.cover && (
              <button className="ghost-chip" onClick={() => update({ cover: 'sand' }, true)}>
                ▭ Add cover
              </button>
            )}
            <span className="grow" />
            <span className="save-state xs tert" aria-live="polite">
              Edited {formatDistanceToNowStrict(savedAt, { addSuffix: true })}
            </span>
            {onToggleFocus && (
              <button className="iconbtn plain" aria-label={focusMode ? 'Leave focus mode' : 'Focus mode'} title={focusMode ? 'Leave focus mode (Esc)' : 'Focus mode: hide everything but the page'} onClick={onToggleFocus}>
                {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            )}
            <span className="anchor">
              <button className="iconbtn plain" aria-label="Page options" aria-expanded={menu === 'page'} onClick={() => setMenu(menu === 'page' ? null : 'page')}>
                <MoreHorizontal size={18} />
              </button>
              {menu === 'page' && (
                <PageMenu data={data} set={(p) => update(p, true)} onDelete={remove} onDuplicate={duplicate} onExport={exportMd} onSaveDocs={saveDocs} onClose={() => setMenu(null)} />
              )}
            </span>
          </div>

          {data.icon && (
            <span className="anchor">
              <button className="note-icon" aria-label="Change icon" onClick={() => setMenu('icon')}>
                {data.icon}
              </button>
            </span>
          )}
          {menu === 'icon' && (
            <span className="anchor">
              <IconPicker
                value={data.icon}
                onPick={(icon) => {
                  update({ icon }, true)
                  setMenu(null)
                }}
                onClose={() => setMenu(null)}
              />
            </span>
          )}

          <textarea
            ref={titleRef}
            className="note-title"
            rows={1}
            value={data.title}
            placeholder="Untitled"
            aria-label="Note title"
            onChange={(e) => update({ title: e.target.value.replace(/\n/g, '') })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(document.querySelector('.note-main .tiptap') as HTMLElement | null)?.focus()
              }
            }}
          />

          <div className="note-meta">
            <label className="subject-chip" style={subject ? { ['--chip' as string]: subject.data.color } : undefined}>
              <span className="dot" />
              <select value={data.subjectId ?? ''} onChange={(e) => update({ subjectId: e.target.value || null }, true)} aria-label="Subject">
                <option value="">No subject</option>
                {subjects
                  .filter((s) => !s.data.archived || s.id === data.subjectId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.data.name}
                    </option>
                  ))}
              </select>
            </label>
            <Tags tags={data.tags ?? []} onChange={(tags) => update({ tags }, true)} />
            {settings.showWordCount && (
              <>
                <span className="tert">·</span>
                <span className="tert num">
                  {words} {words === 1 ? 'word' : 'words'}
                </span>
                {words > 0 && (
                  <>
                    <span className="tert">·</span>
                    <span className="tert">{Math.max(1, Math.round(words / 200))} min read</span>
                  </>
                )}
              </>
            )}
          </div>

          {template === 'cornell' ? (
            <div className="cornell">
              <div className="cornell-cues">
                <div className="cornell-label">Cues &amp; questions</div>
                <Area content={data.cues} placeholder="Key words, questions…" slash={false} className="cues" onChange={onArea('cues')} onActive={setActive} />
              </div>
              <div className="cornell-notes note-main">
                <div className="cornell-label">Notes</div>
                <Area content={data.content} placeholder="Take notes during the lecture." onChange={onArea('content')} onActive={setActive} onReady={mainActive} />
              </div>
              <div className="cornell-summary">
                <div className="cornell-label">Summary</div>
                <Area content={data.summary} placeholder="Sum up the page in a few sentences, in your own words." slash={false} onChange={onArea('summary')} onActive={setActive} />
              </div>
            </div>
          ) : (
            <div className="note-main">
              <Area content={data.content} placeholder="Start writing." onChange={onArea('content')} onActive={setActive} onReady={mainActive} />
            </div>
          )}
        </div>
      </div>
      <SlashMenu />
      <RecorderBar />
      {aiJob && <AiPanel key={aiJob.task + aiJob.source.length} task={aiJob.task} source={aiJob.source} title={data.title} onInsert={insertAi} onClose={() => setAiJob(null)} />}
    </div>
    </NoteAiCtx.Provider>
  )
}
