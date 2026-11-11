import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  Bold, Code, Italic, Link2, MoreHorizontal, Palette, Pin, PinOff, Strikethrough, Trash2, Underline
} from 'lucide-react'
import type { Note, NoteFont, NoteTemplate, Rec } from '@shared/types'
import { db, useRecords } from '../../data/store'
import { useToast } from '../ui'
import { docText, noteExtensions, wordCount } from './extensions'
import { SlashMenu } from './SlashMenu'
import { useSettings } from '../../data/settings'

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
      shouldShow={({ editor: e, state }) => !state.selection.empty && e.isEditable && !e.isActive('codeBlock')}
    >
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
      {btn('Link', s.link, () => {
        if (s.link) return c().unsetLink().run()
        const url = prompt('Link address')
        if (url) c().setLink({ href: /^https?:\/\//.test(url) ? url : `https://${url}` }).run()
      }, <Link2 size={15} />)}
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
    </BubbleMenu>
  )
}

/* ---------- one rich-text area ---------- */
function Area({
  content,
  placeholder,
  slash = true,
  className,
  onChange
}: {
  content: unknown
  placeholder: string
  slash?: boolean
  className?: string
  onChange: (json: unknown, text: string) => void
}) {
  const { s } = useSettings()
  const editor = useEditor({
    extensions: noteExtensions(placeholder, slash),
    content: (content as object) ?? '',
    editorProps: { attributes: { class: `tiptap ${className ?? ''}`, spellcheck: s.spellcheck ? 'true' : 'false' } },
    onUpdate: ({ editor: e }) => onChange(e.getJSON(), e.getText())
  })
  if (!editor) return null
  return (
    <>
      <FormatBar editor={editor} />
      <EditorContent editor={editor} />
    </>
  )
}

/* ---------- page options popover ---------- */
function PageMenu({ data, set, onDelete, onClose }: { data: Note; set: (p: Partial<Note>) => void; onDelete: () => void; onClose: () => void }) {
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
      <div className="menu-sep" />
      <button className="menu-row" onClick={() => set({ pinned: !data.pinned })}>
        {data.pinned ? <PinOff size={15} /> : <Pin size={15} />} {data.pinned ? 'Unpin' : 'Pin to top'}
      </button>
      <button className="menu-row danger" onClick={onDelete}>
        <Trash2 size={15} /> Delete note
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

/* ---------- the note page ---------- */
/** Edits one note; saves shortly after you stop typing. Remount per note (key={note.id}). */
export function NoteEditor({ note, onDeleted }: { note: Rec<'note'>; onDeleted: () => void }) {
  const toast = useToast()
  const { items: subjects } = useRecords('subject')
  // One copy of the note that every field writes into, saved as a whole.
  const latest = useRef<Note>(note.data)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const texts = useRef({ content: docText(note.data.content), cues: docText(note.data.cues), summary: docText(note.data.summary) })
  const [data, setData] = useState<Note>(note.data)
  const [words, setWords] = useState(() => wordCount(Object.values(texts.current).join(' ')))
  const [menu, setMenu] = useState<'page' | 'icon' | null>(null)
  const [savedAt, setSavedAt] = useState(note.updatedAt)
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

  const onArea = (field: 'content' | 'cues' | 'summary') => (json: unknown, text: string) => {
    texts.current[field] = text
    const all = [texts.current.content, texts.current.cues, texts.current.summary].filter(Boolean).join(' · ')
    setWords(wordCount(all.replace(/·/g, ' ')))
    update({ [field]: json, excerpt: all.replace(/\s+/g, ' ').slice(0, 240) })
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
    const snapshot = latest.current
    await db.remove('note', note.id)
    toast('Note deleted', { label: 'Undo', run: () => db.put('note', snapshot, note.id) })
    onDeleted()
  }

  const template = data.template ?? 'page'
  const subject = subjects.find((s) => s.id === data.subjectId)

  return (
    <div
      className={`note-page font-${data.font ?? 'sans'} layout-${template} width-${settings.noteWidth}`}
      style={{ ['--note-base' as string]: `${settings.noteSize}px` }}
    >
      <div className="note-scroll">
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
            <span className="anchor">
              <button className="iconbtn plain" aria-label="Page options" aria-expanded={menu === 'page'} onClick={() => setMenu(menu === 'page' ? null : 'page')}>
                <MoreHorizontal size={18} />
              </button>
              {menu === 'page' && <PageMenu data={data} set={(p) => update(p, true)} onDelete={remove} onClose={() => setMenu(null)} />}
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
                <Area content={data.cues} placeholder="Key words, questions…" slash={false} className="cues" onChange={onArea('cues')} />
              </div>
              <div className="cornell-notes note-main">
                <div className="cornell-label">Notes</div>
                <Area content={data.content} placeholder="Take notes during the lecture. Type / for blocks." onChange={onArea('content')} />
              </div>
              <div className="cornell-summary">
                <div className="cornell-label">Summary</div>
                <Area content={data.summary} placeholder="Sum up the page in a few sentences, in your own words." slash={false} onChange={onArea('summary')} />
              </div>
            </div>
          ) : (
            <div className="note-main">
              <Area content={data.content} placeholder="Start writing, or type / for headings, callouts, tables…" onChange={onArea('content')} />
            </div>
          )}
        </div>
      </div>
      <SlashMenu />
    </div>
  )
}
