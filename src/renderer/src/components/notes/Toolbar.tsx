import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  Bold, ChevronDown, Code, CodeSquare, Columns2, Highlighter, Italic, Link2, List, ListChecks, ListOrdered, ListCollapse, Mic, Minus, Paperclip, PenLine, Plus,
  Quote, Redo2, Rows2, Sparkles, Strikethrough, Table, Trash2, Underline, Undo2
} from 'lucide-react'
import { CALLOUTS, type CalloutTone } from './extensions'
import { attachFiles, canAttach } from './attachment'
import { startRecording } from '../../data/voice'
import { LinkInput } from './LinkInput'
import { useContext } from 'react'
import { NoteAiCtx } from './aiContext'
import { AI_LABELS, type AiTask } from '../../data/ai'

const HL = [
  ['Yellow', 'var(--hl-yellow)'],
  ['Green', 'var(--hl-green)'],
  ['Blue', 'var(--hl-blue)'],
  ['Pink', 'var(--hl-pink)'],
  ['Purple', 'var(--hl-purple)']
]

function Btn({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="tb-btn" title={label} aria-label={label} aria-pressed={!!active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )
}

/** A small dropdown that stays open until you pick something or click away. */
function Menu({ label, button, children }: { label: string; button: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<React.CSSProperties>({})
  const ref = useRef<HTMLSpanElement>(null)
  // The bar scrolls sideways, so the menu floats above the page instead of inside the bar.
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r && !open) {
      const bottomBar = r.top > window.innerHeight / 2 // the phone keeps its bar at the bottom
      setAt(
        bottomBar
          ? { position: 'fixed', left: 12, right: 12, bottom: window.innerHeight - r.top + 6, top: 'auto' }
          : { position: 'fixed', top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 260)) }
      )
    }
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  return (
    <span className="tb-menu" ref={ref}>
      <button type="button" className="tb-btn wide" title={label} aria-label={label} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        {button}
        <ChevronDown size={12} />
      </button>
      {open && <div className="tb-pop" role="menu" style={at}>{children(() => setOpen(false))}</div>}
    </span>
  )
}

