/**
 * Renderer-side orchestrator for exporting notes to PDF, Word (.docx), and Markdown.
 * Resolves embedded image attachments and rasterizes drawings when needed so exports
 * preserve the full visual richness of notes across Desktop, Android, and Web.
 */
import {
  drawingKey,
  isImageMime,
  noteToDocx,
  noteToExportHtml,
  noteToPdf,
  type ExportFormat,
  type ExportMedia,
  type ExportNode,
  type ExportNoteInput,
  type ExportStroke
} from '@shared/note-export'
import { noteToMarkdown } from './markdown'
import { isRemoteFile } from './attachment'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PDF_MIME = 'application/pdf'

/** Rasterizes a drawing's strokes onto a white-backed 2x canvas as PNG or JPEG bytes. */
async function rasterizeDrawing(
  strokes: ExportStroke[],
  height: number,
  targetMime: 'image/png' | 'image/jpeg'
): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number } | null> {
  if (typeof document === 'undefined' || !strokes.length) return null
  const W = 1000
  const H = Math.max(120, Math.min(4000, Number(height) || 600))
  const scale = 1.5
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(H * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (const s of strokes) {
    const p = Array.isArray(s.p) ? s.p : []
    if (p.length < 3) continue
    const col = s.c === 'ink' || !s.c ? '#1b1a18' : s.c
    ctx.strokeStyle = col
    ctx.fillStyle = col
    ctx.globalAlpha = s.h ? 0.35 : 1
    ctx.lineCap = s.h ? 'butt' : 'round'
    ctx.lineJoin = 'round'
    if (p.length === 3) {
      ctx.beginPath()
      ctx.arc(p[0] * scale, p[1] * scale, ((s.w || 4) * (0.5 + p[2]) * scale) / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    for (let i = 3; i < p.length; i += 3) {
      ctx.beginPath()
      ctx.lineWidth = Math.max(0.8, s.h ? (s.w || 4) * 4 * scale : (s.w || 4) * (0.4 + p[i + 2]) * scale)
      const x0 = p[i - 3], y0 = p[i - 2], x1 = p[i], y1 = p[i + 1]
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
      if (i === 3) ctx.moveTo(x0 * scale, y0 * scale)
      else ctx.moveTo(((p[i - 6] + x0) / 2) * scale, ((p[i - 5] + y0) / 2) * scale)
      ctx.quadraticCurveTo(x0 * scale, y0 * scale, mx * scale, my * scale)
      if (i === p.length - 3) ctx.lineTo(x1 * scale, y1 * scale)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, targetMime, targetMime === 'image/jpeg' ? 0.9 : undefined))
  if (!blob) return null
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: targetMime, width: canvas.width, height: canvas.height }
}

/** Converts an image blob to PNG or white-backed JPEG via an offscreen canvas (for Word / fallback PDF). */
async function transcodeImage(
  bytes: Uint8Array,
  srcMime: string,
  targetMime: 'image/png' | 'image/jpeg'
): Promise<{ bytes: Uint8Array; mime: string; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: srcMime || 'image/png' }))
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Image decode failed'))
      el.src = url
    })
    const w = img.naturalWidth || img.width || 800
    const h = img.naturalHeight || img.height || 600
    const maxDim = 2000
    const ratio = Math.min(1, maxDim / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * ratio))
    const ch = Math.max(1, Math.round(h * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    if (targetMime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, cw, ch)
    }
    ctx.drawImage(img, 0, 0, cw, ch)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, targetMime, targetMime === 'image/jpeg' ? 0.88 : undefined))
    if (!blob) return null
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: targetMime, width: cw, height: ch }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Walks a note's TipTap docs in export order to load image attachments and rasterize drawings. */
async function collectNoteMedia(
  note: ExportNoteInput,
  mode: 'html' | 'docx' | 'pdf-fallback'
): Promise<ExportMedia> {
  const media: ExportMedia = {}
  const imageIds = new Map<string, string>()
  const drawings: { key: string; strokes: ExportStroke[]; height: number }[] = []
  let drawingIdx = 0

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as ExportNode
    if (n.type === 'attachment' && n.attrs?.id) {
      const id = String(n.attrs.id)
      const mime = String(n.attrs.mime ?? '')
      if (isImageMime(mime) && !isRemoteFile(id) && !imageIds.has(id)) imageIds.set(id, mime)
    } else if (n.type === 'drawing') {
      const key = drawingKey(drawingIdx++)
      const strokes = (Array.isArray(n.attrs?.strokes) ? n.attrs.strokes : []) as ExportStroke[]
      if (strokes.length && mode !== 'html') {
        drawings.push({ key, strokes, height: Number(n.attrs?.height) || 600 })
      }
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child)
    }
  }

  // Match the exact traversal order of export-docx.ts and export-pdf.ts (cues -> content -> summary for Cornell)
  if (note.template === 'cornell') {
    walk(note.cues)
    walk(note.content)
    walk(note.summary)
  } else {
    walk(note.content)
  }

  for (const [id, mime] of imageIds) {
    try {
      const raw = await window.veyra.files.read(id)
      if (!raw || !raw.byteLength) continue
      if (mode === 'html') {
        media[id] = { bytes: raw, mime }
      } else if (mode === 'docx') {
        if (/^image\/(png|jpe?g|gif)$/i.test(mime)) {
          media[id] = { bytes: raw, mime }
        } else {
          const converted = await transcodeImage(raw, mime, 'image/png')
          if (converted) media[id] = converted
        }
      } else {
        if (/^image\/jpe?g$/i.test(mime)) {
          media[id] = { bytes: raw, mime: 'image/jpeg' }
        } else {
          const converted = await transcodeImage(raw, mime, 'image/jpeg')
          if (converted) media[id] = converted
        }
      }
    } catch {
      // Missing local attachment on this device: skip image gracefully and fall back to card.
    }
  }

  for (const d of drawings) {
    const targetMime = mode === 'docx' ? 'image/png' : 'image/jpeg'
    const rendered = await rasterizeDrawing(d.strokes, d.height, targetMime)
    if (rendered) media[d.key] = rendered
  }

  return media
}

