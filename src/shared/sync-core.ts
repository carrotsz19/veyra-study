/**
 * Personal sync (shared by the desktop and the Android app): your tasks,
 * notes, subjects and study time on every device you sign in to, through the group server on your phone (the same
 * sign-in as Group work, but only ever your own records).
 *
 * Each run pulls what other devices changed since the last cursor, keeps the
 * newer copy of each record, then pushes this device's own changes. Settings
 * stay per device. Attached files aren't copied (only the notes pointing at them).
 */
import type { Kind, Rec, SyncStatus } from './types'
import { GroupError, type GroupCore } from './group-core'

/** The local database, as sync needs it (the desktop's SQLite or the phone's IndexedDB). */
export interface SyncStore {
  meta(key: string): string | undefined | Promise<string | undefined>
  setMeta(key: string, value: string): void | Promise<void>
  applyRemote(r: Rec): boolean | Promise<boolean>
  localChangesSince(since: number, limit?: number): Rec[] | Promise<Rec[]>
}

const MAX_REQUEST = 2_500_000

export class SyncCore {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private disposed = false
  private status: SyncStatus = { enabled: true, state: 'idle', error: '' }
  private ready: Promise<void>

  constructor(
    private store: SyncStore,
    private group: GroupCore,
    /** Called with what other devices changed, so the screens can reload. */
    private onApplied: (kinds: Kind[], ids: string[]) => void,
    /** Tells the screens about sync:status. */
    private emit: (status: SyncStatus) => void
  ) {
    this.ready = (async () => {
      const [on, last] = await Promise.all([store.meta('sync_enabled'), store.meta('sync_last')])
      this.status = { enabled: on !== '0', state: 'idle', lastSync: Number(last || 0) || undefined, error: '' }
    })()
    group.onRemoteChange = () => this.schedule(300)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.group.onRemoteChange = null
  }

  /** For the screens; reads after the saved state has loaded. */
  async state(): Promise<SyncStatus> {
    await this.ready
    return this.status
  }

  getStatus(): SyncStatus {
    return this.status
  }
  private set(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s }
    this.emit(this.status)
  }

  async setEnabled(on: boolean): Promise<SyncStatus> {
    await this.ready
    await this.store.setMeta('sync_enabled', on ? '1' : '0')
    this.set({ enabled: on, state: 'idle', error: '' })
    if (on) this.schedule(0)
    return this.status
  }

  /** Runs soon (local edits wait a moment so typing doesn't sync every keystroke). */
  schedule(ms = 3000): void {
    void this.ready.then(() => {
      if (this.disposed || !this.status.enabled) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.run(), ms)
    })
  }

  async run(): Promise<SyncStatus> {
    await this.ready
    if (this.disposed || !this.status.enabled) return this.status
    if (this.running) {
      this.again = true
      return this.status
    }
    this.running = true
    this.set({ state: 'syncing' })
    try {
      do {
        this.again = false
        await this.pull()
        await this.push()
      } while (this.again && !this.disposed)
      await this.store.setMeta('sync_last', String(Date.now()))
      this.set({ state: 'idle', error: '', lastSync: Date.now() })
    } catch (e) {
      if (this.disposed) return this.status
      const signedOut = e instanceof GroupError && e.status === 401
      this.set({ state: 'error', error: e instanceof GroupError ? (signedOut ? 'Sign in to your Veyra account to sync.' : e.message) : 'Syncing didn’t finish.' })
      // Try again later on its own (the phone may be restarting).
      if (!signedOut) this.schedule(60_000)
    } finally {
      this.running = false
    }
    return this.status
  }

  private async pull(): Promise<void> {
    let since = Number((await this.store.meta('sync_pulled')) || 0)
    const kinds = new Set<Kind>()
    const ids: string[] = []
    for (let page = 0; page < 200; page++) {
      const r = (await this.group.call('GET', `/sync/pull?since=${since}&limit=500`)) as { records: Rec[]; seq: number; more: boolean }
      if (this.disposed) return
      for (const rec of r.records) {
        if (await this.store.applyRemote(rec)) {
          kinds.add(rec.kind)
          ids.push(rec.id)
        }
      }
      since = r.seq
      await this.store.setMeta('sync_pulled', String(since))
      if (!r.more) break
    }
    if (ids.length) this.onApplied([...kinds], ids)
  }

  private async push(): Promise<void> {
    for (let round = 0; round < 500; round++) {
      const through = Number((await this.store.meta('sync_pushed')) || 0)
      const changes = await this.store.localChangesSince(through, 500)
      if (!changes.length) return
      // Keep each request under the server's size limit.
      const batch: Rec[] = []
      let size = 0
      for (const c of changes) {
        const n = JSON.stringify(c).length
        if (batch.length && size + n > MAX_REQUEST) break
        batch.push(c)
        size += n
      }
      await this.group.call('POST', '/sync/push', { records: batch })
      if (this.disposed) return
      await this.store.setMeta('sync_pushed', String(batch[batch.length - 1].updatedAt))
    }
  }
}
