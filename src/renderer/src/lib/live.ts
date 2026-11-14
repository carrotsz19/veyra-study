import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'

/**
 * Editing a shared note together (server: /docs). The note's text lives in a Yjs document;
 * every change is a small update sent to the Veyra server, which hands it to everyone else
 * (they wait for changes with a long poll, so they arrive within a second or two). Yjs merges
 * changes made at the same time, letter by letter, so nobody's typing is lost.
 *
 * Offline (or while the server sleeps) changes queue up on this device, together with a copy
 * of the whole document, and go out when the server is back.
 */

/** How to reach the server: signed in (the app), or through the website's /api (a link page). */
export type Caller = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<any>
type Can = 'edit' | 'view' | null

const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* full or unavailable: it still works while the app is open */
    }
  }
}
const REMOTE = 'remote'

export class LiveDoc {
  readonly doc = new Y.Doc()
  /** Who else is here and where their cursor is (shown in the main notes area). */
  readonly awareness = new Awareness(this.doc)
  /** Edit, view, or not allowed (known once the server has answered). */
  can: Can = null
  /** The server has been reached at least once (or there's a copy on this device). */
  ready: Promise<void>
  private seq = 0
  private stopped = false
  private sending = false
  private pending: Uint8Array[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private sinceSnapshot = 0
  private listeners = new Set<() => void>()
  private markReady!: () => void
  private presenceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly id: string,
    private share: string,
    private call: Caller
  ) {
    this.ready = new Promise((r) => (this.markReady = r))
    // What this device already had: the document, and changes not sent yet.
    const saved = store.get(`veyra.live.${id}`)
    if (saved) {
      try {
        const j = JSON.parse(saved) as { state: string; seq: number; can: Can; pending: string[] }
        Y.applyUpdate(this.doc, unb64(j.state), REMOTE)
        this.seq = j.seq || 0
        this.can = j.can
        this.pending = (j.pending ?? []).map(unb64)
        this.markReady()
      } catch {
        /* start fresh */
      }
    }
    // Our cursor (and name) goes out a moment after it moves; Awareness repeats it every 15 s.
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE || ![...added, ...updated, ...removed].includes(this.doc.clientID)) return
      if (this.presenceTimer) return
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null
        void this.sendPresence()
      }, 250)
    })
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      this.save()
      if (origin === REMOTE) return
      this.pending.push(u)
      this.schedule(300)
    })
    void this.loop()
  }

  /** Runs when the server says something new (who can edit, mostly). */
  onChange(f: () => void): () => void {
    this.listeners.add(f)
    return () => void this.listeners.delete(f)
  }
  isEmpty(field: string): boolean {
    return this.doc.getXmlFragment(field).length === 0
  }

  private q = () => (this.share ? `&share=${encodeURIComponent(this.share)}` : '')
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private save() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      store.set(`veyra.live.${this.id}`, JSON.stringify({ state: b64(Y.encodeStateAsUpdate(this.doc)), seq: this.seq, can: this.can, pending: this.pending.map(b64) }))
    }, 1500)
  }

  private async sendPresence(gone = false) {
    if (!this.awareness.getLocalState()?.user && !gone) return
    try {
      await this.call('POST', `/docs/${this.id}/presence?x=1${this.q()}`, {
        client: this.doc.clientID,
        data: b64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])),
        ...(gone ? { gone: true } : {})
      })
    } catch {
      /* the next move sends it again */
    }
  }

  private apply(r: { snapshot: string | null; updates: string[]; seq: number; can: Can; presence?: { client: number; data: string }[] }) {
    for (const p of r.presence ?? []) {
      if (p.client === this.doc.clientID) continue
      try {
        applyAwarenessUpdate(this.awareness, unb64(p.data), REMOTE)
      } catch {
        /* someone's cursor from an older app */
      }
    }
    Y.transact(this.doc, () => {
      if (r.snapshot) Y.applyUpdate(this.doc, unb64(r.snapshot), REMOTE)
      for (const u of r.updates) Y.applyUpdate(this.doc, unb64(u), REMOTE)
    }, REMOTE)
    if (r.snapshot) this.sinceSnapshot = 0
    this.sinceSnapshot += r.updates.length
    this.seq = r.seq
    if (this.can !== r.can) {
      this.can = r.can
      this.listeners.forEach((f) => f())
    }
    this.save()
  }

  /** Keeps up with everyone else's changes for as long as the note is open. */
  private async loop() {
    let wait = 1000
    let first = true
    while (!this.stopped) {
      try {
        const r = await this.call('GET', `/docs/${this.id}?since=${this.seq}${first ? '' : '&wait=1'}${this.q()}`)
        this.apply(r)
        if (first) {
          first = false
          this.markReady()
          this.schedule(0) // anything made offline goes now
        }
        wait = 1000
        if (r.updates.length >= 500) continue
      } catch {
        // Offline or the server is asleep: try again, more slowly.
        await new Promise((res) => setTimeout(res, wait))
        wait = Math.min(30_000, wait * 2)
      }
    }
  }

  private schedule(ms: number) {
    if (this.timer || this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.send()
    }, ms)
  }

  /** Sends what changed here (all at once), keeping it until the server has it. */
  private async send() {
    if (this.sending || !this.pending.length || this.can !== 'edit') return
    this.sending = true
    const batch = this.pending.slice()
    try {
      await this.call('POST', `/docs/${this.id}?x=1${this.q()}`, { update: b64(Y.mergeUpdates(batch)) })
      this.pending = this.pending.slice(batch.length)
      this.save()
      // Now and then, one snapshot replaces the many small changes on the server.
      if (++this.sinceSnapshot > 300) {
        this.sinceSnapshot = 0
        void this.call('POST', `/docs/${this.id}/snapshot?x=1${this.q()}`, { data: b64(Y.encodeStateAsUpdate(this.doc)), upto: this.seq }).catch(() => {})
      }
    } catch {
      setTimeout(() => this.schedule(0), 4000)
    } finally {
      this.sending = false
      if (this.pending.length) this.schedule(300)
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    void this.send()
    // Leaving: our cursor goes from everyone else's screen.
    void this.sendPresence(true)
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    this.awareness.destroy()
  }
}

/* ---------- one document per note, however many editors (content, cues, summary) use it ---------- */
const open = new Map<string, { live: LiveDoc; users: number }>()
export function openLive(id: string, share: string, call: Caller): LiveDoc {
  let e = open.get(id)
  if (!e) {
    e = { live: new LiveDoc(id, share, call), users: 0 }
    open.set(id, e)
  }
  e.users++
  return e.live
}
export function releaseLive(id: string) {
  const e = open.get(id)
  if (!e) return
  if (--e.users <= 0) {
    // Kept a moment, so switching notes back and forth doesn't reconnect.
    setTimeout(() => {
      if (e!.users <= 0 && open.get(id) === e) {
        e!.live.stop()
        open.delete(id)
      }
    }, 30_000)
  }
}
