/**
 * Desktop note export helpers (main process):
 *  - Binary file export (Word .docx and any generated binary files) via native Save / Folder dialog.
 *  - Native Chromium PDF export via a hidden, sandboxed BrowserWindow (`javascript: false`)
 *    and `webContents.printToPDF` for crisp vector text, SVG drawings, emoji, and CSS layout.
 */
import { BrowserWindow, dialog } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeFileName } from '../shared/note-export'
import { FileError } from './files'

const MAX_HTML_BYTES = 30 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024

function cleanExt(ext: string): string {
  const c = String(ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8)
  return c || 'bin'
}

function uniqueBase(name: string, used: Set<string>): string {
  const clean = safeFileName(name)
  let base = clean
  for (let i = 2; used.has(base.toLowerCase()); i++) base = `${clean} (${i})`
  used.add(base.toLowerCase())
  return base
}

export async function exportBinaryFiles(
  files: { name: string; ext: string; bytes: Uint8Array }[],
  kindLabel: string
): Promise<{ saved: number }> {
  if (!Array.isArray(files) || !files.length) return { saved: 0 }
  const label = String(kindLabel || 'Document').slice(0, 60)
  if (files.length === 1) {
    const f = files[0]
    if (!(f?.bytes instanceof Uint8Array) || f.bytes.byteLength > MAX_FILE_BYTES) throw new FileError('That file is too large to export.')
    const ext = cleanExt(f.ext)
    const res = await dialog.showSaveDialog({
      title: 'Export note',
      defaultPath: `${safeFileName(f.name)}.${ext}`,
      filters: [{ name: label, extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return { saved: 0 }
    writeFileSync(res.filePath, Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength))
    return { saved: 1 }
  }
  const res = await dialog.showOpenDialog({
    title: `Choose a folder for ${files.length} notes`,
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return { saved: 0 }
  const used = new Set<string>()
  let saved = 0
  for (const f of files) {
    if (!(f?.bytes instanceof Uint8Array) || f.bytes.byteLength > MAX_FILE_BYTES) continue
    const ext = cleanExt(f.ext)
    const base = uniqueBase(f.name, used)
    writeFileSync(join(res.filePaths[0], `${base}.${ext}`), Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength))
    saved++
  }
  return { saved }
}

/** Renders one or more print-ready HTML strings to PDF buffers using an isolated hidden BrowserWindow. */
export async function renderHtmlListToPdf(htmlList: string[]): Promise<Buffer[]> {
  const dir = mkdtempSync(join(tmpdir(), 'veyra-pdf-'))
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({
      show: false,
      width: 794,
      height: 1123,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        javascript: false,
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    const out: Buffer[] = []
    for (let i = 0; i < htmlList.length; i++) {
      const html = String(htmlList[i] ?? '')
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
        throw new FileError('This note is too large to export as PDF.')
      }
      const tmpHtml = join(dir, `note-${i}.html`)
      writeFileSync(tmpHtml, html, 'utf8')
      await win.loadFile(tmpHtml)
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.55, bottom: 0.65, left: 0.55, right: 0.55 },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="width:100%;font-size:9px;color:#7a7871;text-align:center;font-family:system-ui,-apple-system,sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        generateDocumentOutline: true
      })
      out.push(pdf)
    }
    return out
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function exportPdfFiles(files: { name: string; html: string }[]): Promise<{ saved: number }> {
  if (!Array.isArray(files) || !files.length) return { saved: 0 }
  if (files.length === 1) {
    const res = await dialog.showSaveDialog({
      title: 'Export note as PDF',
      defaultPath: `${safeFileName(files[0].name)}.pdf`,
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return { saved: 0 }
    const [pdf] = await renderHtmlListToPdf([files[0].html])
    writeFileSync(res.filePath, pdf)
    return { saved: 1 }
  }
  const res = await dialog.showOpenDialog({
    title: `Choose a folder for ${files.length} PDFs`,
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return { saved: 0 }
  const pdfs = await renderHtmlListToPdf(files.map((f) => f.html))
  const used = new Set<string>()
  for (let i = 0; i < files.length; i++) {
    const base = uniqueBase(files[i].name, used)
    writeFileSync(join(res.filePaths[0], `${base}.pdf`), pdfs[i])
  }
  return { saved: files.length }
}
