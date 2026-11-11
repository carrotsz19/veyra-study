import { useCallback, useEffect, useRef, useState } from 'react'
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

/** The connection, connecting the first time Group work opens. */
export function useGroupStatus(): { status: GroupStatus | null; retry: () => void } {
  const [status, setStatus] = useState<GroupStatus | null>(null)
  useEffect(() => {
    let live = true
    const off = api.onStatus((s) => live && setStatus(s))
    api.status().then((s) => {
      if (!live) return
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

/** Your groups and pending invites, kept fresh. */
export function useGroups(online: boolean) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [invites, setInvites] = useState<GroupInvite[]>([])
  const load = useCallback(async () => {
    try {
      const [g, i] = await Promise.all([groupCall<{ groups: Group[] }>('GET', '/groups'), groupCall<{ invites: GroupInvite[] }>('GET', '/invites')])
      setGroups(g.groups)
      setInvites(i.invites)
    } catch {
      /* the status card shows what went wrong */
    }
  }, [])
  useEffect(() => {
    if (online) void load()
  }, [online, load])
  useGroupChanged(load)
  return { groups, invites, reload: load, setGroups }
}

/** Everything in one group, fetched once and then only what changed. */
export function useGroupItems(groupId: string) {
  const [items, setItems] = useState<Map<string, GroupItem>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const busy = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const load = useCallback(async () => {
    if (busy.current) {
      again.current = true
      return busy.current
    }
    busy.current = (async () => {
      do {
        again.current = false
        try {
          const r = await groupCall<{ items: GroupItem[]; seq: number }>('GET', `/groups/${gid(groupId)}/items?since=${seq.current}`)
          seq.current = Math.max(seq.current, r.seq)
          if (r.items.length)
            setItems((old) => {
              const m = new Map(old)
              for (const it of r.items) {
                const mine = m.get(it.id)
                if (mine && mine.seq > it.seq) continue
                if (it.deleted) m.delete(it.id)
                else m.set(it.id, it)
              }
              return m
            })
          setError('')
          setLoaded(true)
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Couldn’t load this group.')
        }
      } while (again.current)
      busy.current = null
    })()
    return busy.current
  }, [groupId])

  useEffect(() => {
    void load()
  }, [load])
  useGroupChanged(load)

  /** Puts a saved item in straight away (before the change feed confirms it). */
  const apply = useCallback((it: GroupItem | { id: string; deleted: true }) => {
    setItems((old) => {
      const m = new Map(old)
      if ('kind' in it && !it.deleted) m.set(it.id, it)
      else m.delete(it.id)
      return m
    })
  }, [])

  const list = <K extends GroupItemKind>(kind: K) => [...items.values()].filter((i) => i.kind === kind) as GroupItem<K>[]
  return { items, list, loaded, error, apply, reload: load }
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
