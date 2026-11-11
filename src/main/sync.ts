/**
 * Personal sync: your tasks, notes, subjects and study time on every
 * computer you sign in to, through the group server on your phone (the same
 * sign-in as Group work, but only ever your own records).
 *
 * Each run pulls what other devices changed since the last cursor, keeps the
 * newer copy of each record, then pushes this device's own changes. Settings
 * stay per device. Attached files aren't copied (only the notes pointing at them).
 */
import { BrowserWindow } from 'electron'
import type { Kind, Rec, SyncStatus } from '../shared/types'
import type { Store } from './db'
import type { GroupClient } from './group'
import { GroupError } from './group'

const MAX_REQUEST = 2_500_000

export class Sync {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private again = false
  private disposed = false
  private status: SyncStatus

  constructor(
    private store: Store,
    private group: GroupClient,
    /** Called with what other devices changed, so the screens can reload. */
    private onApplied: (kinds: Kind[], ids: string[]) => void
  ) {
    this.status = { enabled: store.meta('sync_enabled') !== '0', state: 'idle', lastSync: Number(store.meta('sync_last') || 0) || undefined, error: '' }
    group.onRemoteChange = () => this.schedule(300)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.group.onRemoteChange = null
  }

  getStatus(): SyncStatus {
    return this.status
  }
  private set(s: Partial<SyncStatus>) {
    this.status = { ...this.status, ...s }
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('sync:status', this.status)
  }

  setEnabled(on: boolean): SyncStatus {
    this.store.setMeta('sync_enabled', on ? '1' : '0')
    this.set({ enabled: on, state: 'idle', error: '' })
    if (on) this.schedule(0)
    return this.status
  }

  /** Runs soon (local edits wait a moment so typing doesn't sync every keystroke). */
  schedule(ms = 3000): void {
    if (this.disposed || !this.status.enabled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), ms)
  }

  async run(): Promise<SyncStatus> {
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
      this.store.setMeta('sync_last', String(Date.now()))
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
    let since = Number(this.store.meta('sync_pulled') || 0)
    const kinds = new Set<Kind>()
    const ids: string[] = []
    for (let page = 0; page < 200; page++) {
      const r = (await this.group.call('GET', `/sync/pull?since=${since}&limit=500`)) as { records: Rec[]; seq: number; more: boolean }
      if (this.disposed) return
      for (const rec of r.records) {
        if (this.store.applyRemote(rec)) {
          kinds.add(rec.kind)
          ids.push(rec.id)
        }
      }
      since = r.seq
      this.store.setMeta('sync_pulled', String(since))
      if (!r.more) break
    }
    if (ids.length) this.onApplied([...kinds], ids)
  }

  private async push(): Promise<void> {
    for (let round = 0; round < 500; round++) {
      const through = Number(this.store.meta('sync_pushed') || 0)
      const changes = this.store.localChangesSince(through, 500)
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
      this.store.setMeta('sync_pushed', String(batch[batch.length - 1].updatedAt))
    }
  }
}
