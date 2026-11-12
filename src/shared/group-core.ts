/**
 * Group work client, shared by the desktop (main process) and the Android
 * app. Talks to the group server on the owner's phone, found through the
 * relay. Where its session is kept, how it learns who's signed in, and how it
 * tells the screens about changes are passed in.
 *
 * Sign-in: Veyra session (cookie + handle, held by Accounts) → relay
 * /identify → 15-minute pass → server /session → group session (stored
 * encrypted per account). A 401 re-runs this once.
 */
import type { GoogleEvent, Group, GroupItem, GroupStatus } from './types'

export class GroupError extends Error {
  constructor(
    message: string,
    public status = 0,
    public extra?: unknown
  ) {
    super(message)
  }
}

export const DEFAULT_RELAY = 'https://veyra-study-relay.igreenrobotz.workers.dev'

export interface GroupSaved {
  serverUrl?: string
  session?: string
  me?: GroupStatus['me']
}

export type Credentials = { handle: string; cookie: string } | null
export interface GroupHost {
  relay: string
  /** Where the group session is kept (encrypted on both platforms). */
  load(): GroupSaved | null | Promise<GroupSaved | null>
  save(s: GroupSaved): void | Promise<void>
  clear(): void | Promise<void>
  /** The signed-in Veyra account's handle and cookies, or null. */
  credentials(): Credentials | Promise<Credentials>
  /** Tells the screens: group:status, group:changed. */
  emit(channel: string, payload: unknown): void
}

export class GroupCore {
  private saved: GroupSaved = {}
  private ready: Promise<void>
  private status: GroupStatus = { state: 'idle', me: null, error: '' }
  private polling = false
  private disposed = false
  private lastSeq = 0
  /** Called when the server says something changed (personal sync listens). */
  onRemoteChange: (() => void) | null = null
  /** Shared tasks and deadlines per group, kept up to date with ?since= (for Calendar and Today). */
  private dated = new Map<string, { seq: number; group: Group; items: Map<string, GroupItem> }>()
  private datedAt = 0

  constructor(protected host: GroupHost) {
    this.ready = Promise.resolve()
      .then(() => host.load())
      .then((v) => {
        this.saved = v ?? {}
        if (this.saved.me && this.status.state === 'idle') this.status = { state: 'idle', me: this.saved.me, error: '' }
      })
      .catch(() => {
        this.saved = {}
      })
  }

  private save() {
    if (this.disposed) return
    void Promise.resolve(this.host.save(this.saved)).catch(() => {})
  }
  private credentials() {
    return Promise.resolve(this.host.credentials())
  }
  private get RELAY_URL() {
    return this.host.relay.replace(/\/$/, '')
  }

  dispose() {
    this.disposed = true
    this.polling = false
  }

