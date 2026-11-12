import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Group, GroupInvite, GroupItem, GroupItemData, GroupItemKind, GroupStatus } from '@shared/types'

const api = window.veyra.group

/** A failed group request, with the server's message and (for a note conflict) its newer copy. */
export class GroupCallError extends Error {
  constructor(
    message: string,
    public status: number,
    public extra?: any
  ) {
    super(message)
  }
}

export async function groupCall<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const r = await api.callRaw(method, path, body)
  if (!r.ok) throw new GroupCallError(r.error, r.status, r.extra)
  return r.v as T
}

export const gid = (id: string) => encodeURIComponent(id)

/** Runs whenever anything in your groups or invites changes on the server. */
export function useGroupChanged(cb: () => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => api.onChanged(() => ref.current()), [])
}

/* ---------- shared state, so Group work opens with what was already loaded ---------- */

/** Runs a load; a call that comes in while one is running runs it once more after. */
function serial(fn: () => Promise<void>): () => Promise<void> {
  let busy: Promise<void> | null = null
  let again = false
  return () => {
    if (busy) {
      again = true
      return busy
    }
    busy = (async () => {
      do {
        again = false
        await fn()
      } while (again)
      busy = null
    })()
    return busy
  }
}

let lastStatus: GroupStatus | null = null
api.onStatus((s) => (lastStatus = s))

/** The connection (the app starts connecting in the background when it opens). */
export function useGroupStatus(): { status: GroupStatus | null; retry: () => void } {
  const [status, setStatus] = useState<GroupStatus | null>(lastStatus)
  useEffect(() => {
    let live = true
    const off = api.onStatus((s) => live && setStatus(s))
    api.status().then((s) => {
      if (!live) return
      lastStatus = s
      setStatus(s)
      if (s.state === 'idle' || s.state === 'offline' || s.state === 'signed-out') api.connect().then((r) => live && setStatus(r))
    })
    return () => {
      live = false
      off()
    }
  }, [])
  const retry = useCallback(() => {
    api.connect().then(setStatus)
  }, [])
  return { status, retry }
}

/* your groups and invites */
let groupsCache: { groups: Group[] | null; invites: GroupInvite[] } = { groups: null, invites: [] }
const groupSubs = new Set<() => void>()
const notifyGroups = () => groupSubs.forEach((f) => f())
const loadGroups = serial(async () => {
  try {
    const [g, i] = await Promise.all([groupCall<{ groups: Group[] }>('GET', '/groups'), groupCall<{ invites: GroupInvite[] }>('GET', '/invites')])
    groupsCache = { groups: g.groups, invites: i.invites }
    for (const id of [...stores.keys()]) if (!g.groups.some((x) => x.id === id)) stores.delete(id)
    notifyGroups()
  } catch {
    /* the status card shows what went wrong */
  }
})

/** Your groups and pending invites, kept fresh. */
export function useGroups(online: boolean) {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    groupSubs.add(tick)
    return () => void groupSubs.delete(tick)
  }, [])
  useEffect(() => {
    if (online) void loadGroups()
  }, [online])
  const setGroups = useCallback((fn: (all: Group[] | null) => Group[] | null) => {
    groupsCache = { ...groupsCache, groups: fn(groupsCache.groups) }
    notifyGroups()
  }, [])
  return { groups: groupsCache.groups, invites: groupsCache.invites, reload: loadGroups, setGroups }
}

/* each group's items, fetched once and then only what changed */
interface ItemStore {
  seq: number
  items: Map<string, GroupItem>
  loaded: boolean
  error: string
  subs: Set<() => void>
  load: () => Promise<void>
}
const stores = new Map<string, ItemStore>()
function itemStore(groupId: string): ItemStore {
  let s = stores.get(groupId)
  if (s) return s
  const st: ItemStore = { seq: 0, items: new Map(), loaded: false, error: '', subs: new Set(), load: async () => {} }
  st.load = serial(async () => {
    try {
      const r = await groupCall<{ items: GroupItem[]; seq: number }>('GET', `/groups/${gid(groupId)}/items?since=${st.seq}`)
      st.seq = Math.max(st.seq, r.seq)
      if (r.items.length) {
        const m = new Map(st.items)
        for (const it of r.items) {
          const mine = m.get(it.id)
          if (mine && mine.seq > it.seq) continue
          if (it.deleted) m.delete(it.id)
          else m.set(it.id, it)
        }
        st.items = m
      }
      st.error = ''
      st.loaded = true
    } catch (e) {
      st.error = e instanceof Error ? e.message : 'Couldn’t load this group.'
    }
    st.subs.forEach((f) => f())
  })
  stores.set(groupId, st)
  return st
}

// One listener for the whole app: refresh what's loaded when anything changes.
api.onChanged(() => {
  if (groupsCache.groups) void loadGroups()
  for (const s of stores.values()) if (s.subs.size || s.loaded) void s.load()
})

/** Loads Group work in the background (called when the app starts), so the tab opens ready. */
export function prefetchGroups(): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    let open: string | null = null
    try {
      open = localStorage.getItem('veyra.group')
    } catch {
      /* storage unavailable */
    }
    if (open) void itemStore(open).load()
    // Then every other group, so switching between them never shows "Loading…".
    void loadGroups().then(() => {
      for (const g of groupsCache.groups ?? []) if (!itemStore(g.id).loaded) void itemStore(g.id).load()
    })
  }
  const off = api.onStatus((s) => s.state === 'online' && run())
  api.status().then((s) => s.state === 'online' && run())
  return off
}

/** Everything in one group. */
export function useGroupItems(groupId: string) {
  const s = itemStore(groupId)
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    s.subs.add(tick)
    void s.load()
    return () => void s.subs.delete(tick)
  }, [s])

  /** Puts a saved item in straight away (before the change feed confirms it). */
  const apply = useCallback(
    (it: GroupItem | { id: string; deleted: true }) => {
      const m = new Map(s.items)
      if ('kind' in it && !it.deleted) m.set(it.id, it)
      else m.delete(it.id)
      s.items = m
      s.subs.forEach((f) => f())
    },
    [s]
  )

  const items = s.items
  const list = <K extends GroupItemKind>(kind: K) => [...items.values()].filter((i) => i.kind === kind) as GroupItem<K>[]
  return { items, list, loaded: s.loaded, error: s.error, apply, reload: s.load }
}

export type ItemsApi = ReturnType<typeof useGroupItems>

/* ---------- writes ---------- */
export async function addItem<K extends GroupItemKind>(groupId: string, kind: K, data: GroupItemData[K]): Promise<GroupItem<K>> {
  return (await groupCall<{ item: GroupItem<K> }>('POST', `/groups/${gid(groupId)}/items`, { kind, data })).item
}
export async function saveItem<K extends GroupItemKind>(groupId: string, item: GroupItem<K>, data: GroupItemData[K]): Promise<GroupItem<K>> {
  return (await groupCall<{ item: GroupItem<K> }>('PUT', `/groups/${gid(groupId)}/items/${gid(item.id)}`, { data, rev: item.rev })).item
}
export async function deleteItem(groupId: string, id: string): Promise<void> {
  await groupCall('DELETE', `/groups/${gid(groupId)}/items/${gid(id)}`)
}

export const GROUP_COLORS = ['#b3492b', '#3f6b4a', '#2f5f8a', '#7a4f9a', '#a86f1d', '#2f7d7a', '#9a3f63', '#5b5a55']