export async function exportNotesAs(notes: ExportNoteInput[], format: ExportFormat): Promise<number> {
  if (!notes.length) return 0

  if (format === 'md') {
    const r = await window.veyra.app.exportNotes(notes.map((n) => ({ name: n.title || 'Untitled', text: noteToMarkdown(n) })))
    return r.saved
  }

  if (format === 'docx') {
    const files: { name: string; ext: string; mime: string; bytes: Uint8Array }[] = []
    for (const n of notes) {
      const media = await collectNoteMedia(n, 'docx')
      files.push({
        name: n.title || 'Untitled',
        ext: 'docx',
        mime: DOCX_MIME,
        bytes: noteToDocx(n, media)
      })
    }
    const r = await window.veyra.app.exportFiles(files, 'Word Document')
    return r.saved
  }

  // PDF: Desktop Electron uses native Chromium printToPDF; Android & Web use the built-in vector PDF writer.
  if (window.veyra.app.exportPdf) {
    const htmlFiles: { name: string; html: string }[] = []
    for (const n of notes) {
      const media = await collectNoteMedia(n, 'html')
      htmlFiles.push({
        name: n.title || 'Untitled',
        html: noteToExportHtml(n, media)
      })
    }
    const r = await window.veyra.app.exportPdf(htmlFiles)
    return r.saved
  }

  const pdfFiles: { name: string; ext: string; mime: string; bytes: Uint8Array }[] = []
  for (const n of notes) {
    const media = await collectNoteMedia(n, 'pdf-fallback')
    pdfFiles.push({
      name: n.title || 'Untitled',
      ext: 'pdf',
      mime: PDF_MIME,
      bytes: noteToPdf(n, media)
    })
  }
  const r = await window.veyra.app.exportFiles(pdfFiles, 'PDF Document')
  return r.saved
}