  private emit(channel: string, payload: unknown) {
    this.host.emit(channel, payload)
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
      res = await fetch(`${this.RELAY_URL}/server`, { signal: AbortSignal.timeout(10000) })
    } catch {
      throw new GroupError('Can’t reach the internet to find the group server.')
    }
    const j: any = await res.json().catch(() => ({}))
    // (api.trycloudflare.com is Cloudflare's own address, never the server's: an old server could publish it by mistake.)
    if (!res.ok || !j.url || /\/\/api\.trycloudflare\.com/i.test(j.url))
      throw new GroupError(j.error || 'The group server is offline right now. It reconnects by itself; try again in a few minutes.')
    this.saved.serverUrl = j.url
    this.save()
    return j.url
  }

  /* ---------- signing in ---------- */
  private async signIn(): Promise<void> {
    const cred = await this.credentials()
    if (!cred) throw new GroupError('Sign in to your Veyra account to use group work.', 401)
    const id = await fetch(`${this.RELAY_URL}/identify`, {
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
      // A tunnel address that no longer works (Cloudflare's 530 / 1033), or an answer that isn't
      // from the group server at all (it always explains its errors): look the address up again.
      const notOurs = res.status >= 520 || typeof error !== 'string'
      throw new GroupError(
        error || (notOurs ? 'The group server isn’t answering right now. It reconnects by itself; try again in a few minutes.' : `The group server answered ${res.status}.`),
        notOurs ? -1 : res.status,
        extra
      )
    }
    return j
  }

  /** A request with recovery: new address if the server moved, new session if it expired. */
  async call(method: string, path: string, body?: unknown): Promise<any> {
    await this.ready
    if (!(await this.credentials())) {
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

  private connecting: Promise<GroupStatus> | null = null
  private wakePoll: (() => void) | null = null
  /**
   * Connects (signing in if needed) and starts listening for changes. With a
   * saved session it goes online straight away and lets the first request
   * (the long-poll) confirm it, so opening Group work costs no extra trip.
   */
  async connect(): Promise<GroupStatus> {
    await this.ready
    if (!(await this.credentials())) {
      this.setStatus({ state: 'signed-out', me: null, error: '' })
      return Promise.resolve(this.status)
    }
    if (this.status.state === 'online' && this.polling) return Promise.resolve(this.status)
    if (this.saved.session && this.saved.me) {
      // Retrying while the poll waits to try again: wake it now; it goes online when it gets through.
      if (this.polling && this.wakePoll) {
        this.setStatus({ state: 'connecting', error: '' })
        this.wakePoll()
        return Promise.resolve(this.status)
      }
      this.setStatus({ state: 'online', me: this.saved.me, error: '' })
      this.poll()
      return Promise.resolve(this.status)
    }
    this.connecting ??= (async () => {
      this.setStatus({ state: 'connecting', error: '' })
      try {
        const r = await this.call('GET', '/me')
        this.saved.me = r.me
        this.save()
        this.setStatus({ state: 'online', me: r.me, error: '' })
        this.poll()
      } catch (e) {
        this.setStatus({ state: 'offline', error: e instanceof GroupError ? e.message : 'Couldn’t connect to the group server.' })
        // Try again by itself in a little while (the server may be restarting).
        setTimeout(() => {
          if (!this.disposed && this.status.state === 'offline') void this.connect()
        }, 20_000)
      }
      return this.status
    })().finally(() => (this.connecting = null))
    return this.connecting
  }

  disconnect(): void {
    this.polling = false
    const s = this.saved.session
    this.saved = { serverUrl: this.saved.serverUrl }
    this.dated.clear()
    this.lastSeq = 0
    void Promise.resolve(this.host.clear()).catch(() => {})
    if (s) void this.raw('DELETE', '/session').catch(() => {})
    this.setStatus({ state: 'idle', me: null, error: '' })
  }

  /**
   * Group deadlines and due group tasks as calendar entries. Best effort:
   * offline gives what was last seen, and nothing is ever thrown.
   */
  async deadlines(fromIso: string, toIso: string): Promise<GoogleEvent[]> {
    await this.ready
    if (!(await this.credentials()) || !this.saved.session) return []
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
        // Back after a dropout (the server restarting, a new address): a quick check first, so the
        // banner goes as soon as it answers (the long poll below can wait a while before it returns).
        if (this.status.state !== 'online') {
          await this.call('GET', '/me')
          this.setStatus({ state: 'online', me: this.saved.me ?? this.status.me, error: '' })
        }
        const r = await this.call('GET', `/poll?since=${this.lastSeq}`)
        if (r.seq > this.lastSeq) {
          this.onRemoteChange?.()
          const first = this.lastSeq === 0
          this.lastSeq = r.seq
          this.datedAt = 0
          if (!first) this.emit('group:changed', { seq: r.seq })
        }
        wait = 2000
      } catch (e) {
        if (!(await this.credentials())) break
        this.setStatus({ state: 'offline', error: e instanceof GroupError ? e.message : 'Lost the connection to the group server.' })
        await new Promise<void>((r) => {
          this.wakePoll = r
          setTimeout(r, wait)
        })
        this.wakePoll = null
        wait = Math.min(30000, wait * 2)
      }
    }
    this.polling = false
  }
}
