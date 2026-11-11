import { CALLOUTS, type CalloutTone } from './extensions'

type Node = { type: string; text?: string; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any> }[]; content?: Node[] }

const NL = '\n'

function inline(nodes: Node[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  ' + NL
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'code') t = '`' + t + '`'
        else if (m.type === 'highlight') t = `==${t}==`
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`
      }
      return t
    })
    .join('')
}

const quote = (text: string) =>
  text
    .split(NL)
    .map((l) => '> ' + l)
    .join(NL)

function listItem(li: Node, indent: string, bullet: string): string {
  const [first, ...rest] = li.content ?? []
  const head = indent + bullet + (first ? inline(first.content) : '')
  const tail = rest.map((k) => block(k, indent + '  ')).filter(Boolean)
  return [head, ...tail].join(NL)
}

function block(n: Node, indent = ''): string {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      return indent + inline(kids)
    case 'heading':
      return '#'.repeat(n.attrs?.level ?? 1) + ' ' + inline(kids)
    case 'bulletList':
      return kids.map((li) => listItem(li, indent, '- ')).join(NL)
    case 'orderedList':
      return kids.map((li, i) => listItem(li, indent, `${i + 1}. `)).join(NL)
    case 'taskList':
      return kids.map((li) => listItem(li, indent, li.attrs?.checked ? '- [x] ' : '- [ ] ')).join(NL)
    case 'blockquote':
      return quote(kids.map((k) => block(k)).join(NL + NL))
    case 'callout': {
      const c = CALLOUTS[(n.attrs?.tone as CalloutTone) ?? 'idea'] ?? CALLOUTS.idea
      return quote(`${c.emoji} **${c.label}**` + NL + kids.map((k) => block(k)).join(NL + NL))
    }
    case 'details': {
      const summary = kids.find((k) => k.type === 'detailsSummary')
      const content = kids.find((k) => k.type === 'detailsContent')
      return `**Q: ${inline(summary?.content)}**` + NL + NL + (content?.content ?? []).map((k) => block(k)).join(NL + NL)
    }
    case 'codeBlock':
      return '```' + NL + kids.map((k) => k.text ?? '').join('') + NL + '```'
    case 'horizontalRule':
      return '---'
    case 'table': {
      const rows = kids.map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((p) => inline(p.content)).join(' ').replace(/\|/g, '\\|')))
      if (!rows.length) return ''
      const head = rows[0]
      return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join(NL)
    }
    default:
      return kids.map((k) => block(k, indent)).join(NL + NL)
  }
}

/** A note as Markdown, for exporting: title, then the page (Cornell cues and summary as sections). */
export function noteToMarkdown(note: { title: string; content?: unknown; cues?: unknown; summary?: unknown; template?: string }): string {
  const body = (doc: unknown) => (((doc as Node | null)?.content ?? []) as Node[]).map((n) => block(n)).join(NL + NL).trim()
  const parts = [`# ${note.title || 'Untitled'}`]
  if (note.template === 'cornell') {
    if (body(note.cues)) parts.push('## Cues' + NL + NL + body(note.cues))
    parts.push('## Notes' + NL + NL + body(note.content))
    if (body(note.summary)) parts.push('## Summary' + NL + NL + body(note.summary))
  } else parts.push(body(note.content))
  return parts.filter(Boolean).join(NL + NL) + NL
}
