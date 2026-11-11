/**
 * Group work client (main process). Talks to the group server on the
 * owner's phone, found through the relay. Tokens stay here; the UI calls
 * through IPC.
 *
 * Sign-in: Veyra session (cookie + handle, held by Accounts) → relay
 * /identify → 15-minute pass → server /session → group session (stored
 * encrypted per account). A 401 re-runs this once.
 */
import { safeStorage, type WebContents } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { GoogleEvent, Group, GroupItem, GroupStatus } from '../shared/types'

export class GroupError extends Error {
  constructor(
    message: string,
    public status = 0,
    public extra?: unknown
  ) {
    super(message)
  }
}

export const RELAY_URL = (process.env['VEYRA_RELAY'] || 'https://veyra-study-relay.igreenrobotz.workers.dev').replace(/\/$/, '')

interface Saved {
  serverUrl?: string
  session?: string
  me?: GroupStatus['me']
}

export class GroupClient {
  private saved: Saved = {}
  private status: GroupStatus = { state: 'idle', me: null, error: '' }
  private polling = false
  private disposed = false
  private lastSeq = 0
  private listeners = new Set<WebContents>()
  /** Shared tasks and deadlines per group, kept up to date with ?since= (for Calendar and Today). */
  private dated = new Map<string, { seq: number; group: Group; items: Map<string, GroupItem> }>()
  private datedAt = 0

  constructor(
    private file: string,
    /** The signed-in Veyra account's handle and cookies, or null. */
    private credentials: () => { handle: string; cookie: string } | null
  ) {
    try {
      if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.saved = JSON.parse(safeStorage.decryptString(readFileSync(file)))
    } catch {
      this.saved = {}
    }
    if (this.saved.me) this.status = { state: 'idle', me: this.saved.me, error: '' }
  }

