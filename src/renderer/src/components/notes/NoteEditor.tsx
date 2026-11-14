import { onAndroid } from '../../lib/phone'
import { preview } from './listing'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  Archive, ArchiveRestore, Bold, Code, Copy, Download, FileUp, Hash, History as HistoryIcon, ImagePlus, Italic, Share2, Link2, Maximize2, Minimize2, MoreHorizontal, Palette, Pin, PinOff,
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
import { registerOpenNote, trashNotes } from '../../lib/notes'
import { Select } from '../Select'
import { Spelling } from './spelling'
import { fileSrc } from './attachment'
import { ShareDialog } from './Share'
import { noteSaved, onSharesChanged, promoteFiles, sharesOf } from '../../lib/share'
import { openLive, releaseLive, type LiveDoc } from '../../lib/live'
import { groupCall } from '../../data/groups'
import { useAccount } from '../account'
import { NoteHistory } from './History'
import { beforeSave, keepVersion } from '../../lib/history'
import type { NoteVersion } from '@shared/types'

export { NOTE_COVERS } from './covers'
import { NOTE_COVERS } from './covers'

/* ---------- your own cover picture ---------- */
export const isImageCover = (c?: string | null): c is string => !!c && c.startsWith('img:')

/** Asks for a picture and keeps it like an attachment; returns the cover value (or null if none was picked). */
export function pickCover(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.oncancel = () => resolve(null)
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      if (f.size > 15 * 1024 * 1024) return reject(new Error('That picture is over 15 MB. Pick a smaller one.'))
      try {
        const a = await window.veyra.files.fromBytes(f.name, f.type || 'image/jpeg', new Uint8Array(await f.arrayBuffer()))
        resolve(`img:${a.id}`)
      } catch (e) {
        reject(e)
      }
    }
    input.click()
  })
}

