/**
 * The phone's database: the same records as the desktop's SQLite (id, kind,
 * data, createdAt, updatedAt, deletedAt, deviceId), kept in IndexedDB, with
 * the same rules for timestamps and for merging records from other devices,
 * so sync behaves identically on both.
 */
import type { DataByKind, Kind, Rec } from '@shared/types'

/** Each account has its own database on the phone; "veyra-study" holds data from before signing in. */
const GUEST_DB = 'veyra-study'
let name = GUEST_DB
let device: string | null = null
let dbp: Promise<IDBDatabase> | null = null

/** Picks the database (at start-up, before anything reads). */
export function useDatabase(db: string): void {
  if (db === name && dbp) return
  name = db
  dbp = null
  device = null
}

function openNamed(db: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      const recs = db.createObjectStore('records', { keyPath: 'id' })
      recs.createIndex('updatedAt', 'updatedAt')
      recs.createIndex('kind', 'kind')
      db.createObjectStore('meta')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function open(): Promise<IDBDatabase> {
  dbp ??= openNamed(name)
  return dbp
}

/** The first account signed in on this phone takes over what was made before (if its own database is empty). */
export async function adoptGuestInto(target: string): Promise<void> {
  if (target === GUEST_DB) return
  const [from, to] = await Promise.all([openNamed(GUEST_DB), openNamed(target)])
  try {
    const have = await done(to.transaction('records').objectStore('records').count())
    if (have) return
    const recs = (await done(from.transaction('records').objectStore('records').getAll())) as Rec[]
    if (!recs.length) return
    const tx = to.transaction('records', 'readwrite')
    for (const r of recs) if (r.kind !== 'settings') tx.objectStore('records').put(r)
    await new Promise<void>((res, rej) => ((tx.oncomplete = () => res()), (tx.onerror = () => rej(tx.error))))
    const clear = from.transaction('records', 'readwrite')
    clear.objectStore('records').clear()
    await new Promise<void>((res) => (clear.oncomplete = () => res()))
  } finally {
    from.close()
    to.close()
  }
}
const done = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))))
async function store(name: 'records' | 'meta', mode: IDBTransactionMode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name)
}

export async function meta(key: string): Promise<string | undefined> {
  return (await done((await store('meta')).get(key))) as string | undefined
}
export async function setMeta(key: string, value: string): Promise<void> {
  await done((await store('meta', 'readwrite')).put(value, key))
}

export async function deviceId(): Promise<string> {
  if (device) return device
  device = (await meta('device_id')) ?? null
  if (!device) {
    device = crypto.randomUUID()
    await setMeta('device_id', device)
  }
  return device
}

let lastStamp = 0
/** Strictly increasing, and always newer than the version being edited. */
const stamp = (after = 0) => (lastStamp = Math.max(Date.now(), lastStamp + 1, after + 1))

const get = async (id: string) => (await done((await store('records')).get(id))) as Rec | undefined

export async function list<K extends Kind>(kind: K): Promise<Rec<K>[]> {
  const all = (await done((await store('records')).index('kind').getAll(kind))) as Rec<K>[]
  return all.filter((r) => !r.deletedAt).sort((a, b) => a.createdAt - b.createdAt)
}

export async function put<K extends Kind>(kind: K, data: DataByKind[K], id?: string): Promise<Rec<K>> {
  const existing = id ? await get(id) : undefined
  const now = stamp(existing?.updatedAt)
  const rec = { id: id ?? crypto.randomUUID(), kind, data, createdAt: existing?.createdAt ?? now, updatedAt: now, deletedAt: null, deviceId: await deviceId() } as Rec<K>
  await done((await store('records', 'readwrite')).put(rec))
  return rec
}

export async function remove(id: string): Promise<void> {
  const existing = await get(id)
  if (!existing) return
  const now = stamp(existing.updatedAt)
  await done((await store('records', 'readwrite')).put({ ...existing, deletedAt: now, updatedAt: now, deviceId: await deviceId() }))
}

export async function changesSince(since: number): Promise<Rec[]> {
  return (await done((await store('records')).index('updatedAt').getAll(IDBKeyRange.lowerBound(since, true)))) as Rec[]
}

/** This phone's own changes after `since`, oldest first (what sync sends). Settings stay per device. */
export async function localChangesSince(since: number, limit = 500): Promise<Rec[]> {
  const me = await deviceId()
  return (await changesSince(since)).filter((r) => r.deviceId === me && r.kind !== 'settings').slice(0, limit)
}

/** A record from another device, kept only if newer (ties: the higher device id), the same rule as the server. */
export async function applyRemote(r: Rec): Promise<boolean> {
  if (r.kind === 'settings') return false
  const ex = await get(r.id)
  if (ex && (ex.kind !== r.kind || ex.updatedAt > r.updatedAt || (ex.updatedAt === r.updatedAt && ex.deviceId >= r.deviceId))) return false
  await done((await store('records', 'readwrite')).put({ ...r, deletedAt: r.deletedAt ?? null }))
  return true
}
