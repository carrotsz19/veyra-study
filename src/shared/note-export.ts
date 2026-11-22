/**
 * Shared types and helpers for exporting notes to PDF, Word (.docx), and Markdown.
 * Pure TypeScript with zero runtime dependencies so it works in Electron main,
 * the desktop renderer, Android (Capacitor), the website, and Node tests.
 */
import type { NoteFont, NoteTemplate } from './types'

export type ExportFormat = 'pdf' | 'docx' | 'md'

export interface ExportNode {
  type: string
  text?: string
  attrs?: Record<string, any>
  marks?: { type: string; attrs?: Record<string, any> }[]
  content?: ExportNode[]
}

export interface ExportStroke {
  c: string
  w: number
  h?: 1
  p: number[]
}

export interface ExportMediaItem {
  bytes: Uint8Array
  mime: string
  /** Pixel dimensions when known (images and rasterized drawings). */
  width?: number
  height?: number
}

/** Map from attachment id (or `drawing:<index>`) to its resolved binary media. */
export type ExportMedia = Record<string, ExportMediaItem>

export interface ExportNoteInput {
  title: string
  icon?: string
  subject?: string
  tags?: string[]
  template?: NoteTemplate
  font?: NoteFont
  content?: unknown
  cues?: unknown
  summary?: unknown
  updatedAt?: number
}

export const CALLOUT_META: Record<string, { emoji: string; label: string; bg: string; border: string; title: string }> = {
  idea: { emoji: '💡', label: 'Key idea', bg: '#FEF9C3', border: '#CA8A04', title: '#854D0E' },
  definition: { emoji: '📘', label: 'Definition', bg: '#DBEAFE', border: '#2563EB', title: '#1E40AF' },
  warning: { emoji: '⚠️', label: 'Watch out', bg: '#FCE7F3', border: '#DB2777', title: '#9D174D' },
  example: { emoji: '✏️', label: 'Example', bg: '#DCFCE7', border: '#16A34A', title: '#166534' }
}

export function calloutMeta(tone?: string) {
  return CALLOUT_META[tone ?? 'idea'] ?? CALLOUT_META.idea
}

const HL_VAR_MAP: Record<string, string> = {
  'var(--hl-yellow)': '#FEF08A',
  'var(--hl-green)': '#BBF7D0',
  'var(--hl-blue)': '#BFDBFE',
  'var(--hl-pink)': '#FBCFE8',
  'var(--hl-purple)': '#E9D5FF',
  yellow: '#FEF08A',
  green: '#BBF7D0',
  blue: '#BFDBFE',
  pink: '#FBCFE8',
  purple: '#E9D5FF'
}

/** Resolves a TipTap highlight color attribute (`var(--hl-yellow)` or `#rrggbb`) to a print-safe hex color. */
export function resolveHighlightHex(raw?: string | null): string {
  if (!raw) return '#FEF08A'
  const key = raw.trim().toLowerCase()
  if (HL_VAR_MAP[key]) return HL_VAR_MAP[key]
  if (/^#[0-9a-f]{6}$/i.test(key)) return key.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(key)) {
    return `#${key[1]}${key[1]}${key[2]}${key[2]}${key[3]}${key[3]}`.toUpperCase()
  }
  return '#FEF08A'
}

export function safeFileName(name: string): string {
  return (String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Untitled').slice(0, 120)
}

export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const u = href.trim()
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u
  return null
}

export function formatFileSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/i.test(mime || '')
}

