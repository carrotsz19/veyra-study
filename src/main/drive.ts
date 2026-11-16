/**
 * Google Drive, with the narrowest access Google offers (drive.file): Veyra
 * only sees files it made, or ones you pick with Google's file picker.
 *
 *  - Save to Google Docs: a note becomes a Google Doc in "Veyra Study"
 *    (saving again updates the same Doc).
 *  - Backup: every note as a Markdown file in "Veyra Study / Notes backup",
 *    uploaded when it changes; notes deleted in Veyra go to Drive's bin.
 *
 * Its own sign-in (drive.bin), separate from Calendar's, so either can be
 * connected alone. Disconnecting only forgets the token here: revoking it
 * at Google could also end Calendar's access, since both use one client.
 */
import { nativeImage, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { DriveBackupFile, DriveFound, DrivePicked, DriveRead, DriveState } from '../shared/types'
import { emailFromIdToken, googleSignIn, tokenRequest } from './google-oauth'
import type { Files } from './files'
import { shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email']
/**
 * Asked for only when someone lets the Assistant search and read their Drive (Settings →
 * Connections). Google calls it restricted: until the app is verified, people see Google's
 * "unverified app" page, and the app can have at most 100 users with it.
 */
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const GOOGLE_DOC = 'application/vnd.google-apps.document'
const MAX_DOWNLOAD = 10 * 1024 * 1024
const MAX_TEXT = 150_000
/** Dev checks can point Drive at a stand-in server. */
const BASE = (process.env['VEYRA_DRIVE_URL'] || 'https://www.googleapis.com').replace(/\/$/, '')
const FOLDER = 'application/vnd.google-apps.folder'

export class DriveError extends Error {}

interface Config {
  refreshToken?: string
  accessToken?: string
  accessExpires?: number
  email?: string
  folderId?: string
  backupFolderId?: string
  /** note id -> Google Doc id (Save to Google Docs). */
  docs: Record<string, string>
  backup: boolean
  /** note id -> backup file id and the note's updatedAt when it was uploaded. */
  backups: Record<string, { fileId: string; updatedAt: number }>
  /** Note changes up to here are backed up (records.updated_at). */
  backupThrough: number
  lastBackup?: number
  error?: string
  /** What Google says was allowed (space-separated); missing for sign-ins before it was kept. */
  scope?: string
  /** The Assistant may search and read Drive (needs READ_SCOPE). */
  assistant?: boolean
}

const blank = (): Config => ({ docs: {}, backup: true, backups: {}, backupThrough: 0 })

export class GoogleDrive {
  private cfg: Config = blank()
  private disposed = false
  private busy: Promise<unknown> = Promise.resolve()
  private cancelPick: (() => void) | null = null

  constructor(
    private file: string,
    private files: Files
  ) {
    try {
      if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.cfg = { ...blank(), ...JSON.parse(safeStorage.decryptString(readFileSync(file))) }
    } catch {
      this.cfg = blank()
    }
  }

  dispose() {
    this.disposed = true
  }

  private save() {
    if (this.disposed || !safeStorage.isEncryptionAvailable()) return
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.cfg)))
  }

  /** One Drive job at a time (folder creation must not race). */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn)
    this.busy = run.catch(() => {})
    return run
  }

  state(): DriveState {
    const c = this.cfg
    return {
      builtIn: !!__GOOGLE_CLIENT__.id,
      connected: !!c.refreshToken,
      email: c.email ?? '',
      backup: c.backup,
      backupThrough: c.backupThrough,
      backedUp: Object.keys(c.backups).length,
      lastBackup: c.lastBackup,
      error: c.error,
      canPick: !!__GOOGLE_CLIENT__.apiKey,
      canRead: this.canRead(),
      assistant: !!c.assistant && this.canRead()
    }
  }
  private canRead = () => !!this.cfg.refreshToken && (this.cfg.scope ?? '').split(' ').includes(READ_SCOPE)

  /* ---------- sign-in ---------- */
  /** `read`: also let the Assistant search and read Drive (Google's page asks for that too). */
  async connect(read = false): Promise<DriveState> {
    if (!__GOOGLE_CLIENT__.id) throw new DriveError('This build has no Google client, so Drive can’t connect.')
    const scopes = read ? [...SCOPES, READ_SCOPE] : SCOPES
    // Dev checks: VEYRA_FAKE_DRIVE=1 skips Google's page (with VEYRA_GOOGLE_TOKEN_URL pointing at a stand-in).
    const tok = process.env['VEYRA_FAKE_DRIVE']
      ? { refresh_token: 'fake-refresh', access_token: 'fake-access', expires_in: 3600, id_token: undefined, scope: scopes.join(' ') }
      : await googleSignIn({ clientId: __GOOGLE_CLIENT__.id, clientSecret: __GOOGLE_CLIENT__.secret, scopes, what: 'Google Drive' }).catch((e) => {
          throw new DriveError(e instanceof Error ? e.message : 'Google sign-in didn’t finish.')
        })
    if (!tok.refresh_token) throw new DriveError('Google didn’t give Veyra lasting access. Remove Veyra in your Google account’s third-party access, then connect again.')
    // Without a scope in the answer, Google gave what was asked (older stand-ins).
    const granted = tok.scope ?? scopes.join(' ')
    this.cfg = {
      ...this.cfg,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessExpires: Date.now() + (tok.expires_in - 60) * 1000,
      email: emailFromIdToken(tok.id_token) || (process.env['VEYRA_FAKE_DRIVE'] ? 'test@example.com' : ''),
      error: undefined,
      scope: granted
    }
    this.cfg.assistant = read ? this.canRead() : !!this.cfg.assistant && this.canRead()
    this.save()
    if (read && !this.canRead()) throw new DriveError('Google Drive is connected, but the Assistant can’t read it: tick “See and download all your Google Drive files” on Google’s page to allow that.')
    return this.state()
  }

  /** Lets the Assistant use Drive, or stops it (the permission stays until you disconnect). */
  setAssistant(on: boolean): DriveState {
    this.cfg.assistant = !!on && this.canRead()
    this.save()
    return this.state()
  }

  /* ---------- the Assistant: search, read, make a Doc ---------- */
  private needRead() {
    if (!this.cfg.assistant || !this.canRead()) throw new DriveError('The Assistant isn’t allowed to read Google Drive. Turn it on in Settings → Connections → Google Drive.')
  }

  /** Files whose name or text has these words (or the most recently changed), newest first. */
  async search(query: string, limit = 10): Promise<DriveFound[]> {
    this.needRead()
    const words = String(query ?? '').trim().slice(0, 200)
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const q = [`trashed = false`, `mimeType != '${FOLDER}'`, ...(words ? [`(name contains '${esc(words)}' or fullText contains '${esc(words)}')`] : [])].join(' and ')
    const params = new URLSearchParams({
      q,
      pageSize: String(Math.min(25, Math.max(1, Math.floor(limit) || 10))),
      fields: 'files(id,name,mimeType,modifiedTime,size,owners(displayName))',
      // Google won't sort full-text results.
      ...(words ? {} : { orderBy: 'modifiedTime desc' }),
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true'
    })
    const r = await this.api('GET', `/drive/v3/files?${params}`)
    if (r.status !== 200) throw new DriveError(r.json?.error?.message || `Google Drive answered ${r.status}.`)
    return (r.json.files ?? []).map((f: any) => ({
      id: String(f.id),
      name: String(f.name || 'Untitled'),
      mimeType: String(f.mimeType || ''),
      modified: String(f.modifiedTime || ''),
      size: f.size ? Number(f.size) : undefined,
      owner: f.owners?.[0]?.displayName ? String(f.owners[0].displayName) : undefined
    }))
  }

  /**
   * One file for the Assistant: Docs (Markdown, or text), Slides (text) and Sheets (CSV, the first
   * sheet) as text; PDFs, and pictures (made smaller), as the file; text files as text.
   */
  async read(id: string): Promise<DriveRead> {
    this.needRead()
    if (!/^[\w-]{1,200}$/.test(id)) throw new DriveError('That isn’t a Drive file id.')
    const meta = await this.api('GET', `/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,trashed&supportsAllDrives=true`)
    if (meta.status === 404) throw new DriveError('There’s no Drive file with that id (or it isn’t shared with you).')
    if (meta.status !== 200) throw new DriveError(meta.json?.error?.message || `Google Drive answered ${meta.status}.`)
    const name = String(meta.json.name || 'Untitled')
    const mime = String(meta.json.mimeType || '')
    const size = Number(meta.json.size || 0)
    const text = (t: string, note = '') => {
      const cut = t.length > MAX_TEXT
      return { name, mime, note: `${note}${cut ? `${note ? ' ' : ''}It was cut at ${MAX_TEXT.toLocaleString('en')} characters.` : ''}`, file: { type: 'text' as const, name, data: t.slice(0, MAX_TEXT) } }
    }
    const exp = async (as: string) => (await this.raw(`/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(as)}`)).text()
    if (mime === GOOGLE_DOC) {
      // Markdown keeps headings and lists, where Google offers it.
      try {
        return text(await exp('text/markdown'))
      } catch {
        return text(await exp('text/plain'))
      }
    }
    if (mime === 'application/vnd.google-apps.presentation') return text(await exp('text/plain'))
    if (mime === 'application/vnd.google-apps.spreadsheet') return text(await exp('text/csv'), 'This is the first sheet only.')
    if (mime.startsWith('application/vnd.google-apps.')) throw new DriveError('The Assistant can read Google Docs, Sheets and Slides, but not this kind of Google file.')
    if (size > MAX_DOWNLOAD) throw new DriveError(`“${name}” is ${Math.round(size / 1048576)} MB, which is too big to read (up to 10 MB).`)
    const isText = mime.startsWith('text/') || /^application\/(json|xml|x-yaml|javascript)/.test(mime)
    if (mime !== 'application/pdf' && !mime.startsWith('image/') && !isText)
      throw new DriveError(`The Assistant can’t read this kind of file (${mime || 'unknown'}). For Word, Excel or PowerPoint files, open them in Google Drive and use File → Save as Google Docs (or Sheets, or Slides), then ask again.`)
    const bytes = Buffer.from(await (await this.raw(`/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).arrayBuffer())
    if (bytes.length > MAX_DOWNLOAD) throw new DriveError(`“${name}” is too big to read (up to 10 MB).`)
    if (isText) return text(bytes.toString('utf8'))
    if (mime === 'application/pdf') return { name, mime, note: '', file: { type: 'pdf', name, data: bytes.toString('base64') } }
    return { name, mime, note: '', file: { type: 'image', name, ...shrinkImage(bytes, mime, name) } }
  }

  /** A new Google Doc in "Veyra Study", made from a web page. */
  createDoc(title: string, html: string): Promise<{ id: string; url: string }> {
    return this.queue(async () => {
      const name = (title || 'Untitled').slice(0, 200)
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(name)}</title></head><body>${html}</body></html>`
      const r = await this.upload(null, { name, mimeType: GOOGLE_DOC, parents: [await this.root()] }, page, 'text/html')
      if (r.status !== 200) throw new DriveError(r.json?.error?.message || 'Couldn’t make the Google Doc.')
      return { id: r.json.id, url: r.json.webViewLink || `https://docs.google.com/document/d/${r.json.id}/edit` }
    })
  }

  /** Moves a file Veyra made to Drive's bin (Undo for createDoc). */
  async trash(id: string): Promise<void> {
    if (!/^[\w-]{1,200}$/.test(id)) throw new DriveError('That isn’t a Drive file id.')
    const r = await this.api('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, JSON.stringify({ trashed: true }), 'application/json')
    if (r.status !== 200) throw new DriveError(r.json?.error?.message || 'Couldn’t move it to the bin.')
  }

  /** Forgets the sign-in here; files already in Drive stay. */
  disconnect(): DriveState {
    const { folderId, backupFolderId, docs, backups, backup } = this.cfg
    this.cfg = { ...blank(), folderId, backupFolderId, docs, backups, backup }
    this.save()
    return this.state()
  }

  setBackup(on: boolean): DriveState {
    this.cfg.backup = !!on
    this.save()
    return this.state()
  }

  /* ---------- HTTP ---------- */
  private async token(): Promise<string> {
    const c = this.cfg
    if (!c.refreshToken) throw new DriveError('Google Drive isn’t connected. Connect it in Settings → Connections.')
    if (c.accessToken && (c.accessExpires ?? 0) > Date.now()) return c.accessToken
    try {
      const tok = await tokenRequest({
        client_id: __GOOGLE_CLIENT__.id,
        ...(__GOOGLE_CLIENT__.secret ? { client_secret: __GOOGLE_CLIENT__.secret } : {}),
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token'
      })
      c.accessToken = tok.access_token
      c.accessExpires = Date.now() + (tok.expires_in - 60) * 1000
      c.error = undefined
      this.save()
      return c.accessToken
    } catch (e) {
      if ((e as any)?.code === 'invalid_grant') {
        c.refreshToken = undefined
        c.error = 'Google ended Veyra’s access to Drive. Connect again.'
        this.save()
        throw new DriveError(c.error)
      }
      throw new DriveError(e instanceof Error ? e.message : 'Can’t reach Google.')
    }
  }

  private async api(method: string, path: string, body?: BodyInit, type?: string, retried = false): Promise<{ status: number; json: any }> {
    let res: Response
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${await this.token()}`, ...(type ? { 'Content-Type': type } : {}) },
        body,
        signal: AbortSignal.timeout(60000)
      })
    } catch (e) {
      if (e instanceof DriveError) throw e
      throw new DriveError('Can’t reach Google Drive. Check your connection.')
    }
    const json: any = res.status === 204 ? {} : await res.json().catch(() => ({}))
    if (res.status === 403) {
      const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || ''
      if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(json?.error?.message || ''))
        throw new DriveError('The Google Drive API is turned off for this app. Turn it on in Google Cloud (APIs & Services → Library → Google Drive API), then try again.')
      if (/storageQuotaExceeded/i.test(reason)) throw new DriveError('Your Google Drive is full.')
    }
    if (res.status === 401 && !retried) {
      // The access token was refused early: get a new one and try once more.
      this.cfg.accessToken = undefined
      return this.api(method, path, body, type, true)
    }
    return { status: res.status, json }
  }

  /** Upload (create or replace) with metadata and content in one request. */
  private async upload(fileId: string | null, meta: Record<string, unknown>, content: string, contentType: string): Promise<{ status: number; json: any }> {
    const boundary = 'veyra' + Math.random().toString(36).slice(2)
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`
    const path = fileId ? `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,webViewLink` : `/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`
    return this.api(fileId ? 'PATCH' : 'POST', path, body, `multipart/related; boundary=${boundary}`)
  }

  /** A folder Veyra made, made again if it was deleted. Ids are kept; nothing is looked up by name. */
  private async folder(key: 'folderId' | 'backupFolderId', name: string, parent?: string): Promise<string> {
    const id = this.cfg[key]
    if (id) {
      const r = await this.api('GET', `/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed`)
      if (r.status === 200 && !r.json.trashed) return id
      if (r.status !== 404 && r.status !== 200) throw new DriveError(r.json?.error?.message || `Google Drive answered ${r.status}.`)
    }
    const r = await this.api('POST', '/drive/v3/files?fields=id', JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }), 'application/json')
    if (r.status !== 200) throw new DriveError(r.json?.error?.message || 'Couldn’t make the Veyra Study folder in Drive.')
    this.cfg[key] = r.json.id
    if (key === 'backupFolderId') this.cfg.backups = {} // a new folder starts the backup over
    this.save()
    return r.json.id
  }
  private root = () => this.folder('folderId', 'Veyra Study')
  private async backupRoot() {
    return this.folder('backupFolderId', 'Notes backup', await this.root())
  }

  /* ---------- Save to Google Docs ---------- */
  saveDoc(noteId: string, title: string, html: string): Promise<{ url: string }> {
    return this.queue(async () => {
      const name = (title || 'Untitled').slice(0, 200)
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(name)}</title></head><body>${html}</body></html>`
      const existing = this.cfg.docs[noteId]
      let r = existing ? await this.upload(existing, { name }, page, 'text/html') : null
      if (!r || r.status === 404) {
        r = await this.upload(null, { name, mimeType: 'application/vnd.google-apps.document', parents: [await this.root()] }, page, 'text/html')
      }
      if (r.status !== 200) throw new DriveError(r.json?.error?.message || 'Couldn’t save the note to Google Docs.')
      this.cfg.docs[noteId] = r.json.id
      this.save()
      return { url: r.json.webViewLink || `https://docs.google.com/document/d/${r.json.id}/edit` }
    })
  }

  /* ---------- backup ---------- */
  /** Uploads changed notes and bins deleted ones. `through` is the newest change the list covers. */
  backupNotes(files: DriveBackupFile[], through: number): Promise<DriveState & { uploaded: number; removed: number }> {
    return this.queue(async () => {
      let uploaded = 0
      let removed = 0
      if (!this.cfg.refreshToken || !this.cfg.backup) return { ...this.state(), uploaded, removed }
      const before = this.cfg.backupFolderId
      const dir = await this.backupRoot()
      // The backup folder was deleted in Drive and made again: upload everything next time.
      const fresh = !!before && before !== dir
      for (const f of files.slice(0, 2000)) {
        const had = this.cfg.backups[f.id]
        if (f.deleted) {
          if (had) {
            const r = await this.api('PATCH', `/drive/v3/files/${encodeURIComponent(had.fileId)}`, JSON.stringify({ trashed: true }), 'application/json')
            if (r.status !== 200 && r.status !== 404) throw new DriveError(r.json?.error?.message || 'Couldn’t update the backup.')
            delete this.cfg.backups[f.id]
            removed++
          }
          continue
        }
        if (had && had.updatedAt >= f.updatedAt) continue
        const name = `${safeName(f.name)}.md`
        let r = had ? await this.upload(had.fileId, { name }, f.markdown, 'text/markdown') : null
        if (!r || r.status === 404) r = await this.upload(null, { name, mimeType: 'text/markdown', parents: [dir] }, f.markdown, 'text/markdown')
        if (r.status !== 200) throw new DriveError(r.json?.error?.message || 'Couldn’t upload a note to the backup.')
        this.cfg.backups[f.id] = { fileId: r.json.id, updatedAt: f.updatedAt }
        uploaded++
      }
      this.cfg.backupThrough = fresh ? 0 : Math.max(this.cfg.backupThrough, through)
      this.cfg.lastBackup = Date.now()
      this.cfg.error = undefined
      this.save()
      return { ...this.state(), uploaded, removed }
    })
  }

  /* ---------- Open from Drive ---------- */
  /**
   * Google's file picker, on a one-time page served from this computer and
   * opened in the browser (the picker can't run inside the app). Files you
   * pick there are the only others Veyra can read. Google Docs come back as
   * HTML (to become notes); anything else is downloaded as an attachment.
   */
  async pickAndImport(): Promise<DrivePicked[]> {
    if (!__GOOGLE_CLIENT__.apiKey) throw new DriveError('Opening files from Drive isn’t set up in this copy of Veyra.')
    const token = await this.token()
    // Dev checks: VEYRA_FAKE_PICK='[{"id":…,"name":…,"mimeType":…}]' stands in for the picker page.
    const fake = process.env['VEYRA_FAKE_PICK']
    const picked = fake ? (JSON.parse(fake) as { id: string; name: string; mimeType: string }[]) : await new Promise<{ id: string; name: string; mimeType: string }[]>((resolve, reject) => {
      // A new pick replaces one left open (say the tab was closed instead of cancelled).
      this.cancelPick?.()
      const path = '/' + randomBytes(16).toString('hex')
      let done = false
      const finish = (v: { id: string; name: string; mimeType: string }[] | Error) => {
        if (done) return
        done = true
        this.cancelPick = null
        clearTimeout(timer)
        setTimeout(() => server.close(), 1000)
        v instanceof Error ? reject(v) : resolve(v)
      }
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === path && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
          res.end(pickerPage(token))
          return
        }
        if (url.pathname === path + '/done' && req.method === 'POST') {
          let body = ''
          for await (const c of req) body += c
          res.writeHead(204).end()
          try {
            const j = JSON.parse(body)
            const list = Array.isArray(j.docs) ? j.docs.filter((d: any) => d && typeof d.id === 'string').slice(0, 25) : []
            finish(list.map((d: any) => ({ id: d.id, name: String(d.name || 'Untitled'), mimeType: String(d.mimeType || '') })))
          } catch {
            finish([])
          }
          return
        }
        res.writeHead(404).end()
      })
      const timer = setTimeout(() => finish(new DriveError('The Drive file picker timed out. Try again.')), 10 * 60_000)
      this.cancelPick = () => finish([])
      server.listen(0, '127.0.0.1', () => shell.openExternal(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`))
    })

    const out: DrivePicked[] = []
    for (const f of picked) {
      const google = f.mimeType.startsWith('application/vnd.google-apps.')
      if (f.mimeType === 'application/vnd.google-apps.document') {
        const r = await this.raw(`/drive/v3/files/${encodeURIComponent(f.id)}/export?mimeType=text/html`)
        out.push({ kind: 'doc', name: f.name, html: await r.text() })
      } else if (google) {
        // Slides, Sheets and Drawings come in as PDFs.
        const r = await this.raw(`/drive/v3/files/${encodeURIComponent(f.id)}/export?mimeType=application/pdf`)
        out.push({ kind: 'file', file: this.files.fromDownload(`${f.name}.pdf`, 'application/pdf', new Uint8Array(await r.arrayBuffer())) })
      } else {
        const r = await this.raw(`/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`)
        out.push({ kind: 'file', file: this.files.fromDownload(f.name, f.mimeType, new Uint8Array(await r.arrayBuffer())) })
      }
    }
    return out
  }

  /** A GET whose body isn't JSON (exports and downloads). */
  private async raw(path: string): Promise<Response> {
    let res: Response
    for (let i = 0; ; i++) {
      try {
        res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(5 * 60_000) })
      } catch (e) {
        if (e instanceof DriveError) throw e
        throw new DriveError('Can’t reach Google Drive. Check your connection.')
      }
      if (res.status === 401 && i === 0) {
        this.cfg.accessToken = undefined
        continue
      }
      break
    }
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}))
      if (res.status === 403 && /exportSizeLimitExceeded/.test(JSON.stringify(j))) throw new DriveError('That file is too big for Google to convert.')
      throw new DriveError(j?.error?.message || `Google Drive answered ${res.status}.`)
    }
    return res
  }

  /** Starts the backup over (uploads every note again on the next run). */
  resetBackup(): DriveState {
    this.cfg.backupThrough = 0
    this.cfg.backups = Object.fromEntries(Object.entries(this.cfg.backups).map(([k, v]) => [k, { ...v, updatedAt: 0 }]))
    this.save()
    return this.state()
  }
}

/**
 * A picture made small enough for Claude (about 1.15 megapixels, 1568 px at most), as JPEG.
 * GIFs and anything Electron can't open are sent as they are, if they're small enough.
 */
function shrinkImage(bytes: Buffer, mime: string, name: string): { mime: string; data: string } {
  const img = mime === 'image/gif' ? null : nativeImage.createFromBuffer(bytes)
  if (img && !img.isEmpty()) {
    const { width, height } = img.getSize()
    const scale = Math.min(1, 1568 / Math.max(width, height), Math.sqrt(1_150_000 / (width * height)))
    const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
    return { mime: 'image/jpeg', data: out.toJPEG(85).toString('base64') }
  }
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) throw new DriveError(`“${name}” is a kind of picture the Assistant can’t read.`)
  if (bytes.length > 3_700_000) throw new DriveError(`“${name}” is too big a picture to read.`)
  return { mime, data: bytes.toString('base64') }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const safeName = (n: string) => (n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Untitled').slice(0, 120)

const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\u003c')

/** The page that shows Google's file picker. The project number (the client ID's first part) is the picker's app id. */
function pickerPage(token: string): string {
  const app = __GOOGLE_CLIENT__.id.split('-')[0]
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pick files · Veyra Study</title></head>
<body style="font:16px system-ui;background:#f3f1ec;color:#1b1a18;display:grid;place-items:center;height:90vh;margin:0">
<div id="msg" style="text-align:center"><h2>Opening Google Drive…</h2><p>Pick the files to bring into Veyra Study.</p></div>
<script src="https://apis.google.com/js/api.js"></script>
<script>
const TOKEN = ${js(token)}, KEY = ${js(__GOOGLE_CLIENT__.apiKey)}, APP = ${js(app)}
const say = (h, p) => { document.getElementById('msg').innerHTML = '<h2></h2><p></p>'; document.querySelector('#msg h2').textContent = h; document.querySelector('#msg p').textContent = p }
const send = (docs) => fetch(location.pathname + '/done', { method: 'POST', body: JSON.stringify({ docs }) })
gapi.load('picker', () => {
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(google.picker.DocsViewMode.LIST)
  new google.picker.PickerBuilder()
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setOAuthToken(TOKEN).setDeveloperKey(KEY).setAppId(APP)
    .setTitle('Pick files for Veyra Study')
    .setCallback((d) => {
      if (d.action === google.picker.Action.PICKED) send(d.docs.map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType }))).then(() => say('Got it', 'You can close this tab and go back to Veyra Study.'))
      else if (d.action === google.picker.Action.CANCEL) send([]).then(() => say('Cancelled', 'You can close this tab.'))
    })
    .build()
    .setVisible(true)
})
</script></body></html>`
}
