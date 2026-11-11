/**
 * Group work and personal sync on Android: the same shared clients the
 * desktop uses (shared/group-core.ts, shared/sync-core.ts), with the group
 * session in Keystore-backed secure storage and the phone's IndexedDB as the
 * sync store. Android pauses apps in the background, so both reconnect and
 * catch up whenever the app comes back to the screen.
 */
import { App } from '@capacitor/app'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { GroupStatus, Kind, SyncStatus } from '@shared/types'
import { DEFAULT_RELAY, GroupCore, GroupError, type GroupSaved } from '@shared/group-core'
import { SyncCore } from '@shared/sync-core'
import * as acct from './account'
import * as idb from './idb'

type Cb<T> = (v: T) => void
const statusSubs = new Set<Cb<GroupStatus>>()
const changedSubs = new Set<Cb<{ seq: number }>>()
const syncSubs = new Set<Cb<SyncStatus>>()
const key = () => `veyra.group.${acct.username() ?? 'guest'}`

let onApplied: (kinds: Kind[], ids: string[]) => void = () => {}
export const setOnApplied = (f: typeof onApplied) => (onApplied = f)

export let group: GroupCore
export let sync: SyncCore

/** Makes both clients, once the signed-in account is known (they keep their state per account). */
export function create(): void {
  group = new GroupCore({
    relay: DEFAULT_RELAY,
    load: async () => {
      const raw = await SecureStorage.getItem(key()).catch(() => null)
      return raw ? (JSON.parse(raw) as GroupSaved) : null
    },
    save: (s) => SecureStorage.setItem(key(), JSON.stringify(s)),
    clear: () => SecureStorage.removeItem(key()).then(() => {}),
    credentials: () => acct.credentials(),
    emit: (channel, payload) => {
      if (channel === 'group:status') statusSubs.forEach((f) => f(payload as GroupStatus))
      if (channel === 'group:changed') changedSubs.forEach((f) => f(payload as { seq: number }))
    }
  })

  sync = new SyncCore(
    { meta: idb.meta, setMeta: idb.setMeta, applyRemote: idb.applyRemote, localChangesSince: idb.localChangesSince },
    group,
    (kinds, ids) => onApplied(kinds, ids),
    (s) => syncSubs.forEach((f) => f(s))
  )
}

const sub =
  <T>(set: Set<Cb<T>>) =>
  (cb: Cb<T>) => {
    set.add(cb)
    return () => void set.delete(cb)
  }
export const onGroupStatus = sub(statusSubs)
export const onGroupChanged = sub(changedSubs)
export const onSyncStatus = sub(syncSubs)

/** One group request, answered like the desktop's IPC: { ok, v } or { ok: false, error, status, extra }. */
export async function groupCallRaw(method: string, path: string, body?: unknown) {
  if (!/^\/[A-Za-z0-9\-_/?=&%.@]*$/.test(path) || path.includes('..') || path.startsWith('/session') || path.startsWith('/poll')) return { ok: false as const, error: 'That isn’t a group request.', status: 400 }
  try {
    return { ok: true as const, v: await group.call(method, path, body) }
  } catch (e) {
    if (e instanceof GroupError) return { ok: false as const, error: e.message, status: e.status, extra: e.extra }
    return { ok: false as const, error: 'Something went wrong. Try again.', status: 0 }
  }
}

/** Starts both when signed in, and again each time the app comes back to the screen. */
export function startOnline(): void {
  if (acct.state().mode !== 'account') return
  void group.connect()
  sync.schedule(2000)
  void App.addListener('resume', () => {
    void group.connect()
    sync.schedule(0)
  })
}