  private save() {
    if (this.disposed) return
    try {
      if (safeStorage.isEncryptionAvailable()) writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.saved)))
    } catch {
      /* not fatal */
    }
  }

  dispose() {
    this.disposed = true
    this.polling = false
  }

  watch(wc: WebContents) {
    this.listeners.add(wc)
    wc.once('destroyed', () => this.listeners.delete(wc))
  }
  private emit(channel: string, payload: unknown) {
    for (const wc of this.listeners) if (!wc.isDestroyed()) wc.send(channel, payload)
  }
  private setStatus(s: Partial<GroupStatus>) {
    this.status = { ...this.status, ...s }
    this.emit('group:status', this.status)
  }

  getStatus(): GroupStatus {
    return this.status
  }

  /* ---------- the server's address ---------- */
  private async lookup(): Promise<string> {
    let res: Response
    try {
      res = await fetch(`${RELAY_URL}/server`, { signal: AbortSignal.timeout(10000) })
    } catch {
      throw new GroupError('Can’t reach the internet to find the group server.')
    }
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok || !j.url) throw new GroupError(j.error || 'The group server isn’t running right now.')
    this.saved.serverUrl = j.url
    this.save()
    return j.url
  }

  /* ---------- signing in ---------- */
  private async signIn(): Promise<void> {
    const cred = this.credentials()
    if (!cred) throw new GroupError('Sign in to your Veyra account to use group work.', 401)
    const id = await fetch(`${RELAY_URL}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: cred.handle, cookie: cred.cookie }),
      signal: AbortSignal.timeout(15000)
    }).catch(() => {
      throw new GroupError('Can’t reach the internet to sign in to group work.')
    })
    const pass: any = await id.json().catch(() => ({}))
    if (!id.ok || !pass.pass) throw new GroupError(pass.error || 'Couldn’t confirm your Veyra account.', id.status)
    const r = await this.raw('POST', '/session', { pass: pass.pass }, false)
    this.saved.session = r.session
    this.saved.me = r.me
    this.save()
  }

  /** One request to the server. */
  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const base = this.saved.serverUrl || (await this.lookup())
    let res: Response
    try {
      res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth && this.saved.session ? { Authorization: `Bearer ${this.saved.session}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(path.startsWith('/poll') ? 40000 : 20000)
      })
    } catch {
      throw new GroupError('The group server didn’t answer.', -1)
    }
    const j: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const { error, ...extra } = j
      // A tunnel address that no longer works (e.g. Cloudflare's 530 / 1033): look it up again.
      throw new GroupError(error || (res.status >= 500 ? 'The group server didn’t answer.' : `The group server answered ${res.status}.`), res.status >= 520 ? -1 : res.status, extra)
    }
    return j
  }

  /** A request with recovery: new address if the server moved, new session if it expired. */
  async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.credentials()) {
      this.setStatus({ state: 'signed-out', error: '' })
      throw new GroupError('Sign in to your Veyra account to use group work.', 401)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.saved.session) await this.signIn()
        const r = await this.raw(method, path, body)
        if (this.status.state !== 'online') this.setStatus({ state: 'online', me: this.saved.me ?? null, error: '' })
        return r
      } catch (e) {
        if (!(e instanceof GroupError) || attempt >= 1) throw e
        if (e.status === 401) {
          this.saved.session = undefined
          continue
        }
        if (e.status === -1) {
          await this.lookup()
          continue
        }
        throw e
      }
    }
  }

  /** Connects (signing in if needed) and starts listening for changes. */
  async connect(): Promise<GroupStatus> {
    if (!this.credentials()) {
      this.setStatus({ state: 'signed-out', me: null, error: '' })
      return this.status
    }
    this.setStatus({ state: 'connecting', error: '' })
    try {
      const r = await this.call('GET', '/me')
      this.saved.me = r.me
      this.save()
      this.setStatus({ state: 'online', me: r.me, error: '' })
      this.poll()
    } catch (e) {
      this.setStatus({ state: 'offline', error: e instanceof GroupError ? e.message : 'Couldn’t connect to the group server.' })
    }
    return this.status
  }

  disconnect(): void {
    this.polling = false
    const s = this.saved.session
    this.saved = { serverUrl: this.saved.serverUrl }
    this.dated.clear()
    this.lastSeq = 0
    rmSync(this.file, { force: true })
    if (s) void this.raw('DELETE', '/session').catch(() => {})
    this.setStatus({ state: 'idle', me: null, error: '' })
  }

  /**
   * Group deadlines and due group tasks as calendar entries. Best effort:
   * offline gives what was last seen, and nothing is ever thrown.
   */
  async deadlines(fromIso: string, toIso: string): Promise<GoogleEvent[]> {
    if (!this.credentials() || !this.saved.session) return []
    // Never hold up Calendar or Today for long: wait up to 3 s, then show what's cached.
    if (Date.now() - this.datedAt > 15000) {
      if (!this.refreshing) {
        this.refreshing = this.refreshDated().finally(() => (this.refreshing = null))
        await Promise.race([this.refreshing, new Promise((r) => setTimeout(r, 3000))])
      }
    }
    const from = fromIso.slice(0, 10)
    const to = toIso.slice(0, 10)
    const out: GoogleEvent[] = []
    const nextDay = (d: string) => {
      const t = new Date(d + 'T00:00:00')
      t.setDate(t.getDate() + 1)
      return t.toLocaleDateString('en-CA')
    }
    for (const { group, items } of this.dated.values()) {
      for (const it of items.values()) {
        const base = { calendar: `${group.name} (group)`, color: group.color, location: '', link: '' }
        if (it.kind === 'event') {
          const e = (it as GroupItem<'event'>).data
          if (!e.date || e.date < from || e.date > to) continue
          if (e.time) {
            const start = new Date(`${e.date}T${e.time}:00`)
            out.push({ ...base, id: `grp-${it.id}`, title: e.title, allDay: false, start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString() })
          } else out.push({ ...base, id: `grp-${it.id}`, title: e.title, allDay: true, start: e.date, end: nextDay(e.date) })
        } else {
          const t = (it as GroupItem<'task'>).data
          if (!t.due || t.done || t.due < from || t.due > to) continue
          out.push({ ...base, id: `grp-${it.id}`, title: `${t.title}${t.assignee ? ` · @${t.assignee}` : ''}`, allDay: true, start: t.due, end: nextDay(t.due) })
        }
      }
    }
    return out
  }

  private refreshing: Promise<void> | null = null
  private async refreshDated(): Promise<void> {
    try {
      const { groups } = (await this.call('GET', '/groups')) as { groups: Group[] }
      for (const id of [...this.dated.keys()]) if (!groups.some((g) => g.id === id)) this.dated.delete(id)
      for (const g of groups) {
        const c = this.dated.get(g.id) ?? { seq: 0, group: g, items: new Map() }
        c.group = g
        const r = (await this.call('GET', `/groups/${encodeURIComponent(g.id)}/items?since=${c.seq}`)) as { items: GroupItem[]; seq: number }
        for (const it of r.items) {
          if (it.deleted || (it.kind !== 'task' && it.kind !== 'event')) c.items.delete(it.id)
          else c.items.set(it.id, it)
        }
        c.seq = r.seq
        this.dated.set(g.id, c)
      }
      this.datedAt = Date.now()
    } catch {
      // Offline: keep what we have and don't try again for a minute.
      this.datedAt = Date.now() + 45000
    }
  }

  /** Long-poll loop: tells the UI when anything in your groups changes. */
  private async poll() {
    if (this.polling) return
    this.polling = true
    let wait = 2000
    while (this.polling && !this.disposed) {
      try {
        const r = await this.call('GET', `/poll?since=${this.lastSeq}`)
        if (r.seq > this.lastSeq) {
          const first = this.lastSeq === 0
          this.lastSeq = r.seq
          this.datedAt = 0
          if (!first) this.emit('group:changed', { seq: r.seq })
        }
        wait = 2000
      } catch (e) {
        if (!this.credentials()) break
        this.setStatus({ state: 'offline', error: e instanceof GroupError ? e.message : 'Lost the connection to the group server.' })
        await new Promise((r) => setTimeout(r, wait))
        wait = Math.min(30000, wait * 2)
      }
    }
    this.polling = false
  }
}