/** The formatting bar at the top of a note. It works on whichever part of the page you're writing in. */
export function NoteToolbar({ editor }: { editor: Editor | null }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            link: e.isActive('link'),
            highlight: e.isActive('highlight'),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            task: e.isActive('taskList'),
            quote: e.isActive('blockquote'),
            codeBlock: e.isActive('codeBlock'),
            callout: e.isActive('callout') ? ((e.getAttributes('callout').tone as CalloutTone) ?? 'idea') : null,
            table: e.isActive('table'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo()
          }
        : null
  })
  const ask = useContext(NoteAiCtx)
  if (!editor || !s) return <div className="note-toolbar" aria-hidden="true" />
  const c = () => editor.chain().focus()

  return (
    <div className="note-toolbar" role="toolbar" aria-label="Formatting">
      <span className="tb-undo">
        <Btn label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()}>
          <Undo2 size={15} />
        </Btn>
        <Btn label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => c().redo().run()}>
          <Redo2 size={15} />
        </Btn>
        <span className="tb-sep" />
      </span>
      <select
        className="tb-select"
        aria-label="Text style"
        value={s.block}
        onMouseDown={(e) => e.stopPropagation()}
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
      <span className="tb-sep" />
      <Btn label="Bold (Ctrl+B)" active={s.bold} onClick={() => c().toggleBold().run()}>
        <Bold size={15} />
      </Btn>
      <Btn label="Italic (Ctrl+I)" active={s.italic} onClick={() => c().toggleItalic().run()}>
        <Italic size={15} />
      </Btn>
      <Btn label="Underline (Ctrl+U)" active={s.underline} onClick={() => c().toggleUnderline().run()}>
        <Underline size={15} />
      </Btn>
      <Btn label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()}>
        <Strikethrough size={15} />
      </Btn>
      <Btn label="Inline code" active={s.code} onClick={() => c().toggleCode().run()}>
        <Code size={15} />
      </Btn>
      <Menu label="Highlight" button={<Highlighter size={15} />}>
        {(close) => (
          <div className="tb-swatches">
            {HL.map(([name, color]) => (
              <button
                key={name}
                className="fb-swatch"
                title={name}
                aria-label={`Highlight ${name}`}
                style={{ background: color }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  c().toggleHighlight({ color }).run()
                  close()
                }}
              />
            ))}
            <button className="fb-swatch none" title="No highlight" aria-label="Remove highlight" onMouseDown={(e) => e.preventDefault()} onClick={() => { c().unsetHighlight().run(); close() }}>
              ⌀
            </button>
          </div>
        )}
      </Menu>
      <Menu label="Link (Ctrl+click a link to open it)" button={<Link2 size={15} />}>
        {(close) => <LinkInput editor={editor} onDone={close} />}
      </Menu>
      <span className="tb-sep" />
      <Btn label="Bullet list" active={s.bullet} onClick={() => c().toggleBulletList().run()}>
        <List size={15} />
      </Btn>
      <Btn label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()}>
        <ListOrdered size={15} />
      </Btn>
      <Btn label="Checklist" active={s.task} onClick={() => c().toggleTaskList().run()}>
        <ListChecks size={15} />
      </Btn>
      <Menu label="Callout" button={<span className="tb-emoji">{s.callout ? CALLOUTS[s.callout].emoji : '💡'}</span>}>
        {(close) => (
          <>
            {(Object.keys(CALLOUTS) as CalloutTone[]).map((tone) => (
              <button
                key={tone}
                className="tb-item"
                role="menuitemradio"
                aria-checked={s.callout === tone}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  c().setCallout(tone).run()
                  close()
                }}
              >
                <span>{CALLOUTS[tone].emoji}</span> {CALLOUTS[tone].label}
              </button>
            ))}
            {s.callout && (
              <button className="tb-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { c().unsetCallout().run(); close() }}>
                <span>⌀</span> Remove callout
              </button>
            )}
          </>
        )}
      </Menu>
      {s.table && (
      <Menu label="Table" button={<Table size={15} />}>
        {(close) => (
          <>
            {(
              [
                ['Add row below', () => c().addRowAfter().run(), <Rows2 size={14} key="r" />],
                ['Add column right', () => c().addColumnAfter().run(), <Columns2 size={14} key="c" />],
                ['Delete row', () => c().deleteRow().run(), <Rows2 size={14} key="dr" />],
                ['Delete column', () => c().deleteColumn().run(), <Columns2 size={14} key="dc" />],
                ['Toggle header row', () => c().toggleHeaderRow().run(), <Table size={14} key="h" />],
                ['Delete table', () => c().deleteTable().run(), <Trash2 size={14} key="dt" />]
              ] as [string, () => void, ReactNode][]
            ).map(([label, run, icon]) => (
              <button
                key={label}
                className="tb-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run()
                  close()
                }}
              >
                <span>{icon}</span> {label}
              </button>
            ))}
          </>
        )}
      </Menu>
      )}
      <Menu label="Insert a block" button={<><Plus size={15} /> <span className="tb-label">Insert</span></>}>
        {(close) => (
          <>
            {(
              [
                ['Question toggle', () => c().setDetails().run(), <ListCollapse size={14} key="d" />, false],
                ['Quote', () => c().toggleBlockquote().run(), <Quote size={14} key="q" />, s.quote],
                ['Code block', () => c().toggleCodeBlock().run(), <CodeSquare size={14} key="c" />, s.codeBlock],
                ['Divider', () => c().setHorizontalRule().run(), <Minus size={14} key="m" />, false],
                ['Table', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), <Table size={14} key="t" />, false],
                ['Drawing or handwriting', () => c().insertDrawing().run(), <PenLine size={14} key="p" />, false],
                ...(canAttach(editor)
                  ? ([
                      ['File or image', () => void attachFiles(editor), <Paperclip size={14} key="f" />, false],
                      ['Voice recording', () => void startRecording(editor), <Mic size={14} key="v" />, false]
                    ] as [string, () => void, ReactNode, boolean][])
                  : [])
              ] as [string, () => void, ReactNode, boolean][]
            ).map(([label, run, icon, on]) => (
              <button
                key={label}
                className="tb-item"
                role="menuitemcheckbox"
                aria-checked={on}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run()
                  close()
                }}
              >
                <span>{icon}</span> {label}
              </button>
            ))}
          </>
        )}
      </Menu>
      {ask && (
        <>
          <span className="tb-sep" />
          <Menu label="AI study tools" button={<><Sparkles size={15} /> <span className="tb-label">AI</span></>}>
            {(close) => (
              <>
                {(['summary', 'flashcards', 'quiz'] as AiTask[]).map((t) => (
                  <button key={t} className="tb-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { ask(t); close() }}>
                    <span><Sparkles size={13} /></span> {AI_LABELS[t]}
                  </button>
                ))}
                <div className="tb-divider" />
                {(['explain', 'simplify'] as AiTask[]).map((t) => (
                  <button key={t} className="tb-item" onMouseDown={(e) => e.preventDefault()} onClick={() => { ask(t, editor); close() }}>
                    <span><Sparkles size={13} /></span> {AI_LABELS[t]} selection
                  </button>
                ))}
              </>
            )}
          </Menu>
        </>
      )}
    </div>
  )
}