/** The picture itself. Pictures stay on the device they were added on; elsewhere a soft gradient stands in. */
function CoverPicture({ cover }: { cover: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let live = true
    setGone(false)
    fileSrc(cover.slice(4), '').then(
      (u) => live && setSrc(u),
      () => live && setGone(true)
    )
    return () => {
      live = false
    }
  }, [cover])
  if (gone) return <span className="cover-fallback" style={{ background: NOTE_COVERS.sand }} title="This picture is on another device" />
  return src ? <img src={src} alt="" draggable={false} onError={() => setGone(true)} /> : null
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
      <Select
        className="quiet fb-sel"
        label="Text style"
        keepFocus
        value={s.block}
        onChange={(v) => {
          if (v === 'p') c().setParagraph().run()
          else c().setHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
        }}
        options={[
          { value: 'p', label: 'Text' },
          { value: 'h1', label: 'Heading', style: { fontSize: 18, fontWeight: 800 } },
          { value: 'h2', label: 'Subheading', style: { fontSize: 15.5, fontWeight: 750 } },
          { value: 'h3', label: 'Small heading', style: { fontSize: 14, fontWeight: 700 } }
        ]}
      />
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
  onReady,
  live
}: {
  content: unknown
  placeholder: string
  /** A shared note: this area is edited together (the live document holds the text; `seed` fills it the first time). */
  live?: { doc: LiveDoc; field: string; seed?: unknown }
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
  // Computer: Veyra's own spell check (underlines and right-click fixes). Phone: the keyboard's.
  const ownSpelling = s.spellcheck && !onAndroid()
  // A shared note waits for its live document (instant when this device already has a copy).
  const [liveReady, setLiveReady] = useState(!live)
  useEffect(() => {
    if (!live) return setLiveReady(true)
    let on = true
    setLiveReady(false)
    void live.doc.ready.then(() => on && setLiveReady(true))
    return () => {
      on = false
    }
  }, [live?.doc]) // eslint-disable-line react-hooks/exhaustive-deps
  const collab = live && liveReady ? { doc: live.doc.doc, field: live.field } : undefined
  const editor = useEditor(
    {
      extensions: [...noteExtensions(useSlash ? `${placeholder} Type / for blocks.` : placeholder, useSlash, attach, collab), ...(ownSpelling ? [Spelling] : [])],
      content: collab ? undefined : ((content as object) ?? ''),
      editorProps: { attributes: { class: `tiptap ${className ?? ''}`, spellcheck: s.spellcheck && !ownSpelling ? 'true' : 'false' } },
      onUpdate: ({ editor: e }) => onChange(e.getJSON(), e.getText()),
      onFocus: ({ editor: e }) => onActive?.(e),
      onCreate: ({ editor: e }) => {
        // The first time a note is shared, its text goes into the live document (only once, from the owner).
        if (collab && live?.seed && live.doc.can !== 'view' && live.doc.isEmpty(live.field)) e.commands.setContent(live.seed as object)
        onReady?.(e)
      }
    },
    [useSlash, s.spellcheck, attach, collab?.doc]
  )
  // New pictures and files in a shared note go to the server, so everyone sees them.
  useEffect(() => {
    if (!editor || !collab) return
    const run = () => void promoteFiles(editor)
    editor.on('update', run)
    return () => void editor.off('update', run)
  }, [editor, collab?.doc]) // eslint-disable-line react-hooks/exhaustive-deps
  if (live && !liveReady) return <p className="live-wait">Loading the shared note… (the first time on this device it needs the Veyra server, which sleeps from about 12 am to 8 am)</p>
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
  onHistory,
  onShare,
  onClose
}: {
  data: Note
  set: (p: Partial<Note>) => void
  onDelete: () => void
  onDuplicate: () => void
  onHistory: () => void
  /** Share… (only when signed in to a Veyra account). */
  onShare?: () => void
  onExport: () => void
  onSaveDocs: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { s, set: setSetting } = useSettings()
  // As tall as the space below it (it scrolls inside), so nothing ends up off the bottom of the window.
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current
      if (el) el.style.maxHeight = `${Math.max(220, window.innerHeight - el.getBoundingClientRect().top - 12)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
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
      {/* What you do most comes first; how the page looks is below. */}
      <button className="menu-row" onClick={() => set({ pinned: !data.pinned })}>
        {data.pinned ? <PinOff size={15} /> : <Pin size={15} />} {data.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      {onShare && (
        <button className="menu-row" onClick={onShare}>
          <Share2 size={15} /> Share…
        </button>
      )}
      <button className="menu-row" onClick={onHistory}>
        <HistoryIcon size={15} /> Version history
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
      <div className="menu-sep" />
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
        {isImageCover(data.cover) && (
          <button className="cover-chip cover-chip-img" aria-pressed="true" aria-label="Your picture">
            <CoverPicture cover={data.cover} />
          </button>
        )}
        <button className="cover-chip cover-chip-up" aria-label="Use your own picture" title="Use your own picture" onClick={() => void pickCover().then((c) => c && set({ cover: c }), (e: unknown) => alert(e instanceof Error ? e.message : 'Couldn’t use that picture.'))}>
          <ImagePlus size={14} />
        </button>
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
  onToggleFocus,
  onReplaced
}: {
  note: Rec<'note'>
  onDeleted: () => void
  onOpen?: (id: string) => void
  focusMode?: boolean
  onToggleFocus?: () => void
  /** The note's text was replaced (a restored version): show it fresh. */
  onReplaced?: () => void
}) {
  const toast = useToast()
  useEffect(() => onAttachError(toast), [toast])
  useEffect(() => onVoiceMessage((m, long) => toast(m, long ? { label: 'OK', run: () => {} } : undefined)), [toast])
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

  // The note as last saved (and when): kept as a version before a new stretch of editing (lib/history.ts).
  const saved = useRef({ data: note.data, at: note.updatedAt })
  const [history, setHistory] = useState(false)
  const [sharing, setSharing] = useState(false)
  // Shared: the note is edited together (its text lives in a live document on the server too).
  const [docId, setDocId] = useState<string | null>(null)
  useEffect(() => {
    const read = () => void sharesOf(note.id).then((l) => setDocId(l[0]?.docId ?? null), () => {})
    read()
    return onSharesChanged(read)
  }, [note.id])
  const [liveDoc, setLiveDoc] = useState<LiveDoc | null>(null)
  useEffect(() => {
    if (!docId) return setLiveDoc(null)
    setLiveDoc(openLive(docId, '', groupCall))
    return () => releaseLive(docId)
  }, [docId])
  const liveArea = (field: 'content' | 'cues' | 'summary') => (liveDoc ? { doc: liveDoc, field, seed: latest.current[field] } : undefined)
  const signedIn = useAccount()?.state.mode === 'account'
  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const before = saved.current
    saved.current = { data: latest.current, at: Date.now() }
    void beforeSave(note.id, before.data, before.at, latest.current).catch(() => {})
    db.put('note', latest.current, note.id).then((r) => setSavedAt(r.updatedAt))
    noteSaved(note.id, latest.current)
  }
  const update = (patch: Partial<Note>, now = false) => {
    latest.current = { ...latest.current, ...patch }
    setData(latest.current)
    if (timer.current) clearTimeout(timer.current)
    if (now) flush()
    else timer.current = setTimeout(flush, 500)
  }
  useEffect(() => () => void (timer.current && flush()), []) // eslint-disable-line react-hooks/exhaustive-deps
  // Trashing this note from the list takes the newest copy from here, and any later save keeps it in the trash.
  useEffect(
    () =>
      registerOpenNote(note.id, (trashedAt) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = null
        latest.current = { ...latest.current, trashedAt }
        return latest.current
      }),
    [note.id]
  )
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
  // Brings a version back; what's there now is kept as a version first, so this can be undone the same way.
  const restore = async (v: NoteVersion) => {
    if (timer.current) flush()
    await keepVersion(note.id, latest.current, Date.now())
    const next: Note = { ...latest.current, title: v.title, content: v.content, cues: v.cues, summary: v.summary, ...(v.template ? { template: v.template } : {}) }
    latest.current = next
    saved.current = { data: next, at: Date.now() }
    setHistory(false)
    onReplaced?.()
    await db.put('note', next, note.id)
    toast('Version restored. The text before it is in Version history.')
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
        {isImageCover(data.cover) ? (
          <div className="note-cover note-cover-img">
            <CoverPicture cover={data.cover} />
          </div>
        ) : (
          data.cover && NOTE_COVERS[data.cover] && <div className="note-cover" style={{ background: NOTE_COVERS[data.cover] }} />
        )}
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
                <PageMenu data={data} set={(p) => update(p, true)} onDelete={remove} onDuplicate={duplicate} onExport={exportMd} onSaveDocs={saveDocs} onHistory={() => (setMenu(null), setHistory(true))} onShare={signedIn ? () => (setMenu(null), flush(), setSharing(true)) : undefined} onClose={() => setMenu(null)} />
              )}
              {sharing && (
                <ShareDialog noteId={note.id} note={() => latest.current} onClose={() => setSharing(false)} />
              )}
              {history && (
                <NoteHistory noteId={note.id} currentWords={words} onRestore={(v) => void restore(v)} onClose={() => setHistory(false)} />
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
            <span className="subject-chip" style={subject ? { ['--chip' as string]: subject.data.color } : undefined}>
              <span className="dot" />
              <Select
                className="quiet subject-sel"
                label="Subject"
                value={data.subjectId ?? ''}
                onChange={(v) => update({ subjectId: v || null }, true)}
                options={[
                  { value: '', label: 'No subject' },
                  ...subjects.filter((s) => !s.data.archived || s.id === data.subjectId).map((s) => ({ value: s.id, label: s.data.name, dot: s.data.color }))
                ]}
              />
            </span>
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
                <Area content={data.cues} placeholder="Key words, questions…" slash className="cues" onChange={onArea('cues')} onActive={setActive} live={liveArea('cues')} />
              </div>
              <div className="cornell-notes note-main">
                <div className="cornell-label">Notes</div>
                <Area content={data.content} placeholder="Take notes during the lecture." onChange={onArea('content')} onActive={setActive} onReady={mainActive} live={liveArea('content')} />
              </div>
              <div className="cornell-summary">
                <div className="cornell-label">Summary</div>
                <Area content={data.summary} placeholder="Sum up the page in a few sentences, in your own words." slash onChange={onArea('summary')} onActive={setActive} live={liveArea('summary')} />
              </div>
            </div>
          ) : (
            <div className="note-main">
              <Area content={data.content} placeholder="Start writing." onChange={onArea('content')} onActive={setActive} onReady={mainActive} live={liveArea('content')} />
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
