/**
 * Notes as Markdown for AI apps (MCP), in the main process: TipTap JSON →
 * Markdown for reading, and simple Markdown → TipTap JSON for notes they
 * write. Writing only makes node types the editor knows, with the attrs it
 * expects, so a note made this way always opens.
 */
type N = { type: string; text?: string; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any> }[]; content?: N[] }

const CALLOUT: Record<string, string> = { idea: '💡', definition: '📘', warning: '⚠️', example: '✏️' }

function inline(nodes: N[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      let t = n.text ?? ''
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`
        else if (m.type === 'italic') t = `*${t}*`
        else if (m.type === 'strike') t = `~~${t}~~`
        else if (m.type === 'code') t = '`' + t + '`'
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`
      }
      return t
    })
    .join('')
}

function block(n: N, indent = ''): string {
  const kids = n.content ?? []
  const items = (bullet: (i: number, li: N) => string) =>
    kids
      .map((li, i) => {
        const [first, ...rest] = li.content ?? []
        return [indent + bullet(i, li) + (first ? inline(first.content) : ''), ...rest.map((k) => block(k, indent + '  '))].filter(Boolean).join('\n')
      })
      .join('\n')
  switch (n.type) {
    case 'paragraph':
      return indent + inline(kids)
    case 'heading':
      return '#'.repeat(n.attrs?.level ?? 1) + ' ' + inline(kids)
    case 'bulletList':
      return items(() => '- ')
    case 'orderedList':
      return items((i) => `${i + 1}. `)
    case 'taskList':
      return items((_, li) => (li.attrs?.checked ? '- [x] ' : '- [ ] '))
    case 'blockquote':
      return kids.map((k) => block(k)).join('\n\n').split('\n').map((l) => '> ' + l).join('\n')
    case 'callout':
      return kids.map((k) => block(k)).join('\n\n').split('\n').map((l, i) => '> ' + (i === 0 ? `${CALLOUT[n.attrs?.tone] ?? '💡'} ` : '') + l).join('\n')
    case 'details': {
      const [summary, body] = kids
      return `**${inline(summary?.content)}**\n\n${(body?.content ?? []).map((k) => block(k)).join('\n\n')}`
    }
    case 'codeBlock':
      return '```\n' + kids.map((k) => k.text ?? '').join('') + '\n```'
    case 'horizontalRule':
      return '---'
    case 'table': {
      const rows = kids.map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((p) => inline(p.content)).join(' ').replace(/\|/g, '\\|')))
      if (!rows.length) return ''
      return [`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n')
    }
    case 'attachment':
      return `📎 ${n.attrs?.name ?? 'Attachment'}`
    case 'drawing':
      return '✏️ (a drawing)'
    default:
      return kids.map((k) => block(k, indent)).join('\n\n')
  }
}

export function docToMarkdown(doc: unknown): string {
  const d = doc as N | null
  if (!d || !Array.isArray(d.content)) return ''
  return d.content.map((n) => block(n)).filter((s) => s.trim() !== '').join('\n\n')
}

/** A note's whole text as Markdown, Cornell cues and summary included. */
export function noteMarkdown(n: { title?: string; content?: unknown; cues?: unknown; summary?: unknown; template?: string }): string {
  const parts = [`# ${n.title || 'Untitled'}`, docToMarkdown(n.content)]
  if (n.template === 'cornell') {
    const cues = docToMarkdown(n.cues)
    const summary = docToMarkdown(n.summary)
    if (cues) parts.push('## Cues', cues)
    if (summary) parts.push('## Summary', summary)
  }
  return parts.filter(Boolean).join('\n\n')
}

/* ---------- Markdown → note ---------- */
function marks(text: string): N[] {
  const out: N[] = []
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    if (m[2]) out.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] })
    else if (m[3]) out.push({ type: 'text', text: m[3], marks: [{ type: 'italic' }] })
    else if (m[4]) out.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] })
    else if (m[5]) out.push({ type: 'text', text: m[5], marks: [{ type: 'link', attrs: { href: m[6] } }] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out.filter((t) => t.text)
}
const para = (t: string): N => ({ type: 'paragraph', ...(t.trim() ? { content: marks(t.trim()) } : {}) })

/** Headings, bullet / numbered / check lists, quotes, code, dividers and paragraphs. */
export function markdownToDoc(md: string): { type: 'doc'; content: N[] } {
  const lines = String(md ?? '').replace(/\r/g, '').split('\n')
  const out: N[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    let m: RegExpMatchArray | null
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++
      out.push({ type: 'codeBlock', ...(code.length ? { content: [{ type: 'text', text: code.join('\n') }] } : {}) })
    } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      out.push({ type: 'heading', attrs: { level: m[1].length }, content: marks(m[2]) })
      i++
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ type: 'horizontalRule' })
      i++
    } else if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const items: N[] = []
      while (i < lines.length && (m = lines[i].match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
        items.push({ type: 'taskItem', attrs: { checked: m[1].toLowerCase() === 'x' }, content: [para(m[2])] })
        i++
      }
      out.push({ type: 'taskList', content: items })
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: N[] = []
      while (i < lines.length && (m = lines[i].match(/^\s*[-*]\s+(.*)$/)) && !/^\s*[-*]\s+\[[ xX]\]/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(m[1])] })
        i++
      }
      out.push({ type: 'bulletList', content: items })
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: N[] = []
      while (i < lines.length && (m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/))) {
        items.push({ type: 'listItem', content: [para(m[1])] })
        i++
      }
      out.push({ type: 'orderedList', attrs: { start: 1 }, content: items })
    } else if (line.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push({ type: 'blockquote', content: q.join('\n').split(/\n{2,}/).map(para) })
    } else {
      const p: string[] = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|>|\s*[-*]\s|\s*\d+[.)]\s|-{3,}\s*$)/.test(lines[i])) p.push(lines[i++].trim())
      out.push(para(p.join(' ')))
    }
  }
  return { type: 'doc', content: out.length ? out : [{ type: 'paragraph' }] }
}

/** Plain text for a note's excerpt (lists and search). */
export function docPlain(doc: unknown): string {
  const out: string[] = []
  const walk = (n: N) => {
    if (n.type === 'text' && n.text) out.push(n.text)
    n.content?.forEach(walk)
  }
  if (doc) walk(doc as N)
  return out.join(' ').replace(/\s+/g, ' ').trim()
}
