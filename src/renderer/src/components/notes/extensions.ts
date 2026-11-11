import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import Highlight from '@tiptap/extension-highlight'
import Typography from '@tiptap/extension-typography'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'

/* ---------- Callout: a tinted box with an emoji, for key ideas and definitions ---------- */
export type CalloutTone = 'idea' | 'definition' | 'warning' | 'example'
export const CALLOUTS: Record<CalloutTone, { emoji: string; label: string }> = {
  idea: { emoji: '💡', label: 'Key idea' },
  definition: { emoji: '📘', label: 'Definition' },
  warning: { emoji: '⚠️', label: 'Watch out' },
  example: { emoji: '✏️', label: 'Example' }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: { setCallout: (tone: CalloutTone) => ReturnType }
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: 'idea',
        parseHTML: (el) => el.getAttribute('data-tone') ?? 'idea',
        renderHTML: (a) => ({ 'data-tone': a.tone, 'data-emoji': CALLOUTS[a.tone as CalloutTone]?.emoji ?? '💡' })
      }
    }
  },
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0],
  addCommands() {
    return {
      setCallout:
        (tone) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone })
    }
  }
})

/* ---------- Slash commands ---------- */
export interface SlashItem {
  title: string
  hint: string
  icon: string
  keywords: string
  run: (editor: Editor, range: Range) => void
}

const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r)

export const SLASH_ITEMS: SlashItem[] = [
  { title: 'Text', hint: 'Plain paragraph', icon: 'Aa', keywords: 'paragraph body', run: (e, r) => chain(e, r).setParagraph().run() },
  { title: 'Heading', hint: 'Big section title', icon: 'H1', keywords: 'h1 title', run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
  { title: 'Subheading', hint: 'Medium section title', icon: 'H2', keywords: 'h2', run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
  { title: 'Small heading', hint: 'Small section title', icon: 'H3', keywords: 'h3', run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
  { title: 'Bullet list', hint: 'Simple list', icon: '•', keywords: 'ul unordered', run: (e, r) => chain(e, r).toggleBulletList().run() },
  { title: 'Numbered list', hint: 'Steps in order', icon: '1.', keywords: 'ol ordered', run: (e, r) => chain(e, r).toggleOrderedList().run() },
  { title: 'Checklist', hint: 'Things to tick off', icon: '☑', keywords: 'todo task checkbox', run: (e, r) => chain(e, r).toggleTaskList().run() },
  ...(Object.keys(CALLOUTS) as CalloutTone[]).map<SlashItem>((tone) => ({
    title: CALLOUTS[tone].label,
    hint: 'Callout box',
    icon: CALLOUTS[tone].emoji,
    keywords: `callout box ${tone}`,
    run: (e, r) => chain(e, r).setCallout(tone).run()
  })),
  { title: 'Question toggle', hint: 'Hide the answer to quiz yourself', icon: '▸', keywords: 'details toggle collapse qa quiz flashcard', run: (e, r) => chain(e, r).setDetails().run() },
  { title: 'Table', hint: '3 × 3 grid', icon: '▦', keywords: 'grid columns', run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: 'Quote', hint: 'Quoted passage', icon: '❝', keywords: 'blockquote citation', run: (e, r) => chain(e, r).toggleBlockquote().run() },
  { title: 'Code', hint: 'Code block', icon: '</>', keywords: 'pre snippet', run: (e, r) => chain(e, r).toggleCodeBlock().run() },
  { title: 'Divider', hint: 'Horizontal line', icon: '—', keywords: 'hr rule separator', run: (e, r) => chain(e, r).setHorizontalRule().run() }
]

/** The slash menu's on-screen state, shared with the React popup (SlashMenu.tsx). */
export interface SlashState {
  items: SlashItem[]
  rect: DOMRect | null
  index: number
  pick: (item: SlashItem) => void
}
type SlashListener = (s: SlashState | null) => void
const slashListeners = new Set<SlashListener>()
export const onSlash = (l: SlashListener) => {
  slashListeners.add(l)
  return () => void slashListeners.delete(l)
}
let slashState: SlashState | null = null
const setSlash = (s: SlashState | null) => {
  slashState = s
  slashListeners.forEach((l) => l(s))
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: '/',
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => {
          const q = query.toLowerCase()
          return SLASH_ITEMS.filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords.includes(q)).slice(0, 12)
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          const show = (p: SuggestionProps<SlashItem, SlashItem>, index = 0) =>
            setSlash(p.items.length ? { items: p.items, rect: p.clientRect?.() ?? null, index, pick: (item) => p.command(item) } : null)
          let last: SuggestionProps<SlashItem, SlashItem> | null = null
          return {
            onStart: (p) => {
              last = p
              show(p)
            },
            onUpdate: (p) => {
              last = p
              show(p)
            },
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              if (!slashState || !last) return false
              const n = slashState.items.length
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                show(last, (slashState.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n)
                return true
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                slashState.pick(slashState.items[slashState.index])
                return true
              }
              if (event.key === 'Escape') {
                setSlash(null)
                return true
              }
              return false
            },
            onExit: () => {
              last = null
              setSlash(null)
            }
          }
        }
      })
    ]
  }
})

/** Every extension a note uses. `slash` is off for the small Cornell side editors. */
export function noteExtensions(placeholder: string, slash = true) {
  return [
    StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
    Highlight.configure({ multicolor: true }),
    Typography,
    TaskList,
    TaskItem.configure({ nested: true }),
    Callout,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    Placeholder.configure({
      includeChildren: true,
      placeholder: ({ node }) => (node.type.name === 'detailsSummary' ? 'Question…' : node.type.name === 'paragraph' ? placeholder : '')
    }),
    ...(slash ? [SlashCommand] : [])
  ]
}

/** Plain text of a TipTap JSON doc, for excerpts, search and word counts. */
export function docText(doc: unknown): string {
  const out: string[] = []
  const walk = (n: any) => {
    if (!n) return
    if (n.type === 'text' && n.text) out.push(n.text)
    if (Array.isArray(n.content)) {
      n.content.forEach(walk)
      if (n.type !== 'text') out.push(' ')
    }
  }
  walk(doc)
  return out.join('').replace(/\s+/g, ' ').trim()
}

export const wordCount = (text: string) => (text ? text.split(/\s+/).filter(Boolean).length : 0)
