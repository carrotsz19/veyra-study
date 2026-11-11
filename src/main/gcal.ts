/**
 * Google Calendar, both ways:
 *  - reads events from the calendars you pick, to show in Veyra's calendar;
 *  - writes task deadlines as all-day events into a "Veyra Study" calendar
 *    that Veyra creates (and can only touch that one).
 *
 * Sign-in is OAuth for installed apps: the system browser, a loopback
 * redirect to 127.0.0.1 on a random port, and PKCE. The OAuth client is the
 * user's own (Google Cloud → Desktop app), entered in Settings.
 *
 * Event ids are derived from task ids ("vs" + the UUID's hex), so pushing is
 * idempotent and two devices never make duplicates.
 */
import { safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { GoogleEvent, GoogleState, Rec } from '../shared/types'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'openid',
  'email'
]
const API = 'https://www.googleapis.com/calendar/v3'

interface Config {
  clientId: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  accessExpires?: number
  email?: string
  /** The "Veyra Study" calendar Veyra made. */
  calendarId?: string
  /** Calendars to show; null = the ones selected in Google. */
  shown?: string[] | null
  pushTasks: boolean
  /** Task changes after this (records.updated_at) still need pushing. */
  pushedThrough: number
  error?: string
  lastSync?: number
}

export class GoogleError extends Error {}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const eventIdFor = (taskId: string) => 'vs' + taskId.replace(/-/g, '').toLowerCase()
const nextDay = (d: string) => {
  const t = new Date(d + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

export class GoogleCalendar {
  private cfg: Config | null = null
  private calendars: { id: string; summary: string; color: string; selected: boolean; primary: boolean }[] = []
  private cache = new Map<string, { at: number; events: GoogleEvent[] }>()
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private pushing = false

  constructor(
    private file: string,
    /** Task records (tombstones included) changed after `since`. */
    private taskChanges: (since: number) => Rec<'task'>[],
    private subjectName: (id: string | null) => string | null
  ) {
    try {
      if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.cfg = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    } catch {
      this.cfg = null
    }
  }

  private disposed = false

  private save() {
    if (this.disposed) return
    if (!this.cfg) return rmSync(this.file, { force: true })
    if (!safeStorage.isEncryptionAvailable()) throw new GoogleError('This computer can’t store the Google sign-in securely.')
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.cfg)))
  }

  state(): GoogleState {
    const c = this.cfg
    return {
      connected: !!c?.refreshToken,
      clientId: c?.clientId ?? '',
      hasSecret: !!c?.clientSecret,
      email: c?.email ?? '',
      pushTasks: c?.pushTasks ?? true,
      shown: c?.shown ?? null,
      calendars: this.calendars.filter((x) => x.id !== c?.calendarId),
      error: c?.error,
      lastSync: c?.lastSync
    }
  }

  /* ---------- sign-in ---------- */
  async connect(clientId: string, clientSecret: string): Promise<GoogleState> {
    clientId = clientId.trim()
    clientSecret = clientSecret.trim()
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new GoogleError('That doesn’t look like a client ID. It ends in .apps.googleusercontent.com.')
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))

    const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Veyra Study</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#f3f1ec;color:#1b1a18"><div style="text-align:center"><h2>${
            ok ? 'Google Calendar is connected' : 'That didn’t work'
          }</h2><p>${ok ? 'You can close this tab and go back to Veyra Study.' : 'Go back to Veyra Study and try again.'}</p></div>`
        )
        clearTimeout(timeout)
        server.close()
        if (ok) resolve({ code: url.searchParams.get('code')!, redirect: `http://127.0.0.1:${(server.address() as AddressInfo | null)?.port ?? port}` })
        else reject(new GoogleError(url.searchParams.get('error') === 'access_denied' ? 'You didn’t allow access in Google.' : 'Google sign-in didn’t finish.'))
      })
      let port = 0
      const timeout = setTimeout(() => {
        server.close()
        reject(new GoogleError('Google sign-in timed out. Try again.'))
      }, 5 * 60 * 1000)
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        auth.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent'
        }).toString()
        shell.openExternal(auth.toString())
      })
    })

    const tok = await this.tokenRequest({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirect
    })
    if (!tok.refresh_token) throw new GoogleError('Google didn’t give Veyra lasting access. Remove Veyra in your Google account’s third-party access, then connect again.')
    const keep = this.cfg?.clientId === clientId ? this.cfg : null
    this.cfg = {
      clientId,
      clientSecret: clientSecret || undefined,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessExpires: Date.now() + (tok.expires_in - 60) * 1000,
      email: tok.id_token ? JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64').toString()).email : '',
      calendarId: keep?.calendarId,
      shown: keep?.shown ?? null,
      pushTasks: keep?.pushTasks ?? true,
      pushedThrough: 0
    }
    this.save()
    await this.loadCalendars()
    this.schedulePush(0)
    return this.state()
  }

  async disconnect(): Promise<GoogleState> {
    const token = this.cfg?.refreshToken
    if (token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {})
    // Keep the client ID so connecting again is one click.
    this.cfg = this.cfg ? { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, pushTasks: this.cfg.pushTasks, pushedThrough: 0 } : null
    this.calendars = []
    this.cache.clear()
    this.save()
    return this.state()
  }

  async setOptions(o: { pushTasks?: boolean; shown?: string[] | null }): Promise<GoogleState> {
    if (!this.cfg) return this.state()
    if (o.pushTasks !== undefined) {
      this.cfg.pushTasks = o.pushTasks
      if (o.pushTasks) {
        this.cfg.pushedThrough = 0
        this.schedulePush(0)
      }
    }
    if (o.shown !== undefined) this.cfg.shown = o.shown
    this.cache.clear()
    this.save()
    return this.state()
  }

  /* ---------- HTTP ---------- */
  private async tokenRequest(body: Record<string, string>): Promise<any> {
    let res: Response
    try {
      res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(20000)
      })
    } catch {
      throw new GoogleError('Can’t reach Google. Check your connection.')
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (json.error === 'invalid_grant' && body.grant_type === 'refresh_token') {
        // Usually: access was removed, or the OAuth app is in "Testing" (7-day tokens).
        if (this.cfg) {
          this.cfg.refreshToken = undefined
          this.cfg.error = 'Google ended Veyra’s access. Connect again. If this keeps happening weekly, set your OAuth app to “In production”.'
          this.save()
        }
        throw new GoogleError(this.cfg?.error ?? 'Google ended access.')
      }
      if (json.error === 'invalid_client') throw new GoogleError('Google didn’t accept that client ID or secret. Check them and try again.')
      throw new GoogleError(json.error_description || json.error || `Google refused the sign-in (${res.status}).`)
    }
    return json
  }

  private async token(): Promise<string> {
    const c = this.cfg
    if (!c?.refreshToken) throw new GoogleError('Google Calendar isn’t connected.')
    if (c.accessToken && (c.accessExpires ?? 0) > Date.now()) return c.accessToken
    const tok = await this.tokenRequest({
      client_id: c.clientId,
      ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token'
    })
    c.accessToken = tok.access_token
    c.accessExpires = Date.now() + (tok.expires_in - 60) * 1000
    c.error = undefined
    this.save()
    return c.accessToken!
  }

  private async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    })
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  /* ---------- reading ---------- */
  async loadCalendars(): Promise<void> {
    const { status, json } = await this.api('GET', '/users/me/calendarList?maxResults=250')
    if (status !== 200) throw new GoogleError(json?.error?.message || 'Couldn’t load your calendars.')
    this.calendars = (json.items ?? []).map((c: any) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary,
      color: c.backgroundColor || '#2f5f8a',
      selected: !!c.selected,
      primary: !!c.primary
    }))
  }

  async events(fromIso: string, toIso: string): Promise<{ events: GoogleEvent[]; error?: string }> {
    if (!this.cfg?.refreshToken) return { events: [], error: this.cfg?.error }
    const key = fromIso + toIso
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < 2 * 60 * 1000) return { events: hit.events }
    try {
      if (!this.calendars.length) await this.loadCalendars()
      const shown = this.cfg.shown
      const cals = this.calendars.filter((c) => c.id !== this.cfg!.calendarId && (shown ? shown.includes(c.id) : c.selected))
      const lists = await Promise.all(
        cals.map(async (cal) => {
          const q = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' })
          const { status, json } = await this.api('GET', `/calendars/${encodeURIComponent(cal.id)}/events?${q}`)
          if (status !== 200) return []
          return (json.items ?? [])
            .filter((e: any) => e.status !== 'cancelled')
            .map(
              (e: any): GoogleEvent => ({
                id: `${cal.id}|${e.id}`,
                title: e.summary || '(No title)',
                calendar: cal.summary,
                color: cal.color,
                allDay: !!e.start?.date,
                // all-day: "YYYY-MM-DD", end exclusive; timed: ISO date-times
                start: e.start?.date ?? e.start?.dateTime,
                end: e.end?.date ?? e.end?.dateTime,
                location: e.location || '',
                link: e.htmlLink || ''
              })
            )
        })
      )
      const events = lists.flat().sort((a, b) => (a.start < b.start ? -1 : 1))
      this.cache.set(key, { at: Date.now(), events })
      this.cfg.lastSync = Date.now()
      return { events }
    } catch (e) {
      return { events: hit?.events ?? [], error: e instanceof GoogleError ? e.message : 'Couldn’t load Google events.' }
    }
  }

  /** Stop pending work; the data it belongs to is being closed. */
  dispose(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.disposed = true
  }

  /* ---------- writing task deadlines ---------- */
  /** Push soon (debounced); called whenever a task changes. */
  schedulePush(delay = 3000): void {
    if (!this.cfg?.refreshToken || !this.cfg.pushTasks) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push().catch(() => {}), delay)
  }

  private async ensureCalendar(): Promise<string> {
    const c = this.cfg!
    if (c.calendarId) {
      const { status } = await this.api('GET', `/calendars/${encodeURIComponent(c.calendarId)}`)
      if (status === 200) return c.calendarId
    }
    const { status, json } = await this.api('POST', '/calendars', {
      summary: 'Veyra Study',
      description: 'Task deadlines from Veyra Study. Changes here are overwritten by the app.',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    if (status !== 200) throw new GoogleError(json?.error?.message || 'Couldn’t create the Veyra Study calendar.')
    c.calendarId = json.id
    c.pushedThrough = 0
    this.save()
    return json.id
  }

  async push(): Promise<{ pushed: number }> {
    const c = this.cfg
    if (!c?.refreshToken || !c.pushTasks || this.pushing || this.disposed) return { pushed: 0 }
    this.pushing = true
    try {
      const cal = encodeURIComponent(await this.ensureCalendar())
      const changes = this.taskChanges(c.pushedThrough)
      let through = c.pushedThrough
      let pushed = 0
      for (const t of changes) {
        if (this.disposed) break
        const id = eventIdFor(t.id)
        if (t.deletedAt || !t.data.due) {
          const { status } = await this.api('DELETE', `/calendars/${cal}/events/${id}`)
          if (status >= 500 || status === 401 || status === 403) throw new GoogleError('Google refused a change.')
        } else {
          const subject = this.subjectName(t.data.subjectId)
          const body = {
            id,
            status: 'confirmed',
            summary: `${t.data.done ? '✓ ' : ''}${t.data.title}`,
            description: [subject ? `Subject: ${subject}` : '', t.data.details ?? '', 'From Veyra Study'].filter(Boolean).join('\n\n'),
            start: { date: t.data.due },
            end: { date: nextDay(t.data.due) },
            transparency: 'transparent',
            reminders: { useDefault: false },
            extendedProperties: { private: { veyraTask: t.id } }
          }
          // Update first (this also brings back an event deleted earlier), insert if it never existed.
          let r = await this.api('PUT', `/calendars/${cal}/events/${id}`, body)
          if (r.status === 404) r = await this.api('POST', `/calendars/${cal}/events`, body)
          if (r.status >= 300) throw new GoogleError(r.json?.error?.message || 'Google refused a change.')
          pushed++
        }
        through = Math.max(through, t.updatedAt)
        c.pushedThrough = through
      }
      c.lastSync = Date.now()
      this.save()
      return { pushed }
    } finally {
      this.pushing = false
    }
  }
}
