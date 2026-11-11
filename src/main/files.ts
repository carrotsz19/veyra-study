/**
 * Files attached to notes (PDFs, images, slides…). Each is copied into the
 * account's own attachments folder under a random name, and notes point at
 * it by that name. The UI shows them through the veyra-file:// protocol,
 * which only ever serves files from that folder.
 */
import { app, dialog, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, extname, join, resolve, sep } from 'node:path'
import { accountDir } from './account'

export interface Attachment {
  /** File name in the attachments folder: a UUID plus the extension. */
  id: string
  name: string
  mime: string
  size: number
}

export class FileError extends Error {}

const MAX_FILE = 200 * 1024 * 1024
const MAX_PASTE = 25 * 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', zip: 'application/zip'
}
const extOf = (name: string) => extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
export const mimeOf = (name: string) => MIME[extOf(name)] ?? 'application/octet-stream'
const EXT_FOR_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Must be called before app is ready. */
export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'veyra-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

/** The attachments folder for one account (or for data without an account). */
export const attachmentsDir = (folder: string | null) => (folder ? join(accountDir(folder), 'attachments') : join(app.getPath('userData'), 'attachments'))

export class Files {
  /** `folder` is looked up on every use: people switch accounts without restarting. */
  constructor(private folder: () => string | null) {}

  private dir(): string {
    const d = attachmentsDir(this.folder())
    mkdirSync(d, { recursive: true })
    return d
  }

  /** Full path of an attachment, or null if the id isn't one of ours. */
  private pathOf(id: string): string | null {
    if (!ID.test(id)) return null
    const d = this.dir()
    const p = resolve(d, id)
    return p.startsWith(resolve(d) + sep) ? p : null
  }

  /** Serves veyra-file://f/<id> to the window. */
  handleProtocol(): void {
    protocol.handle('veyra-file', (req) => {
      const id = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''))
      const p = this.pathOf(id)
      if (!p || !existsSync(p)) return new Response('Not found', { status: 404 })
      // Byte ranges, so audio and video players can find the length and seek.
      const size = statSync(p).size
      const type = mimeOf(p)
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
      if (m && size > 0) {
        let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2] || 0))
        let end = m[1] && m[2] ? Number(m[2]) : size - 1
        end = Math.min(end, size - 1)
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        start = Math.max(0, start)
        const body = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream
        return new Response(body, { status: 206, headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } })
      }
      const body = Readable.toWeb(createReadStream(p)) as ReadableStream
      return new Response(body, { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
    })
  }

  fromPath(path: string): Attachment {
    let st
    try {
      st = statSync(path)
    } catch {
      throw new FileError('That file couldn’t be read.')
    }
    if (!st.isFile()) throw new FileError('Folders can’t be attached. Pick files instead.')
    if (st.size > MAX_FILE) throw new FileError(`“${basename(path)}” is over 200 MB, which is too big to attach.`)
    const name = basename(path)
    const id = `${randomUUID()}.${extOf(name)}`
    copyFileSync(path, join(this.dir(), id))
    return { id, name, mime: mimeOf(name), size: st.size }
  }

  fromPaths(paths: string[]): Attachment[] {
    return paths.filter((p) => typeof p === 'string' && p).slice(0, 50).map((p) => this.fromPath(p))
  }

  /** A pasted image (it has no file on disk). */
  fromBytes(name: string, mime: string, bytes: Uint8Array): Attachment {
    if (!(bytes instanceof Uint8Array)) throw new FileError('That couldn’t be pasted.')
    if (bytes.byteLength > MAX_PASTE) throw new FileError('That’s over 25 MB, which is too big to paste. Save it and attach the file instead.')
    const ext = EXT_FOR_MIME[mime] ?? extOf(name)
    const clean = (String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || `Pasted image.${ext}`).slice(0, 120)
    const id = `${randomUUID()}.${ext}`
    writeFileSync(join(this.dir(), id), bytes)
    return { id, name: clean, mime: MIME[ext] ?? mime ?? 'application/octet-stream', size: bytes.byteLength }
  }

  /** A file downloaded from somewhere else (Google Drive). */
  fromDownload(name: string, mime: string, bytes: Uint8Array): Attachment {
    if (bytes.byteLength > MAX_FILE) throw new FileError(`“${name}” is over 200 MB, which is too big to attach.`)
    const clean = (String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'File').slice(0, 160)
    const id = `${randomUUID()}.${extOf(clean)}`
    writeFileSync(join(this.dir(), id), bytes)
    return { id, name: clean, mime: MIME[extOf(clean)] ?? mime ?? 'application/octet-stream', size: bytes.byteLength }
  }

  async pick(): Promise<Attachment[]> {
    const r = await dialog.showOpenDialog({ title: 'Attach files to this note', properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return []
    return this.fromPaths(r.filePaths)
  }

  async open(id: string): Promise<void> {
    const p = this.pathOf(id)
    if (!p || !existsSync(p)) throw new FileError('That file isn’t on this computer.')
    const err = await shell.openPath(p)
    if (err) throw new FileError('No app on this computer opens that kind of file.')
  }

  reveal(id: string): void {
    const p = this.pathOf(id)
    if (p && existsSync(p)) shell.showItemInFolder(p)
  }

  /** The file's bytes (for transcribing a recording). */
  read(id: string): Uint8Array {
    const p = this.pathOf(id)
    if (!p || !existsSync(p)) throw new FileError('That file isn’t on this computer.')
    if (statSync(p).size > 1024 * 1024 * 1024) throw new FileError('That recording is too long to transcribe (over 1 GB).')
    return new Uint8Array(readFileSync(p))
  }

  /** Full path, for uploading to Drive (main process only). */
  localPath(id: string): string | null {
    const p = this.pathOf(id)
    return p && existsSync(p) ? p : null
  }
}
