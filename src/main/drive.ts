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
import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { DriveBackupFile, DriveState } from '../shared/types'
import { emailFromIdToken, googleSignIn, tokenRequest } from './google-oauth'

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email']
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
}

const blank = (): Config => ({ docs: {}, backup: true, backups: {}, backupThrough: 0 })

export class GoogleDrive {
  private cfg: Config = blank()
  private disposed = false
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private file: string) {
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
      canPick: !!__GOOGLE_CLIENT__.apiKey
    }
  }

  /* ---------- sign-in ---------- */
  async connect(): Promise<DriveState> {
    if (!__GOOGLE_CLIENT__.id) throw new DriveError('This build has no Google client, so Drive can’t connect.')
    // Dev checks: VEYRA_FAKE_DRIVE=1 skips Google's page (with VEYRA_GOOGLE_TOKEN_URL pointing at a stand-in).
    const tok = process.env['VEYRA_FAKE_DRIVE']
      ? { refresh_token: 'fake-refresh', access_token: 'fake-access', expires_in: 3600, id_token: undefined }
      : await googleSignIn({ clientId: __GOOGLE_CLIENT__.id, clientSecret: __GOOGLE_CLIENT__.secret, scopes: SCOPES, what: 'Google Drive' }).catch((e) => {
          throw new DriveError(e instanceof Error ? e.message : 'Google sign-in didn’t finish.')
        })
    if (!tok.refresh_token) throw new DriveError('Google didn’t give Veyra lasting access. Remove Veyra in your Google account’s third-party access, then connect again.')
    this.cfg = {
      ...this.cfg,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessExpires: Date.now() + (tok.expires_in - 60) * 1000,
      email: emailFromIdToken(tok.id_token) || (process.env['VEYRA_FAKE_DRIVE'] ? 'test@example.com' : ''),
      error: undefined
    }
    this.save()
    return this.state()
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

  /** Starts the backup over (uploads every note again on the next run). */
  resetBackup(): DriveState {
    this.cfg.backupThrough = 0
    this.cfg.backups = Object.fromEntries(Object.entries(this.cfg.backups).map(([k, v]) => [k, { ...v, updatedAt: 0 }]))
    this.save()
    return this.state()
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const safeName = (n: string) => (n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Untitled').slice(0, 120)
