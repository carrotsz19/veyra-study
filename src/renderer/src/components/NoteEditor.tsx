import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import Highlight from '@tiptap/extension-highlight'
import {
  Bold, Code, Heading1, Heading2, Highlighter, Italic, List, ListChecks, ListOrdered,
  Minus, Quote, Redo2, Strikethrough, Trash2, Underline, Undo2, type LucideIcon
} from 'lucide-react'
import type { Rec } from '@shared/types'
import { db } from '../data/store'
import { SubjectSelect } from './editors'
import { useToast } from './ui'

function Tool({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="iconbtn" title={label} aria-label={label} aria-pressed={!!active} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon size={16} />
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      highlight: e.isActive('highlight'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote')
    })
  })
  const c = () => editor.chain().focus()
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Tool icon={Heading1} label="Heading" active={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()} />
      <Tool icon={Heading2} label="Subheading" active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()} />
      <span className="sep" />
      <Tool icon={Bold} label="Bold (Ctrl+B)" active={s.bold} onClick={() => c().toggleBold().run()} />
      <Tool icon={Italic} label="Italic (Ctrl+I)" active={s.italic} onClick={() => c().toggleItalic().run()} />
      <Tool icon={Underline} label="Underline (Ctrl+U)" active={s.underline} onClick={() => c().toggleUnderline().run()} />
      <Tool icon={Strikethrough} label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()} />
      <Tool icon={Highlighter} label="Highlight" active={s.highlight} onClick={() => c().toggleHighlight().run()} />
      <Tool icon={Code} label="Code" active={s.code} onClick={() => c().toggleCode().run()} />
      <span className="sep" />
      <Tool icon={List} label="Bullet list" active={s.bullet} onClick={() => c().toggleBulletList().run()} />
      <Tool icon={ListOrdered} label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()} />
      <Tool icon={ListChecks} label="Checklist" active={s.task} onClick={() => c().toggleTaskList().run()} />
      <Tool icon={Quote} label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()} />
      <Tool icon={Minus} label="Divider" onClick={() => c().setHorizontalRule().run()} />
      <span className="sep" />
      <Tool icon={Undo2} label="Undo (Ctrl+Z)" onClick={() => c().undo().run()} />
      <Tool icon={Redo2} label="Redo (Ctrl+Y)" onClick={() => c().redo().run()} />
    </div>
  )
}

/** Edits one note; saves itself shortly after you stop typing. Remount per note (key={note.id}). */
export function NoteEditor({ note, onDeleted }: { note: Rec<'note'>; onDeleted: () => void }) {
  const toast = useToast()
  const latest = useRef(note.data)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [title, setTitle] = useState(note.data.title)
  const [subjectId, setSubjectId] = useState(note.data.subjectId)

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    db.put('note', latest.current, note.id)
  }
  const schedule = (patch: Partial<Rec<'note'>['data']>) => {
    latest.current = { ...latest.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }
  // Save anything pending when switching notes or leaving the screen.
  useEffect(() => () => void (timer.current && flush()), []) // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useEditor({
    extensions: [
      StarterKit,
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start writing…' })
    ],
    content: (note.data.content as object) ?? '',
    onUpdate: ({ editor: e }) => schedule({ content: e.getJSON(), excerpt: e.getText().slice(0, 200) })
  })

  const remove = async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const data = latest.current
    await db.remove('note', note.id)
    toast('Note deleted', { label: 'Undo', run: () => db.put('note', data, note.id) })
    onDeleted()
  }

  return (
    <div className="card editor-card">
      <div className="editor-head">
        <div className="between">
          <input
            className="title-input"
            value={title}
            placeholder="Untitled"
            aria-label="Note title"
            onChange={(e) => {
              setTitle(e.target.value)
              schedule({ title: e.target.value })
            }}
          />
          <button className="iconbtn plain" title="Delete note" aria-label="Delete note" onClick={remove}>
            <Trash2 size={16} />
          </button>
        </div>
        <div style={{ maxWidth: 220, marginTop: 8 }}>
          <SubjectSelect
            value={subjectId}
            onChange={(id) => {
              setSubjectId(id)
              schedule({ subjectId: id })
            }}
          />
        </div>
      </div>
      {editor && <Toolbar editor={editor} />}
      <div className="editor-body" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
