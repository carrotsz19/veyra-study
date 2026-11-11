/**
 * Google Calendar, both ways:
 *  - reads events from the calendars you pick, to show in Veyra's calendar;
 *  - writes task deadlines as all-day events into a "Veyra Study" calendar
 *    that Veyra creates (and can only touch that one).
 *
 * Sign-in: google-oauth.ts (loopback + PKCE), with the app's built-in client
 * or one the user entered in Settings.
 *
 * Event ids are derived from task ids ("vs" + the UUID's hex), so pushing is
 * idempotent and two devices never make duplicates.
 */
import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { emailFromIdToken, googleSignIn, tokenRequest } from './google-oauth'
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

export const eventIdFor = (taskId: string) => 'vs' + taskId.replace(/-/g, '').toLowerCase()
const nextDay = (d: string) => {
  const t = new Date(d + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

export class GoogleCalendar {
  private cfg: Config | null = null
  private calendars: { id: string; summary: string; color: string; selected: boolean; primary: boolean; owner: boolean; description: string }[] = []
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

  state(): Omit<GoogleState, 'feeds'> {
    const c = this.cfg
    return {
      builtIn: !!__GOOGLE_CLIENT__.id,
      customClient: !!c?.clientId && c.clientId !== __GOOGLE_CLIENT__.id,
      connected: !!c?.refreshToken,
      clientId: c?.clientId && c.clientId !== __GOOGLE_CLIENT__.id ? c.clientId : '',
      hasSecret: !!c?.clientSecret,
      email: c?.email ?? '',
      pushTasks: c?.pushTasks ?? true,
      shown: c?.shown ?? null,
      calendars: this.calendars.filter((x) => x.id !== c?.calendarId).map(({ id, summary, color, selected, primary }) => ({ id, summary, color, selected, primary })),
      error: c?.error,
      lastSync: c?.lastSync
    }
  }

  /* ---------- sign-in ---------- */
  async connect(clientId = '', clientSecret = ''): Promise<Omit<GoogleState, 'feeds'>> {
    clientId = clientId.trim()
    clientSecret = clientSecret.trim()
    if (!clientId) {
      // The app's own client, built in at build time.
      if (!__GOOGLE_CLIENT__.id) throw new GoogleError('This build has no Google client. Enter one below.')
      clientId = __GOOGLE_CLIENT__.id
      clientSecret = __GOOGLE_CLIENT__.secret
    } else if (!clientSecret && clientId === this.cfg?.clientId) {
      clientSecret = this.cfg.clientSecret ?? ''
    }
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new GoogleError('That doesn’t look like a client ID. It ends in .apps.googleusercontent.com.')
    let tok
    try {
      tok = await googleSignIn({ clientId, clientSecret, scopes: SCOPES, what: 'Google Calendar' })
    } catch (e) {
      throw new GoogleError(e instanceof Error ? e.message : 'Google sign-in didn’t finish.')
    }
    if (!tok.refresh_token) throw new GoogleError('Google didn’t give Veyra lasting access. Remove Veyra in your Google account’s third-party access, then connect again.')
    const keep = this.cfg
    this.cfg = {
      clientId,
      clientSecret: clientSecret || undefined,
      refreshToken: tok.refresh_token,
      accessToken: tok.access_token,
      accessExpires: Date.now() + (tok.expires_in - 60) * 1000,
      email: emailFromIdToken(tok.id_token),
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

  async disconnect(): Promise<Omit<GoogleState, 'feeds'>> {
    // Only forgets the sign-in here. Revoking it at Google would also end Drive's
    // access (both use one client); people can remove Veyra in their Google account.
    // Keep the client ID so connecting again is one click.
    // Keep the calendar id too, so reconnecting reuses the same Veyra Study calendar.
    this.cfg = this.cfg
      ? { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, calendarId: this.cfg.calendarId, pushTasks: this.cfg.pushTasks, shown: this.cfg.shown, pushedThrough: 0 }
      : null
    this.calendars = []
    this.cache.clear()
    this.save()
    return this.state()
  }

  async setOptions(o: { pushTasks?: boolean; shown?: string[] | null }): Promise<Omit<GoogleState, 'feeds'>> {
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
    try {
      return await tokenRequest(body)
    } catch (e) {
      if ((e as any)?.code === 'invalid_grant' && body.grant_type === 'refresh_token') {
        // Usually: access was removed, or the OAuth app is in "Testing" (7-day tokens).
        if (this.cfg) {
          this.cfg.refreshToken = undefined
          this.cfg.error = 'Google ended Veyra’s access. Connect again. If this keeps happening weekly, set your OAuth app to “In production”.'
          this.save()
        }
        throw new GoogleError(this.cfg?.error ?? 'Google ended access.')
      }
      throw new GoogleError(e instanceof Error ? e.message : 'Google refused the sign-in.')
    }
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
      primary: !!c.primary,
      owner: c.accessRole === 'owner',
      description: c.description || ''
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
    // Reuse a Veyra Study calendar made earlier (another device, or before a reset).
    await this.loadCalendars()
    const existing = this.calendars.find((x) => x.owner && x.summary === 'Veyra Study' && x.description.startsWith('Task deadlines from Veyra Study'))
    if (existing) {
      c.calendarId = existing.id
      c.pushedThrough = 0
      this.save()
      return existing.id
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