export function formatExportDate(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  try {
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export function hasDocContent(doc: unknown): boolean {
  const d = doc as ExportNode | null | undefined
  if (!d || !Array.isArray(d.content) || !d.content.length) return false
  const walk = (n: ExportNode): boolean => {
    if (n.type === 'text' && (n.text ?? '').trim()) return true
    if (n.type === 'attachment' || n.type === 'horizontalRule') return true
    if (n.type === 'drawing') return Array.isArray(n.attrs?.strokes) && n.attrs.strokes.length > 0
    return Array.isArray(n.content) && n.content.some(walk)
  }
  return d.content.some(walk)
}

/** Walks TipTap JSON docs in deterministic document order and assigns `drawing:<index>` keys. */
export function drawingKey(index: number): string {
  return `drawing:${index}`
}

/** Generates a crisp vector SVG for a drawing block's strokes (matching drawing.ts). */
export function strokesToSvg(strokes: ExportStroke[], height: number): string {
  const w = 1000
  const h = Math.max(120, Math.min(4000, Number(height) || 600))
  const parts: string[] = []
  for (const s of strokes) {
    const p = Array.isArray(s.p) ? s.p : []
    if (p.length < 3) continue
    const strokeColor = s.c === 'ink' || !s.c ? '#1b1a18' : /^#[0-9a-f]{3,8}$/i.test(s.c) ? s.c : '#1b1a18'
    const width = Math.max(0.6, s.h ? (s.w || 4) * 4 : s.w || 4)
    const opacity = s.h ? ' opacity="0.35"' : ''
    if (p.length === 3) {
      parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${(width / 2).toFixed(2)}" fill="${strokeColor}"${opacity}/>`)
      continue
    }
    let d = `M ${p[0]} ${p[1]}`
    for (let i = 3; i < p.length; i += 3) {
      const x0 = p[i - 3]
      const y0 = p[i - 2]
      const x1 = p[i]
      const y1 = p[i + 1]
      const mx = ((x0 + x1) / 2).toFixed(1)
      const my = ((y0 + y1) / 2).toFixed(1)
      d += ` Q ${x0} ${y0} ${mx} ${my}`
      if (i === p.length - 3) d += ` L ${x1} ${y1}`
    }
    const cap = s.h ? 'butt' : 'round'
    parts.push(`<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="round"${opacity}/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
}

/** Reads pixel dimensions from PNG, JPEG, or GIF headers without external dependencies. */
export function parseImageDimensions(bytes: Uint8Array, mime = ''): { width: number; height: number } | null {
  if (!bytes || bytes.length < 10) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width at 16..19, height at 20..23
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    if (width > 0 && height > 0) return { width, height }
  }
  // GIF: GIF87a / GIF89a, little-endian uint16 at 6..7 and 8..9
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint16(6, true)
    const height = view.getUint16(8, true)
    if (width > 0 && height > 0) return { width, height }
  }
  // JPEG: FF D8 ... SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      while (i < bytes.length && bytes[i] === 0xff) i++
      if (i >= bytes.length) break
      const marker = bytes[i++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (i + 2 > bytes.length) break
      const len = (bytes[i] << 8) | bytes[i + 1]
      if (len < 2 || i + len > bytes.length) break
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof && i + 7 < bytes.length) {
        const height = (bytes[i + 3] << 8) | bytes[i + 4]
        const width = (bytes[i + 5] << 8) | bytes[i + 6]
        if (width > 0 && height > 0) return { width, height }
      }
      i += len
    }
  }
  void mime
  return null
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

/* =====================================================================
   PRINT HTML (Desktop Electron Chromium printToPDF)
===================================================================== */

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(nodes: ExportNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '<br>'
      if (n.type !== 'text') return n.content ? renderInline(n.content) : ''
      let out = esc(n.text ?? '')
      for (const m of n.marks ?? []) {
        if (m.type === 'code') out = `<code>${out}</code>`
        else if (m.type === 'bold') out = `<strong>${out}</strong>`
        else if (m.type === 'italic') out = `<em>${out}</em>`
        else if (m.type === 'underline') out = `<u>${out}</u>`
        else if (m.type === 'strike') out = `<s>${out}</s>`
        else if (m.type === 'highlight') {
          const hex = resolveHighlightHex(m.attrs?.color)
          out = `<mark style="background:${hex}">${out}</mark>`
        } else if (m.type === 'link') {
          const href = safeHref(m.attrs?.href)
          if (href) out = `<a href="${esc(href)}">${out}</a>`
        }
      }
      return out
    })
    .join('')
}

function renderHtmlBlocks(nodes: ExportNode[] = [], media: ExportMedia = {}): string {
  return nodes.map((n) => renderHtmlBlock(n, media)).join('')
}

function renderHtmlBlock(n: ExportNode, media: ExportMedia): string {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph': {
      const inner = renderInline(kids)
      return inner ? `<p>${inner}</p>` : '<p class="empty-p">&nbsp;</p>'
    }
    case 'heading': {
      const level = Math.max(1, Math.min(3, Number(n.attrs?.level) || 1))
      return `<h${level}>${renderInline(kids)}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${kids.map((li) => `<li>${renderHtmlBlocks(li.content, media)}</li>`).join('')}</ul>`
    case 'orderedList': {
      const start = Number(n.attrs?.start)
      const attr = Number.isFinite(start) && start > 1 ? ` start="${Math.round(start)}"` : ''
      return `<ol${attr}>${kids.map((li) => `<li>${renderHtmlBlocks(li.content, media)}</li>`).join('')}</ol>`
    }
    case 'taskList':
      return `<ul class="task-list">${kids
        .map((li) => {
          const checked = !!li.attrs?.checked
          return `<li class="${checked ? 'checked' : ''}"><span class="task-box">${checked ? '✓' : ''}</span><div class="task-body">${renderHtmlBlocks(li.content, media)}</div></li>`
        })
        .join('')}</ul>`
    case 'blockquote':
      return `<blockquote>${renderHtmlBlocks(kids, media)}</blockquote>`
    case 'callout': {
      const c = calloutMeta(n.attrs?.tone)
      return `<div class="callout" style="background:${c.bg};border-left-color:${c.border}"><div class="callout-head" style="color:${c.title}"><span class="callout-emoji">${esc(c.emoji)}</span><span>${esc(c.label)}</span></div><div class="callout-body">${renderHtmlBlocks(kids, media)}</div></div>`
    }
    case 'details': {
      const summary = kids.find((k) => k.type === 'detailsSummary')
      const body = kids.find((k) => k.type === 'detailsContent')
      const q = renderInline(summary?.content) || 'Question'
      const a = renderHtmlBlocks(body?.content, media)
      return `<div class="qa-card"><div class="qa-q">${q}</div>${a ? `<div class="qa-a">${a}</div>` : ''}</div>`
    }
    case 'codeBlock': {
      const text = kids.map((k) => k.text ?? '').join('')
      return `<pre><code>${esc(text)}</code></pre>`
    }
    case 'horizontalRule':
      return '<hr>'
    case 'table': {
      if (!kids.length) return ''
      const rows = kids.map((row) => {
        const cells = (row.content ?? [])
          .map((cell) => {
            const tag = cell.type === 'tableHeader' ? 'th' : 'td'
            const cs = Number(cell.attrs?.colspan) > 1 ? ` colspan="${Math.round(cell.attrs!.colspan)}"` : ''
            const rs = Number(cell.attrs?.rowspan) > 1 ? ` rowspan="${Math.round(cell.attrs!.rowspan)}"` : ''
            return `<${tag}${cs}${rs}>${renderHtmlBlocks(cell.content, media)}</${tag}>`
          })
          .join('')
        return `<tr>${cells}</tr>`
      })
      const firstIsHeader = (kids[0].content ?? []).every((c) => c.type === 'tableHeader')
      if (firstIsHeader && rows.length > 1) {
        return `<table><thead>${rows[0]}</thead><tbody>${rows.slice(1).join('')}</tbody></table>`
      }
      return `<table><tbody>${rows.join('')}</tbody></table>`
    }
    case 'drawing': {
      const strokes = (Array.isArray(n.attrs?.strokes) ? n.attrs.strokes : []) as ExportStroke[]
      if (!strokes.length) return ''
      const svg = strokesToSvg(strokes, Number(n.attrs?.height) || 600)
      return `<figure class="drawing-block">${svg}</figure>`
    }
    case 'attachment': {
      const id = String(n.attrs?.id ?? '')
      const name = String(n.attrs?.name ?? 'Attachment')
      const mime = String(n.attrs?.mime ?? '')
      const size = formatFileSize(Number(n.attrs?.size ?? 0))
      const item = id ? media[id] : undefined
      if (isImageMime(mime) && item && item.bytes.byteLength > 0) {
        const src = `data:${item.mime || mime};base64,${bytesToBase64(item.bytes)}`
        return `<figure class="img-block"><img src="${src}" alt="${esc(name)}"></figure>`
      }
      const badge = /^audio\//.test(mime) ? '🎙️' : mime === 'application/pdf' || /\.pdf$/i.test(name) ? '📕' : '📎'
      return `<div class="att-card"><span class="att-icon">${badge}</span><span class="att-name">${esc(name)}</span>${size ? `<span class="att-size">${esc(size)}</span>` : ''}</div>`
    }
    default:
      return kids.length ? renderHtmlBlocks(kids, media) : ''
  }
}

function fontStack(font?: string): string {
  if (font === 'serif') return `'Iowan Old Style', 'Charter', Cambria, Georgia, 'Times New Roman', serif`
  if (font === 'mono') return `'Cascadia Code', 'JetBrains Mono', ui-monospace, Consolas, monospace`
  return `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif`
}

export function noteToExportHtml(note: ExportNoteInput, media: ExportMedia = {}): string {
  const title = note.title?.trim() || 'Untitled'
  const dateStr = formatExportDate(note.updatedAt)
  const metaParts: string[] = []
  if (note.subject) metaParts.push(`<span class="meta-pill">${esc(note.subject)}</span>`)
  for (const t of note.tags ?? []) metaParts.push(`<span class="meta-tag">#${esc(t)}</span>`)
  if (dateStr) metaParts.push(`<span class="meta-date">${esc(dateStr)}</span>`)

  const docNodes = (d: unknown): ExportNode[] => {
    const n = d as ExportNode | null | undefined
    return n && Array.isArray(n.content) ? n.content : []
  }

  let bodyHtml = ''
  if (note.template === 'cornell') {
    const cuesHtml = renderHtmlBlocks(docNodes(note.cues), media)
    const notesHtml = renderHtmlBlocks(docNodes(note.content), media)
    const summaryHtml = hasDocContent(note.summary) ? renderHtmlBlocks(docNodes(note.summary), media) : ''
    bodyHtml = `
      <div class="cornell">
        <div class="cornell-grid">
          <div class="cornell-cues">
            <div class="cornell-label">Cues &amp; questions</div>
            ${cuesHtml || '<p class="muted">—</p>'}
          </div>
          <div class="cornell-notes">
            <div class="cornell-label">Notes</div>
            ${notesHtml || '<p class="muted">—</p>'}
          </div>
        </div>
        ${
          summaryHtml
            ? `<div class="cornell-summary"><div class="cornell-label">Summary</div>${summaryHtml}</div>`
            : ''
        }
      </div>`
  } else {
    bodyHtml = `<div class="note-body ${note.template === 'lined' ? 'paper-lined' : note.template === 'grid' ? 'paper-grid' : ''}">${renderHtmlBlocks(docNodes(note.content), media)}</div>`
  }

  const baseSize = note.font === 'mono' ? '10pt' : note.font === 'serif' ? '11.5pt' : '11pt'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #1b1a18;
    font-family: ${fontStack(note.font)};
    font-size: ${baseSize};
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc-header {
    padding-bottom: 12px;
    margin-bottom: 18px;
    border-bottom: 1px solid #e5e3dc;
  }
  .doc-title {
    margin: 0;
    font-size: 24pt;
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: -0.02em;
    color: #141311;
    word-break: break-word;
  }
  .doc-icon { margin-right: 10px; }
  .doc-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 9.2pt;
    color: #6b6963;
  }
  .meta-pill {
    display: inline-block;
    background: #f2f1ec;
    color: #2c2a26;
    padding: 2px 9px;
    border-radius: 99px;
    font-weight: 600;
  }
  .meta-tag { color: #57554f; }
  .meta-date { margin-left: auto; color: #7a7871; }
  h1, h2, h3 {
    color: #141311;
    margin: 1.3em 0 0.35em;
    break-after: avoid;
    page-break-after: avoid;
  }
  h1 { font-size: 16.5pt; font-weight: 800; line-height: 1.25; }
  h2 { font-size: 13.5pt; font-weight: 700; line-height: 1.3; }
  h3 { font-size: 11.5pt; font-weight: 700; line-height: 1.35; }
  p { margin: 0 0 0.6em; orphans: 3; widows: 3; }
  p.empty-p { margin: 0 0 0.3em; }
  .muted { color: #8c8981; }
  a { color: #2563eb; text-decoration: underline; word-break: break-all; }
  code {
    background: #f3f2ed;
    border: 1px solid #e7e5de;
    padding: 0.08em 0.35em;
    border-radius: 4px;
    font-family: 'Cascadia Code', ui-monospace, Consolas, monospace;
    font-size: 0.88em;
  }
  pre {
    background: #f6f5f1;
    border: 1px solid #e5e3dc;
    border-radius: 7px;
    padding: 10px 13px;
    margin: 0.7em 0;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
    break-inside: avoid;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 9.2pt; }
  mark { border-radius: 3px; padding: 0.05em 0.18em; color: inherit; }
  ul, ol { margin: 0.35em 0 0.7em; padding-left: 1.5em; }
  li { margin-bottom: 0.25em; }
  li > p { margin-bottom: 0.2em; }
  ul.task-list { list-style: none; padding-left: 0; }
  ul.task-list > li { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 0.32em; }
  .task-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-top: 3px;
    border: 1.4px solid #8c8981;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: #fff;
  }
  ul.task-list > li.checked > .task-box { background: #16a34a; border-color: #16a34a; }
  ul.task-list > li.checked > .task-body { color: #7a7871; text-decoration: line-through; }
  .task-body { flex: 1; min-width: 0; }
  blockquote {
    margin: 0.7em 0;
    padding: 3px 0 3px 14px;
    border-left: 3px solid #c9c6bd;
    color: #57554f;
    font-style: italic;
  }
  .callout {
    border-left: 3.5px solid #ca8a04;
    border-radius: 7px;
    padding: 10px 14px;
    margin: 0.8em 0;
    break-inside: avoid;
  }
  .callout-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 9.8pt;
    margin-bottom: 4px;
  }
  .callout-body > :last-child { margin-bottom: 0; }
  .qa-card {
    border: 1px solid #dedcd4;
    border-radius: 7px;
    padding: 10px 13px;
    margin: 0.8em 0;
    break-inside: avoid;
  }
  .qa-q { font-weight: 700; color: #141311; }
  .qa-a {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #dedcd4;
  }
  .qa-a > :last-child { margin-bottom: 0; }
  hr { border: 0; border-top: 1px solid #dedcd4; margin: 1.2em 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.8em 0;
    font-size: 10pt;
  }
  th, td {
    border: 1px solid #d8d5cd;
    padding: 7px 10px;
    text-align: left;
    vertical-align: top;
    word-break: break-word;
  }
  th { background: #f3f2ed; font-weight: 700; }
  th > :last-child, td > :last-child { margin-bottom: 0; }
  tr { break-inside: avoid; }
  .img-block, .drawing-block {
    margin: 0.9em 0;
    text-align: center;
    break-inside: avoid;
  }
  .img-block img {
    max-width: 100%;
    max-height: 680px;
    height: auto;
    border-radius: 6px;
    border: 1px solid #eceae4;
  }
  .drawing-block svg {
    width: 100%;
    height: auto;
    max-height: 680px;
    display: block;
    border: 1px solid #eceae4;
    border-radius: 6px;
    background: #ffffff;
  }
  .att-card {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 11px;
    margin: 0.5em 0;
    border: 1px solid #dedcd4;
    border-radius: 6px;
    background: #faf9f6;
    font-size: 9.8pt;
    break-inside: avoid;
  }
  .att-name { font-weight: 600; color: #2c2a26; }
  .att-size { color: #7a7871; font-size: 9pt; }
  .cornell {
    border: 1px solid #d8d5cd;
    border-radius: 8px;
    overflow: hidden;
  }
  .cornell-grid {
    display: table;
    width: 100%;
    table-layout: fixed;
  }
  .cornell-cues, .cornell-notes {
    display: table-cell;
    vertical-align: top;
    padding: 12px 14px;
  }
  .cornell-cues {
    width: 30%;
    background: #f7f6f2;
    border-right: 1px solid #d8d5cd;
    font-size: 0.94em;
  }
  .cornell-notes { width: 70%; }
  .cornell-summary {
    border-top: 1px solid #d8d5cd;
    background: #f3f6fc;
    padding: 12px 14px;
    break-inside: avoid;
  }
  .cornell-label {
    font-size: 8.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b6963;
    margin-bottom: 8px;
  }
  .paper-lined {
    background-image: repeating-linear-gradient(to bottom, transparent 0, transparent 25px, #efede7 25px, #efede7 26px);
  }
  .paper-grid {
    background-image: linear-gradient(to right, #f0eee8 1px, transparent 1px), linear-gradient(to bottom, #f0eee8 1px, transparent 1px);
    background-size: 20px 20px;
    padding: 8px 10px;
  }
</style>
</head>
<body>
  <header class="doc-header">
    <h1 class="doc-title">${note.icon ? `<span class="doc-icon">${esc(note.icon)}</span>` : ''}${esc(title)}</h1>
    ${metaParts.length ? `<div class="doc-meta">${metaParts.join('')}</div>` : ''}
  </header>
  ${bodyHtml}
</body>
</html>`
}

/* =====================================================================
   WORD (.docx) OOXML GENERATOR
===================================================================== */

const enc = new TextEncoder()

/* ---------- minimal PKZIP writer (STORE method 0, UTF-8 names, IEEE CRC-32) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function createZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name)
    const data = entry.data
    const crc = crc32(data)
    const size = data.byteLength

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lfh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed: 2.0
    lv.setUint16(6, 0x0800, true) // UTF-8 filename flag
    lv.setUint16(8, 0, true) // method: STORE
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0x5421, true) // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    lfh.set(nameBytes, 30)
    localParts.push(lfh, data)

    // Central directory header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cdh.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true) // UTF-8
    cv.setUint16(10, 0, true) // STORE
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x5421, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    cdh.set(nameBytes, 46)
    centralParts.push(cdh)

    offset += lfh.byteLength + size
  }

  const cdSize = centralParts.reduce((s, p) => s + p.byteLength, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  const total = offset + cdSize + eocd.byteLength
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of [...localParts, ...centralParts, eocd]) {
    out.set(p, pos)
    pos += p.byteLength
  }
  return out
}

/* ---------- XML helpers ---------- */
/** Escapes XML special chars and strips XML 1.0 illegal control characters. */
function x(s: string): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const hexNoHash = (h: string) => h.replace(/^#/, '').toUpperCase()

const CONTENT_W_TWIPS = 9026 // A4 (11906) - 2 * 1440 (1 inch margins)
const MAX_IMG_EMU_W = 5486400 // ~6.0 inches
const MAX_IMG_EMU_H = 6858000 // ~7.5 inches
const EMU_PER_PX = 9525 // 96 DPI

interface Rel {
  id: string
  type: string
  target: string
  external?: boolean
}

interface MediaAsset {
  zipPath: string
  ext: string
  mime: string
  bytes: Uint8Array
}

interface DocxCtx {
  rels: Rel[]
  media: MediaAsset[]
  orderedNums: { numId: number; start: number }[]
  nextRel: number
  nextDocPr: number
  drawingCounter: number
  inputMedia: ExportMedia
}

function addRel(ctx: DocxCtx, type: string, target: string, external = false): string {
  const id = `rId${ctx.nextRel++}`
  ctx.rels.push({ id, type, target, external })
  return id
}

function addImage(ctx: DocxCtx, bytes: Uint8Array, mime: string, widthPx?: number, heightPx?: number, alt = 'Image', maxW = MAX_IMG_EMU_W): string {
  const normMime = (mime || 'image/png').toLowerCase()
  const ext = normMime.includes('jpeg') || normMime.includes('jpg') ? 'jpeg' : normMime.includes('gif') ? 'gif' : 'png'
  const index = ctx.media.length + 1
  const target = `media/image${index}.${ext}`
  ctx.media.push({ zipPath: `word/${target}`, ext, mime: normMime, bytes })
  const rId = addRel(ctx, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target)
  const dims = widthPx && heightPx ? { width: widthPx, height: heightPx } : parseImageDimensions(bytes, normMime) ?? { width: 800, height: 500 }
  let cx = Math.round(dims.width * EMU_PER_PX)
  let cy = Math.round(dims.height * EMU_PER_PX)
  if (cx > maxW) {
    const ratio = maxW / cx
    cx = maxW
    cy = Math.round(cy * ratio)
  }
  if (cy > MAX_IMG_EMU_H) {
    const ratio = MAX_IMG_EMU_H / cy
    cy = MAX_IMG_EMU_H
    cx = Math.round(cx * ratio)
  }
  cx = Math.max(91440, cx)
  cy = Math.max(91440, cy)
  const docPrId = ctx.nextDocPr++
  const picId = ctx.nextDocPr++
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${x(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${picId}" name="image${index}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

interface RunStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  color?: string
  fill?: string
  sizeHalfPt?: number
  link?: string
}

function buildRun(text: string, st: RunStyle = {}): string {
  const rPr: string[] = []
  if (st.code) rPr.push(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>`)
  if (st.bold) rPr.push('<w:b/>')
  if (st.italic) rPr.push('<w:i/>')
  if (st.strike) rPr.push('<w:strike/>')
  if (st.color) rPr.push(`<w:color w:val="${hexNoHash(st.color)}"/>`)
  if (st.sizeHalfPt) rPr.push(`<w:sz w:val="${st.sizeHalfPt}"/><w:szCs w:val="${st.sizeHalfPt}"/>`)
  if (st.underline || st.link) rPr.push('<w:u w:val="single"/>')
  if (st.fill) rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hexNoHash(st.fill)}"/>`)
  else if (st.code) rPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F3F2ED"/>')
  const pr = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''
  return `<w:r>${pr}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`
}

function renderInlineRuns(nodes: ExportNode[] = [], ctx: DocxCtx, base: RunStyle = {}): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '<w:r><w:br/></w:r>'
      if (n.type !== 'text') return n.content ? renderInlineRuns(n.content, ctx, base) : ''
      const st: RunStyle = { ...base }
      let href: string | null = null
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') st.bold = true
        else if (m.type === 'italic') st.italic = true
        else if (m.type === 'underline') st.underline = true
        else if (m.type === 'strike') st.strike = true
        else if (m.type === 'code') {
          st.code = true
          st.sizeHalfPt = st.sizeHalfPt ?? 19
        } else if (m.type === 'highlight') {
          st.fill = resolveHighlightHex(m.attrs?.color)
        } else if (m.type === 'link') {
          href = safeHref(m.attrs?.href)
          if (href) {
            st.link = href
            st.color = '2563EB'
          }
        }
      }
      const run = buildRun(n.text ?? '', st)
      if (href) {
        const rId = addRel(ctx, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', href, true)
        return `<w:hyperlink r:id="${rId}" w:history="1">${run}</w:hyperlink>`
      }
      return run
    })
    .join('')
}

function paragraph(runs: string, pPr = ''): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`
}

function boxTable(innerXml: string, opts: { fill?: string; leftColor?: string; leftSize?: number; borderColor?: string; width?: number }): string {
  const w = opts.width ?? CONTENT_W_TWIPS
  const borderColor = hexNoHash(opts.borderColor ?? 'DEDCD4')
  const leftColor = hexNoHash(opts.leftColor ?? borderColor)
  const leftSize = opts.leftSize ?? 4
  const borderVal = opts.borderColor ? 'single' : 'none'
  const fillXml = opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hexNoHash(opts.fill)}"/>` : ''
  const cellBody = ensureCellEndsWithParagraph(innerXml)
  return `<w:tbl><w:tblPr><w:tblW w:w="${w}" w:type="dxa"/><w:tblBorders><w:top w:val="${borderVal}" w:sz="4" w:space="0" w:color="${borderColor}"/><w:left w:val="single" w:sz="${leftSize}" w:space="0" w:color="${leftColor}"/><w:bottom w:val="${borderVal}" w:sz="4" w:space="0" w:color="${borderColor}"/><w:right w:val="${borderVal}" w:sz="4" w:space="0" w:color="${borderColor}"/></w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="160" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${w}"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fillXml}</w:tcPr>${cellBody}</w:tc></w:tr></w:tbl>`
}

/** OOXML requires every `<w:tc>` to end with a `<w:p>`. */
function ensureCellEndsWithParagraph(xml: string): string {
  const trimmed = xml.trim()
  if (!trimmed) return '<w:p/>'
  return trimmed.endsWith('</w:p>') || trimmed.endsWith('<w:p/>') ? trimmed : `${trimmed}<w:p/>`
}

function renderList(listNode: ExportNode, ctx: DocxCtx, depth: number, ordered: boolean, containerW: number): string {
  const level = Math.min(5, depth)
  let numId = 1
  if (ordered) {
    numId = 2 + ctx.orderedNums.length
    const start = Math.max(1, Math.round(Number(listNode.attrs?.start) || 1))
    ctx.orderedNums.push({ numId, start })
  }
  const out: string[] = []
  for (const li of listNode.content ?? []) {
    const kids = li.content ?? []
    let firstDone = false
    for (const child of kids) {
      if (!firstDone && child.type === 'paragraph') {
        firstDone = true
        out.push(paragraph(renderInlineRuns(child.content, ctx), `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:before="0" w:after="60"/>`))
      } else if (child.type === 'bulletList') {
        out.push(renderList(child, ctx, depth + 1, false, containerW))
      } else if (child.type === 'orderedList') {
        out.push(renderList(child, ctx, depth + 1, true, containerW))
      } else {
        out.push(renderDocxBlock(child, ctx, containerW, depth + 1))
      }
    }
    if (!firstDone) {
      out.push(paragraph('', `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:before="0" w:after="60"/>`))
    }
  }
  return out.join('')
}

function renderTaskList(listNode: ExportNode, ctx: DocxCtx, depth: number, containerW: number): string {
  const out: string[] = []
  const indent = 240 + Math.min(5, depth) * 360
  for (const li of listNode.content ?? []) {
    const checked = !!li.attrs?.checked
    const prefix = buildRun(checked ? '☑  ' : '☐  ', { color: checked ? '16A34A' : '6B6963', bold: checked })
    const textStyle: RunStyle = checked ? { strike: true, color: '7A7871' } : {}
    const kids = li.content ?? []
    let firstDone = false
    for (const child of kids) {
      if (!firstDone && child.type === 'paragraph') {
        firstDone = true
        out.push(paragraph(prefix + renderInlineRuns(child.content, ctx, textStyle), `<w:spacing w:before="0" w:after="70"/><w:ind w:left="${indent}" w:hanging="240"/>`))
      } else if (child.type === 'taskList') {
        out.push(renderTaskList(child, ctx, depth + 1, containerW))
      } else {
        out.push(renderDocxBlock(child, ctx, containerW, depth + 1))
      }
    }
    if (!firstDone) {
      out.push(paragraph(prefix, `<w:spacing w:before="0" w:after="70"/><w:ind w:left="${indent}" w:hanging="240"/>`))
    }
  }
  return out.join('')
}

function renderDocxBlocks(nodes: ExportNode[] = [], ctx: DocxCtx, containerW = CONTENT_W_TWIPS, depth = 0): string {
  return nodes.map((n) => renderDocxBlock(n, ctx, containerW, depth)).join('')
}

function renderDocxBlock(n: ExportNode, ctx: DocxCtx, containerW = CONTENT_W_TWIPS, depth = 0): string {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph':
      return paragraph(renderInlineRuns(kids, ctx), '<w:spacing w:before="0" w:after="120"/>')
    case 'heading': {
      const level = Math.max(1, Math.min(3, Number(n.attrs?.level) || 1))
      return paragraph(renderInlineRuns(kids, ctx), `<w:pStyle w:val="Heading${level}"/><w:keepNext/>`)
    }
    case 'bulletList':
      return renderList(n, ctx, depth, false, containerW)
    case 'orderedList':
      return renderList(n, ctx, depth, true, containerW)
    case 'taskList':
      return renderTaskList(n, ctx, depth, containerW)
    case 'blockquote': {
      const inner = kids
        .map((k) =>
          k.type === 'paragraph'
            ? paragraph(
                renderInlineRuns(k.content, ctx, { italic: true, color: '57554F' }),
                '<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="C9C6BD"/></w:pBdr><w:spacing w:before="40" w:after="100"/><w:ind w:left="360"/>'
              )
            : renderDocxBlock(k, ctx, containerW - 360, depth)
        )
        .join('')
      return inner || ''
    }
    case 'callout': {
      const c = calloutMeta(n.attrs?.tone)
      const head = paragraph(buildRun(`${c.emoji}  ${c.label}`, { bold: true, color: c.title, sizeHalfPt: 20 }), '<w:spacing w:before="0" w:after="80"/>')
      const body = renderDocxBlocks(kids, ctx, Math.max(2400, containerW - 360), depth)
      return boxTable(head + body, { fill: c.bg, leftColor: c.border, leftSize: 24, width: containerW }) + '<w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr></w:p>'
    }
    case 'details': {
      const summary = kids.find((k) => k.type === 'detailsSummary')
      const content = kids.find((k) => k.type === 'detailsContent')
      const qRuns = renderInlineRuns(summary?.content, ctx, { bold: true, color: '141311' }) || buildRun('Question', { bold: true })
      const qPara = paragraph(qRuns, '<w:pBdr><w:bottom w:val="dashed" w:sz="4" w:space="6" w:color="DEDCD4"/></w:pBdr><w:spacing w:before="0" w:after="100"/>')
      const aXml = renderDocxBlocks(content?.content, ctx, Math.max(2400, containerW - 360), depth)
      return boxTable(qPara + aXml, { borderColor: 'DEDCD4', leftColor: 'DEDCD4', leftSize: 6, width: containerW }) + '<w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr></w:p>'
    }
    case 'codeBlock': {
      const text = kids.map((k) => k.text ?? '').join('')
      const lines = text.split('\n')
      const runs = lines.map((line, idx) => (idx > 0 ? '<w:r><w:br/></w:r>' : '') + buildRun(line, { code: true, sizeHalfPt: 19, fill: 'F6F5F1' })).join('')
      return (
        boxTable(paragraph(runs, '<w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/>'), {
          fill: 'F6F5F1',
          borderColor: 'E5E3DC',
          leftColor: 'E5E3DC',
          leftSize: 6,
          width: containerW
        }) + '<w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr></w:p>'
      )
    }
    case 'horizontalRule':
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="DEDCD4"/></w:pBdr><w:spacing w:before="120" w:after="180"/></w:pPr></w:p>'
    case 'table': {
      if (!kids.length) return ''
      const colCount = Math.max(1, ...kids.map((r) => (r.content ?? []).reduce((acc, c) => acc + Math.max(1, Number(c.attrs?.colspan) || 1), 0)))
      const colW = Math.floor(containerW / colCount)
      const grid = `<w:tblGrid>${Array.from({ length: colCount }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`
      const rowsXml = kids
        .map((row) => {
          const cells = row.content ?? []
          const isHeaderRow = cells.length > 0 && cells.every((c) => c.type === 'tableHeader')
          const cellsXml = cells
            .map((cell) => {
              const isHeader = cell.type === 'tableHeader'
              const span = Math.max(1, Number(cell.attrs?.colspan) || 1)
              const cellW = colW * span
              const inner = renderDocxBlocks(cell.content, ctx, Math.max(1200, cellW - 220), depth)
              const body = isHeader
                ? ensureCellEndsWithParagraph(inner.replace(/<w:rPr>/g, '<w:rPr><w:b/>').replace(/<w:r><w:t/g, '<w:r><w:rPr><w:b/></w:rPr><w:t'))
                : ensureCellEndsWithParagraph(inner)
              const tcPr = [
                `<w:tcW w:w="${cellW}" w:type="dxa"/>`,
                span > 1 ? `<w:gridSpan w:val="${span}"/>` : '',
                isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F2ED"/>' : ''
              ]
                .filter(Boolean)
                .join('')
              return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${body}</w:tc>`
            })
            .join('')
          return `<w:tr>${isHeaderRow ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cellsXml}</w:tr>`
        })
        .join('')
      return `<w:tbl><w:tblPr><w:tblW w:w="${containerW}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="130" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="130" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${rowsXml}</w:tbl><w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr></w:p>`
    }
    case 'drawing': {
      const idx = ctx.drawingCounter++
      const strokes = Array.isArray(n.attrs?.strokes) ? n.attrs.strokes : []
      if (!strokes.length) return ''
      const asset = ctx.inputMedia[drawingKey(idx)]
      if (asset && asset.bytes.byteLength > 0) {
        const maxEmu = Math.min(MAX_IMG_EMU_W, Math.round((containerW / 1440) * 914400))
        return paragraph(addImage(ctx, asset.bytes, asset.mime, asset.width, asset.height, 'Drawing', maxEmu), '<w:spacing w:before="80" w:after="140"/><w:jc w:val="center"/>')
      }
      return paragraph(buildRun('✏️ Drawing', { italic: true, color: '6B6963' }), '<w:spacing w:before="60" w:after="120"/>')
    }
    case 'attachment': {
      const id = String(n.attrs?.id ?? '')
      const name = String(n.attrs?.name ?? 'Attachment')
      const mime = String(n.attrs?.mime ?? '')
      const size = formatFileSize(Number(n.attrs?.size ?? 0))
      const asset = id ? ctx.inputMedia[id] : undefined
      if (isImageMime(mime) && asset && asset.bytes.byteLength > 0 && /image\/(png|jpe?g|gif)/i.test(asset.mime)) {
        const maxEmu = Math.min(MAX_IMG_EMU_W, Math.round((containerW / 1440) * 914400))
        return paragraph(addImage(ctx, asset.bytes, asset.mime, asset.width, asset.height, name, maxEmu), '<w:spacing w:before="80" w:after="140"/><w:jc w:val="center"/>')
      }
      const icon = /^audio\//.test(mime) ? '🎙️' : mime === 'application/pdf' || /\.pdf$/i.test(name) ? '📕' : '📎'
      const label = size ? `${icon}  ${name} (${size})` : `${icon}  ${name}`
      return boxTable(paragraph(buildRun(label, { color: '2C2A26', sizeHalfPt: 20 }), '<w:spacing w:before="0" w:after="0"/>'), {
        fill: 'FAF9F6',
        borderColor: 'DEDCD4',
        leftColor: 'DEDCD4',
        leftSize: 6,
        width: containerW
      }) + '<w:p><w:pPr><w:spacing w:before="0" w:after="100"/></w:pPr></w:p>'
    }
    default:
      return kids.length ? renderDocxBlocks(kids, ctx, containerW, depth) : ''
  }
}

function fontName(font?: string): string {
  if (font === 'serif') return 'Georgia'
  if (font === 'mono') return 'Consolas'
  return 'Calibri'
}

function buildStylesXml(font?: string): string {
  const f = fontName(font)
  const sz = font === 'mono' ? 20 : 22
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>
        <w:color w:val="1B1A18"/>
        <w:sz w:val="${sz}"/>
        <w:szCs w:val="${sz}"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="141311"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="141311"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="141311"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="180" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="141311"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr>
  </w:style>
</w:styles>`
}

function buildNumberingXml(orderedNums: { numId: number; start: number }[]): string {
  const bullets = ['•', '◦', '▪', '•', '◦', '▪']
  const bulletLvls = bullets
    .map(
      (b, lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${b}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${480 + lvl * 360}" w:hanging="240"/></w:pPr></w:lvl>`
    )
    .join('')
  const numFmts = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman']
  const orderedLvls = numFmts
    .map(
      (fmt, lvl) =>
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%${lvl + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${480 + lvl * 360}" w:hanging="240"/></w:pPr></w:lvl>`
    )
    .join('')
  const numInstances = [
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
    ...orderedNums.map(
      (n) =>
        `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`
    )
  ].join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">${bulletLvls}</w:abstractNum>
  <w:abstractNum w:abstractNumId="1">${orderedLvls}</w:abstractNum>
  ${numInstances}
</w:numbering>`
}

/** Converts a Veyra Study note into a complete `.docx` file as a `Uint8Array`. */
export function noteToDocx(note: ExportNoteInput, media: ExportMedia = {}): Uint8Array {
  const ctx: DocxCtx = {
    rels: [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', target: 'styles.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering', target: 'numbering.xml' }
    ],
    media: [],
    orderedNums: [],
    nextRel: 3,
    nextDocPr: 1,
    drawingCounter: 0,
    inputMedia: media
  }

  const title = note.title?.trim() || 'Untitled'
  const titleText = note.icon ? `${note.icon}  ${title}` : title
  const bodyParts: string[] = [paragraph(buildRun(titleText), '<w:pStyle w:val="Title"/>')]

  const metaChunks: string[] = []
  if (note.subject) metaChunks.push(note.subject)
  if (note.tags?.length) metaChunks.push(note.tags.map((t) => `#${t}`).join('  '))
  const dateStr = formatExportDate(note.updatedAt)
  if (dateStr) metaChunks.push(dateStr)

  if (metaChunks.length) {
    bodyParts.push(
      paragraph(
        buildRun(metaChunks.join('   ·   '), { color: '6B6963', sizeHalfPt: 19 }),
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="8" w:color="E5E3DC"/></w:pBdr><w:spacing w:before="0" w:after="240"/>'
      )
    )
  } else {
    bodyParts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="E5E3DC"/></w:pBdr><w:spacing w:before="0" w:after="200"/></w:pPr></w:p>')
  }

  const docNodes = (d: unknown): ExportNode[] => {
    const n = d as ExportNode | null | undefined
    return n && Array.isArray(n.content) ? n.content : []
  }

  if (note.template === 'cornell') {
    const cueW = Math.round(CONTENT_W_TWIPS * 0.3)
    const noteW = CONTENT_W_TWIPS - cueW
    const label = (text: string) => paragraph(buildRun(text.toUpperCase(), { bold: true, color: '6B6963', sizeHalfPt: 17 }), '<w:spacing w:before="0" w:after="100"/>')
    const cuesBody = ensureCellEndsWithParagraph(label('Cues & questions') + renderDocxBlocks(docNodes(note.cues), ctx, cueW - 260))
    const notesBody = ensureCellEndsWithParagraph(label('Notes') + renderDocxBlocks(docNodes(note.content), ctx, noteW - 260))
    const summaryRow = hasDocContent(note.summary)
      ? `<w:tr><w:tc><w:tcPr><w:tcW w:w="${CONTENT_W_TWIPS}" w:type="dxa"/><w:gridSpan w:val="2"/><w:shd w:val="clear" w:color="auto" w:fill="F3F6FC"/></w:tcPr>${ensureCellEndsWithParagraph(label('Summary') + renderDocxBlocks(docNodes(note.summary), ctx, CONTENT_W_TWIPS - 260))}</w:tc></w:tr>`
      : ''
    bodyParts.push(
      `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_W_TWIPS}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D8D5CD"/></w:tblBorders><w:tblCellMar><w:top w:w="130" w:type="dxa"/><w:left w:w="150" w:type="dxa"/><w:bottom w:w="130" w:type="dxa"/><w:right w:w="150" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${cueW}"/><w:gridCol w:w="${noteW}"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="${cueW}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F7F6F2"/></w:tcPr>${cuesBody}</w:tc><w:tc><w:tcPr><w:tcW w:w="${noteW}" w:type="dxa"/></w:tcPr>${notesBody}</w:tc></w:tr>${summaryRow}</w:tbl>`
    )
  } else {
    bodyParts.push(renderDocxBlocks(docNodes(note.content), ctx, CONTENT_W_TWIPS))
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyParts.join('\n    ')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${ctx.rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${x(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('\n  ')}
</Relationships>`

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const imgExts = new Set(ctx.media.map((m) => m.ext))
  const extDefaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...(imgExts.has('png') ? ['<Default Extension="png" ContentType="image/png"/>'] : []),
    ...(imgExts.has('jpeg') ? ['<Default Extension="jpeg" ContentType="image/jpeg"/>'] : []),
    ...(imgExts.has('gif') ? ['<Default Extension="gif" ContentType="image/gif"/>'] : [])
  ].join('\n  ')

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${extDefaults}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`

  const entries: { name: string; data: Uint8Array }[] = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
    { name: '_rels/.rels', data: enc.encode(rootRelsXml) },
    { name: 'word/document.xml', data: enc.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(relsXml) },
    { name: 'word/styles.xml', data: enc.encode(buildStylesXml(note.font)) },
    { name: 'word/numbering.xml', data: enc.encode(buildNumberingXml(ctx.orderedNums)) },
    ...ctx.media.map((m) => ({ name: m.zipPath, data: m.bytes }))
  ]

  return createZip(entries)
}

/* =====================================================================
   VECTOR PDF 1.4 GENERATOR (Android & Web)
===================================================================== */

const PAGE_W = 595.28 // A4 pt
const PAGE_H = 841.89
const MARGIN_X = 50
const MARGIN_TOP = 54
const MARGIN_BOTTOM = 54
const CONTENT_W = PAGE_W - MARGIN_X * 2

type FontKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' // Regular, Bold, Italic, BoldItalic, Mono

interface PdfSpan {
  text: string
  font: FontKey
  size: number
  color?: [number, number, number]
  bg?: [number, number, number]
  underline?: boolean
  strike?: boolean
  code?: boolean
}

interface PdfImage {
  name: string
  bytes: Uint8Array
  width: number
  height: number
}

const WINANSI_MAP: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f // Ÿ
}

const SYMBOL_FALLBACK: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '≈': '~=',
  '∞': 'inf',
  '✓': '[x]',
  '✔': '[x]',
  '✗': '[ ]',
  '☐': '[ ]',
  '☑': '[x]',
  '▸': '>',
  '▾': 'v',
  '\u00a0': ' '
}

function toWinAnsiString(raw: string): string {
  let out = ''
  for (const ch of String(raw ?? '')) {
    if (SYMBOL_FALLBACK[ch]) {
      out += SYMBOL_FALLBACK[ch]
      continue
    }
    const cp = ch.codePointAt(0) ?? 32
    if (cp >= 0x20 && cp <= 0x7e) {
      out += ch
    } else if (cp >= 0xa0 && cp <= 0xff) {
      out += String.fromCharCode(cp)
    } else if (WINANSI_MAP[cp] !== undefined) {
      out += String.fromCharCode(WINANSI_MAP[cp])
    } else if (cp === 0x09) {
      out += '  '
    }
    // Characters outside WinAnsi (e.g. emojis) are omitted cleanly rather than producing garbled glyphs.
  }
  return out
}

function pdfEsc(winAnsi: string): string {
  let out = ''
  for (let i = 0; i < winAnsi.length; i++) {
    const c = winAnsi.charCodeAt(i)
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + winAnsi[i]
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0')
    else out += winAnsi[i]
  }
  return out
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '')
  if (h.length !== 6) return [0.11, 0.1, 0.09]
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
}

const rgb = (c: [number, number, number]) => `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)}`

/** Approximate character width factor in PDF Helvetica/Times/Courier metrics. */
function charWidth(ch: string, font: FontKey, size: number): number {
  if (font === 'F5') return size * 0.6
  const narrow = "ilI1.,;:'!|[]()tfrj "
  const wide = 'MWQG@%#&mwy'
  const factor = narrow.includes(ch) ? 0.34 : wide.includes(ch) ? 0.78 : ch >= 'A' && ch <= 'Z' ? 0.64 : 0.53
  return size * factor * (font === 'F2' || font === 'F4' ? 1.05 : 1)
}

function measureText(text: string, font: FontKey, size: number): number {
  let w = 0
  for (let i = 0; i < text.length; i++) w += charWidth(text[i], font, size)
  return w
}

function wrapSpans(spans: PdfSpan[], maxWidth: number): PdfSpan[][] {
  const lines: PdfSpan[][] = []
  let line: PdfSpan[] = []
  let lineW = 0

  const flush = () => {
    lines.push(line)
    line = []
    lineW = 0
  }

  for (const sp of spans) {
    if (sp.text === '\n') {
      flush()
      continue
    }
    const clean = toWinAnsiString(sp.text)
    if (!clean) continue
    const tokens = clean.split(/(\s+)/).filter(Boolean)
    for (const tok of tokens) {
      const tw = measureText(tok, sp.font, sp.size)
      if (lineW > 0 && lineW + tw > maxWidth) {
        if (/^\s+$/.test(tok)) {
          flush()
          continue
        }
        flush()
      }
      if (tw > maxWidth) {
        // Hard-break long unbreakable tokens (e.g. URLs)
        let part = ''
        let pw = 0
        for (const ch of tok) {
          const cw = charWidth(ch, sp.font, sp.size)
          if (pw + cw > maxWidth && part) {
            line.push({ ...sp, text: part })
            flush()
            part = ch
            pw = cw
          } else {
            part += ch
            pw += cw
          }
        }
        if (part) {
          line.push({ ...sp, text: part })
          lineW += pw
        }
      } else {
        line.push({ ...sp, text: tok })
        lineW += tw
      }
    }
  }
  if (line.length || !lines.length) lines.push(line)
  return lines
}

class PdfWriter {
  pages: string[][] = [[]]
  pageIdx = 0
  y = PAGE_H - MARGIN_TOP
  images: PdfImage[] = []
  drawingCounter = 0

  get ops(): string[] {
    return this.pages[this.pageIdx]
  }

  newPage() {
    this.pages.push([])
    this.pageIdx = this.pages.length - 1
    this.y = PAGE_H - MARGIN_TOP
  }

  ensureSpace(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.newPage()
  }

  rect(x: number, yBottom: number, w: number, h: number, fill?: [number, number, number], stroke?: [number, number, number], lineWidth = 0.7) {
    const parts = ['q']
    if (fill) parts.push(`${rgb(fill)} rg`)
    if (stroke) parts.push(`${lineWidth.toFixed(2)} w ${rgb(stroke)} RG`)
    parts.push(`${x.toFixed(2)} ${yBottom.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`)
    parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S')
    parts.push('Q')
    this.ops.push(parts.join(' '))
  }

  line(x1: number, y1: number, x2: number, y2: number, color: [number, number, number], width = 0.7, dashed = false) {
    const dash = dashed ? '[3 2] 0 d ' : ''
    this.ops.push(`q ${width.toFixed(2)} w ${dash}${rgb(color)} RG ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`)
  }

  drawText(x: number, yBaseline: number, text: string, font: FontKey, size: number, color: [number, number, number] = [0.11, 0.1, 0.09]) {
    if (!text) return
    this.ops.push(`BT /${font} ${size.toFixed(1)} Tf ${rgb(color)} rg 1 0 0 1 ${x.toFixed(2)} ${yBaseline.toFixed(2)} Tm (${pdfEsc(text)}) Tj ET`)
  }

  drawLines(lines: PdfSpan[][], x: number, lineHeight: number, defaultSize: number) {
    for (const ln of lines) {
      this.ensureSpace(lineHeight)
      const baseline = this.y - defaultSize * 0.85
      let cx = x
      for (const sp of ln) {
        const w = measureText(sp.text, sp.font, sp.size)
        if (sp.bg || sp.code) {
          const fill = sp.bg ?? [0.95, 0.95, 0.93]
          this.rect(cx - 1, baseline - sp.size * 0.22, w + 2, sp.size * 1.18, fill)
        }
        this.drawText(cx, baseline, sp.text, sp.font, sp.size, sp.color ?? [0.11, 0.1, 0.09])
        if (sp.underline) {
          this.line(cx, baseline - 1.5, cx + w, baseline - 1.5, sp.color ?? [0.15, 0.39, 0.92], 0.6)
        }
        if (sp.strike) {
          this.line(cx, baseline + sp.size * 0.3, cx + w, baseline + sp.size * 0.3, sp.color ?? [0.48, 0.47, 0.44], 0.65)
        }
        cx += w
      }
      this.y -= lineHeight
    }
  }

  addJpeg(bytes: Uint8Array, widthPx: number, heightPx: number, x: number, maxW: number, maxH = 380) {
    const name = `Im${this.images.length + 1}`
    this.images.push({ name, bytes, width: widthPx, height: heightPx })
    let w = Math.min(maxW, widthPx * 0.75)
    let h = (w * heightPx) / Math.max(1, widthPx)
    if (h > maxH) {
      h = maxH
      w = (h * widthPx) / Math.max(1, heightPx)
    }
    this.ensureSpace(h + 10)
    const drawX = x + Math.max(0, (maxW - w) / 2)
    const drawY = this.y - h
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${drawX.toFixed(2)} ${drawY.toFixed(2)} cm /${name} Do Q`)
    this.y -= h + 10
  }

  build(fontFamily: 'sans' | 'serif' | 'mono'): Uint8Array {
    // Add subtle page numbers to each page
    const total = this.pages.length
    for (let i = 0; i < total; i++) {
      const label = `${i + 1} / ${total}`
      const lw = measureText(label, 'F1', 8.5)
      this.pages[i].push(`BT /F1 8.5 Tf 0.55 0.54 0.51 rg 1 0 0 1 ${((PAGE_W - lw) / 2).toFixed(2)} 26.00 Tm (${pdfEsc(label)}) Tj ET`)
    }

    const baseFonts: Record<FontKey, string> =
      fontFamily === 'serif'
        ? { F1: 'Times-Roman', F2: 'Times-Bold', F3: 'Times-Italic', F4: 'Times-BoldItalic', F5: 'Courier' }
        : fontFamily === 'mono'
          ? { F1: 'Courier', F2: 'Courier-Bold', F3: 'Courier-Oblique', F4: 'Courier-BoldOblique', F5: 'Courier' }
          : { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Helvetica-Oblique', F4: 'Helvetica-BoldOblique', F5: 'Courier' }

    const objects: Uint8Array[] = []
    const enc = new TextEncoder()
    const addObj = (body: string | Uint8Array): number => {
      const id = objects.length + 1
      objects.push(typeof body === 'string' ? enc.encode(body) : body)
      return id
    }

    // Reserve 1 = Catalog, 2 = Pages
    objects.push(new Uint8Array(0), new Uint8Array(0))

    // Font objects (3..7)
    const fontIds: Record<FontKey, number> = {
      F1: addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts.F1} /Encoding /WinAnsiEncoding >>`),
      F2: addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts.F2} /Encoding /WinAnsiEncoding >>`),
      F3: addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts.F3} /Encoding /WinAnsiEncoding >>`),
      F4: addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts.F4} /Encoding /WinAnsiEncoding >>`),
      F5: addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFonts.F5} /Encoding /WinAnsiEncoding >>`)
    }

    // Image XObjects (JPEG /DCTDecode)
    const imgRefs: string[] = []
    for (const img of this.images) {
      const head = enc.encode(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`
      )
      const tail = enc.encode('\nendstream')
      const merged = new Uint8Array(head.byteLength + img.bytes.byteLength + tail.byteLength)
      merged.set(head, 0)
      merged.set(img.bytes, head.byteLength)
      merged.set(tail, head.byteLength + img.bytes.byteLength)
      const imgId = addObj(merged)
      imgRefs.push(`/${img.name} ${imgId} 0 R`)
    }

    const resources = `<< /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R /F4 ${fontIds.F4} 0 R /F5 ${fontIds.F5} 0 R >>${imgRefs.length ? ` /XObject << ${imgRefs.join(' ')} >>` : ''} >>`

    const pageIds: number[] = []
    for (const ops of this.pages) {
      const stream = ops.join('\n')
      const streamBytes = enc.encode(stream)
      const head = enc.encode(`<< /Length ${streamBytes.byteLength} >>\nstream\n`)
      const tail = enc.encode('\nendstream')
      const contentBuf = new Uint8Array(head.byteLength + streamBytes.byteLength + tail.byteLength)
      contentBuf.set(head, 0)
      contentBuf.set(streamBytes, head.byteLength)
      contentBuf.set(tail, head.byteLength + streamBytes.byteLength)
      const contentId = addObj(contentBuf)
      const pageId = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources ${resources} /Contents ${contentId} 0 R >>`)
      pageIds.push(pageId)
    }

    objects[0] = enc.encode('<< /Type /Catalog /Pages 2 0 R >>')
    objects[1] = enc.encode(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)

    // Serialize PDF with xref table
    const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n%\xff\xff\xff\xff\n')]
    const offsets: number[] = [0]
    let pos = chunks[0].byteLength
    for (let i = 0; i < objects.length; i++) {
      offsets.push(pos)
      const pre = enc.encode(`${i + 1} 0 obj\n`)
      const post = enc.encode('\nendobj\n')
      chunks.push(pre, objects[i], post)
      pos += pre.byteLength + objects[i].byteLength + post.byteLength
    }
    const xrefPos = pos
    const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`]
    for (let i = 1; i <= objects.length; i++) {
      xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
    }
    xrefLines.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
    const xrefBytes = enc.encode(xrefLines.join(''))
    chunks.push(xrefBytes)
    pos += xrefBytes.byteLength

    const out = new Uint8Array(pos)
    let cursor = 0
    for (const c of chunks) {
      out.set(c, cursor)
      cursor += c.byteLength
    }
    return out
  }
}

function inlineToSpans(nodes: ExportNode[] = [], base: { size: number; bold?: boolean; italic?: boolean; color?: [number, number, number]; strike?: boolean }): PdfSpan[] {
  const out: PdfSpan[] = []
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push({ text: '\n', font: 'F1', size: base.size })
      continue
    }
    if (n.type !== 'text') {
      if (n.content) out.push(...inlineToSpans(n.content, base))
      continue
    }
    let bold = !!base.bold
    let italic = !!base.italic
    let underline = false
    let strike = !!base.strike
    let code = false
    let color = base.color
    let bg: [number, number, number] | undefined
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') bold = true
      else if (m.type === 'italic') italic = true
      else if (m.type === 'underline') underline = true
      else if (m.type === 'strike') strike = true
      else if (m.type === 'code') code = true
      else if (m.type === 'highlight') bg = hexToRgb(resolveHighlightHex(m.attrs?.color))
      else if (m.type === 'link') {
        underline = true
        color = [0.145, 0.388, 0.922]
      }
    }
    const font: FontKey = code ? 'F5' : bold && italic ? 'F4' : bold ? 'F2' : italic ? 'F3' : 'F1'
    out.push({ text: n.text ?? '', font, size: code ? base.size * 0.9 : base.size, color, bg, underline, strike, code })
  }
  return out
}

function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
}

function renderPdfBlocks(w: PdfWriter, nodes: ExportNode[] = [], media: ExportMedia, x: number, width: number, depth = 0) {
  for (const n of nodes) renderPdfBlock(w, n, media, x, width, depth)
}

function renderPdfBlock(w: PdfWriter, n: ExportNode, media: ExportMedia, x: number, width: number, depth = 0) {
  const kids = n.content ?? []
  switch (n.type) {
    case 'paragraph': {
      const spans = inlineToSpans(kids, { size: 10.5 })
      const lines = wrapSpans(spans, width)
      w.drawLines(lines, x, 15.5, 10.5)
      w.y -= 5
      break
    }
    case 'heading': {
      const lvl = Math.max(1, Math.min(3, Number(n.attrs?.level) || 1))
      const sz = lvl === 1 ? 16 : lvl === 2 ? 13 : 11.5
      const lh = sz * 1.35
      w.y -= lvl === 1 ? 10 : 7
      w.ensureSpace(lh + 22)
      const lines = wrapSpans(inlineToSpans(kids, { size: sz, bold: true }), width)
      w.drawLines(lines, x, lh, sz)
      w.y -= 4
      break
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList'
      const start = Math.max(1, Math.round(Number(n.attrs?.start) || 1))
      const indent = 16
      kids.forEach((li, idx) => {
        const marker = ordered ? `${start + idx}.` : toWinAnsiString('•')
        const liKids = li.content ?? []
        let first = true
        for (const child of liKids) {
          if (first && child.type === 'paragraph') {
            first = false
            const lines = wrapSpans(inlineToSpans(child.content, { size: 10.5 }), width - indent)
            w.ensureSpace(15.5)
            w.drawText(x + 2, w.y - 10.5 * 0.85, marker, 'F1', 10.5, [0.42, 0.41, 0.39])
            w.drawLines(lines, x + indent, 15.5, 10.5)
            w.y -= 2.5
          } else {
            renderPdfBlock(w, child, media, x + indent, width - indent, depth + 1)
          }
        }
      })
      w.y -= 4
      break
    }
    case 'taskList': {
      const indent = 18
      for (const li of kids) {
        const checked = !!li.attrs?.checked
        const liKids = li.content ?? []
        let first = true
        for (const child of liKids) {
          if (first && child.type === 'paragraph') {
            first = false
            const lines = wrapSpans(
              inlineToSpans(child.content, { size: 10.5, strike: checked, color: checked ? [0.48, 0.47, 0.44] : undefined }),
              width - indent
            )
            w.ensureSpace(16)
            const boxY = w.y - 11.5
            if (checked) {
              w.rect(x + 1, boxY, 9.5, 9.5, [0.086, 0.639, 0.29], [0.086, 0.639, 0.29], 0.8)
              // Vector checkmark
              w.ops.push(`q 1.2 w 1 1 1 RG ${(x + 3.1).toFixed(2)} ${(boxY + 4.8).toFixed(2)} m ${(x + 4.9).toFixed(2)} ${(boxY + 2.7).toFixed(2)} l ${(x + 8.3).toFixed(2)} ${(boxY + 7.2).toFixed(2)} l S Q`)
            } else {
              w.rect(x + 1, boxY, 9.5, 9.5, undefined, [0.55, 0.54, 0.51], 0.9)
            }
            w.drawLines(lines, x + indent, 15.5, 10.5)
            w.y -= 3
          } else {
            renderPdfBlock(w, child, media, x + indent, width - indent, depth + 1)
          }
        }
      }
      w.y -= 4
      break
    }
    case 'blockquote': {
      const startPage = w.pageIdx
      const startY = w.y
      for (const k of kids) {
        if (k.type === 'paragraph') {
          const lines = wrapSpans(inlineToSpans(k.content, { size: 10.5, italic: true, color: [0.34, 0.33, 0.31] }), width - 16)
          w.drawLines(lines, x + 14, 15.5, 10.5)
          w.y -= 3
        } else {
          renderPdfBlock(w, k, media, x + 14, width - 16, depth)
        }
      }
      if (w.pageIdx === startPage && startY > w.y) {
        w.line(x + 3, startY - 2, x + 3, w.y + 4, [0.79, 0.78, 0.74], 2.2)
      }
      w.y -= 5
      break
    }
    case 'callout': {
      const c = calloutMeta(n.attrs?.tone)
      const bg = hexToRgb(c.bg)
      const border = hexToRgb(c.border)
      const titleColor = hexToRgb(c.title)
      const innerLines = kids.flatMap((k) =>
        k.type === 'paragraph' ? wrapSpans(inlineToSpans(k.content, { size: 10 }), width - 24) : wrapSpans([{ text: plainText(k), font: 'F1', size: 10 }], width - 24)
      )
      const boxH = 14 + 14 + Math.max(1, innerLines.length) * 14.5 + 8
      w.ensureSpace(Math.min(boxH, 260))
      const topY = w.y
      const drawH = Math.min(boxH, topY - MARGIN_BOTTOM)
      w.rect(x, topY - drawH, width, drawH, bg)
      w.rect(x, topY - drawH, 3.2, drawH, border)
      w.y -= 10
      w.drawText(x + 12, w.y - 9, c.label, 'F2', 9.8, titleColor)
      w.y -= 15
      w.drawLines(innerLines, x + 12, 14.5, 10)
      w.y = Math.min(w.y - 8, topY - drawH - 8)
      break
    }
    case 'details': {
      const summary = kids.find((k) => k.type === 'detailsSummary')
      const content = kids.find((k) => k.type === 'detailsContent')
      const qLines = wrapSpans(inlineToSpans(summary?.content, { size: 10.5, bold: true }), width - 22)
      const aLines = (content?.content ?? []).flatMap((k) => wrapSpans(inlineToSpans(k.content, { size: 10 }), width - 22))
      const boxH = 16 + qLines.length * 15 + (aLines.length ? 10 + aLines.length * 14.5 : 0)
      w.ensureSpace(Math.min(boxH, 260))
      const topY = w.y
      const drawH = Math.min(boxH, topY - MARGIN_BOTTOM)
      w.rect(x, topY - drawH, width, drawH, undefined, [0.87, 0.86, 0.83], 0.8)
      w.y -= 9
      w.drawLines(qLines, x + 10, 15, 10.5)
      if (aLines.length) {
        w.line(x + 10, w.y - 2, x + width - 10, w.y - 2, [0.87, 0.86, 0.83], 0.6, true)
        w.y -= 8
        w.drawLines(aLines, x + 10, 14.5, 10)
      }
      w.y = Math.min(w.y - 8, topY - drawH - 8)
      break
    }
    case 'codeBlock': {
      const text = kids.map((k) => k.text ?? '').join('')
      const rawLines = text.split('\n')
      const wrapped: PdfSpan[][] = []
      for (const rl of rawLines) {
        wrapped.push(...wrapSpans([{ text: rl || ' ', font: 'F5', size: 9, color: [0.16, 0.15, 0.14] }], width - 20))
      }
      const boxH = wrapped.length * 13 + 14
      w.ensureSpace(Math.min(boxH, 240))
      const topY = w.y
      const drawH = Math.min(boxH, topY - MARGIN_BOTTOM)
      w.rect(x, topY - drawH, width, drawH, [0.965, 0.96, 0.945], [0.9, 0.89, 0.86], 0.6)
      w.y -= 8
      w.drawLines(wrapped, x + 10, 13, 9)
      w.y = Math.min(w.y - 8, topY - drawH - 8)
      break
    }
    case 'horizontalRule': {
      w.y -= 6
      w.ensureSpace(12)
      w.line(x, w.y, x + width, w.y, [0.87, 0.86, 0.83], 0.8)
      w.y -= 10
      break
    }
    case 'table': {
      if (!kids.length) break
      const cols = Math.max(1, ...kids.map((r) => (r.content ?? []).length))
      const colW = width / cols
      for (const row of kids) {
        const cells = row.content ?? []
        const isHeader = cells.length > 0 && cells.every((c) => c.type === 'tableHeader')
        const cellLines = cells.map((c) =>
          wrapSpans(
            [{ text: plainText(c), font: isHeader ? 'F2' : 'F1', size: 9.5 }],
            Math.max(30, colW - 12)
          )
        )
        const maxLines = Math.max(1, ...cellLines.map((l) => l.length))
        const rowH = maxLines * 13.5 + 10
        w.ensureSpace(rowH)
        const rowBottom = w.y - rowH
        for (let ci = 0; ci < cols; ci++) {
          const cx = x + ci * colW
          w.rect(cx, rowBottom, colW, rowH, isHeader ? [0.953, 0.949, 0.929] : undefined, [0.85, 0.835, 0.804], 0.6)
          const savedY = w.y
          w.y = savedY - 5
          const ln = cellLines[ci] ?? []
          for (const lineSpans of ln) {
            let tx = cx + 6
            const base = w.y - 9.5 * 0.85
            for (const sp of lineSpans) {
              w.drawText(tx, base, sp.text, sp.font, sp.size)
              tx += measureText(sp.text, sp.font, sp.size)
            }
            w.y -= 13.5
          }
          w.y = savedY
        }
        w.y = rowBottom
      }
      w.y -= 10
      break
    }
    case 'drawing': {
      const idx = w.drawingCounter++
      const strokes = Array.isArray(n.attrs?.strokes) ? n.attrs.strokes : []
      if (!strokes.length) break
      const asset = media[drawingKey(idx)]
      if (asset && isJpegBytes(asset.bytes)) {
        const dims = asset.width && asset.height ? { width: asset.width, height: asset.height } : parseImageDimensions(asset.bytes) ?? { width: 1000, height: 600 }
        w.addJpeg(asset.bytes, dims.width, dims.height, x, width, 360)
      } else {
        w.drawLines(wrapSpans([{ text: '[Drawing]', font: 'F3', size: 10, color: [0.45, 0.44, 0.41] }], width), x, 14, 10)
        w.y -= 5
      }
      break
    }
    case 'attachment': {
      const id = String(n.attrs?.id ?? '')
      const name = String(n.attrs?.name ?? 'Attachment')
      const mime = String(n.attrs?.mime ?? '')
      const size = formatFileSize(Number(n.attrs?.size ?? 0))
      const asset = id ? media[id] : undefined
      if (isImageMime(mime) && asset && isJpegBytes(asset.bytes)) {
        const dims = asset.width && asset.height ? { width: asset.width, height: asset.height } : parseImageDimensions(asset.bytes) ?? { width: 800, height: 600 }
        w.addJpeg(asset.bytes, dims.width, dims.height, x, width, 380)
      } else {
        const label = size ? `Attachment: ${name} (${size})` : `Attachment: ${name}`
        w.ensureSpace(24)
        w.rect(x, w.y - 20, width, 20, [0.98, 0.976, 0.965], [0.87, 0.86, 0.83], 0.6)
        w.drawText(x + 8, w.y - 13.5, toWinAnsiString(label).slice(0, 100), 'F1', 9.5, [0.22, 0.21, 0.19])
        w.y -= 26
      }
      break
    }
    default:
      if (kids.length) renderPdfBlocks(w, kids, media, x, width, depth)
  }
}

function plainText(n: ExportNode): string {
  const parts: string[] = []
  const walk = (node: ExportNode) => {
    if (node.type === 'text' && node.text) parts.push(node.text)
    if (node.content) node.content.forEach(walk)
  }
  walk(n)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Converts a Veyra Study note into a binary PDF 1.4 document (`Uint8Array`). */
export function noteToPdf(note: ExportNoteInput, media: ExportMedia = {}): Uint8Array {
  const w = new PdfWriter()
  const title = note.title?.trim() || 'Untitled'

  // Header
  const titleLines = wrapSpans([{ text: title, font: 'F2', size: 20 }], CONTENT_W)
  w.drawLines(titleLines, MARGIN_X, 25, 20)

  const metaChunks: string[] = []
  if (note.subject) metaChunks.push(note.subject)
  if (note.tags?.length) metaChunks.push(note.tags.map((t) => `#${t}`).join('  '))
  const dateStr = formatExportDate(note.updatedAt)
  if (dateStr) metaChunks.push(dateStr)

  if (metaChunks.length) {
    w.y -= 2
    const metaLines = wrapSpans([{ text: metaChunks.join('  •  '), font: 'F1', size: 9.2, color: [0.42, 0.41, 0.39] }], CONTENT_W)
    w.drawLines(metaLines, MARGIN_X, 13, 9.2)
  }
  w.y -= 4
  w.line(MARGIN_X, w.y, MARGIN_X + CONTENT_W, w.y, [0.9, 0.89, 0.86], 0.8)
  w.y -= 14

  const docNodes = (d: unknown): ExportNode[] => {
    const n = d as ExportNode | null | undefined
    return n && Array.isArray(n.content) ? n.content : []
  }

  if (note.template === 'cornell') {
    const cues = docNodes(note.cues)
    const notes = docNodes(note.content)
    const summary = docNodes(note.summary)
    if (hasDocContent(note.cues)) {
      w.drawText(MARGIN_X, w.y - 9, 'CUES & QUESTIONS', 'F2', 8.5, [0.42, 0.41, 0.39])
      w.y -= 15
      renderPdfBlocks(w, cues, media, MARGIN_X + 8, CONTENT_W - 8)
      w.line(MARGIN_X, w.y, MARGIN_X + CONTENT_W, w.y, [0.87, 0.86, 0.83], 0.6)
      w.y -= 12
    }
    w.drawText(MARGIN_X, w.y - 9, 'NOTES', 'F2', 8.5, [0.42, 0.41, 0.39])
    w.y -= 15
    renderPdfBlocks(w, notes, media, MARGIN_X, CONTENT_W)
    if (hasDocContent(note.summary)) {
      w.y -= 4
      w.line(MARGIN_X, w.y, MARGIN_X + CONTENT_W, w.y, [0.87, 0.86, 0.83], 0.6)
      w.y -= 12
      w.drawText(MARGIN_X, w.y - 9, 'SUMMARY', 'F2', 8.5, [0.22, 0.34, 0.56])
      w.y -= 15
      renderPdfBlocks(w, summary, media, MARGIN_X, CONTENT_W)
    }
  } else {
    renderPdfBlocks(w, docNodes(note.content), media, MARGIN_X, CONTENT_W)
  }

  return w.build(note.font ?? 'sans')
}
