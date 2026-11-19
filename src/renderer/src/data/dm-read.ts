import { useEffect, useMemo, useReducer } from 'react'
import type { Group, GroupInvite, GroupItem } from '@shared/types'
import { dmColorFor, dmGroupName, findDmInviteFrom, findDmWith, isDmGroup, normalizeHandle } from '@shared/dm'
import { gid, groupCall, useGroups, useMultiGroupMessages } from './groups'

const STORAGE_KEY = 'veyra.dmRead'

let cache: Record<string, number> | null = null
const subs = new Set<() => void>()

function load(): Record<string, number> {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (raw && typeof raw === 'object') {
      const next: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v)) next[k] = v
      }
      cache = next
      return cache
    }
  } catch {
    /* storage unavailable */
  }
  cache = {}
  return cache
}

function save(next: Record<string, number>): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  subs.forEach((fn) => fn())
}

export function getDmReadMap(): Record<string, number> {
  return load()
}

export function markDmRead(groupId: string, at: number): void {
  const cur = load()
  const prev = cur[groupId] ?? 0
  if (at <= prev) return
  save({ ...cur, [groupId]: at })
}

export function useDmReadMap(): Record<string, number> {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    subs.add(tick)
    return () => void subs.delete(tick)
  }, [])
  return load()
}

/** Count of incoming messages in a DM received after `readAt`. */
export function unreadCountFor(messages: GroupItem<'message'>[], meUsername: string | null | undefined, readAt: number): number {
  const me = normalizeHandle(meUsername ?? '')
  let n = 0
  for (const m of messages) {
    if (m.createdAt > readAt && normalizeHandle(m.createdBy) !== me) n++
  }
  return n
}

/** Live total of unread DM messages + incoming DM message requests (for Sidebar badge). */
export function useDmBadgeCount(signedIn: boolean, meUsername: string | null | undefined): number {
  const { groups, invites } = useGroups(false)
  const dmIds = useMemo(() => (signedIn ? (groups ?? []).filter(isDmGroup).map((g) => g.id) : []), [signedIn, groups])
  const msgsByDm = useMultiGroupMessages(dmIds)
  const readMap = useDmReadMap()

  return useMemo(() => {
    if (!signedIn) return 0
    let total = invites.filter((inv) => isDmGroup(inv.group)).length
    for (const id of dmIds) {
      total += unreadCountFor(msgsByDm.get(id) ?? [], meUsername, readMap[id] ?? 0)
    }
    return total
  }, [signedIn, invites, dmIds, msgsByDm, meUsername, readMap])
}

/**
 * Finds an existing DM with `otherUsername`, or accepts a pending incoming DM
 * invite from them, or creates a new canonical DM room and invites them.
 */
export async function openOrCreateDm(opts: {
  otherUsername: string
  meUsername: string
  groups: Group[]
  invites: GroupInvite[]
  reload: () => Promise<void>
}): Promise<{ groupId: string; status: 'existing' | 'accepted' | 'created' }> {
  const existing = findDmWith(opts.groups, opts.meUsername, opts.otherUsername)
  if (existing) return { groupId: existing.id, status: 'existing' }

  const pendingInvite = findDmInviteFrom(opts.invites, opts.otherUsername)
  if (pendingInvite) {
    const r = await groupCall<{ group?: Group }>('POST', `/invites/${gid(pendingInvite.id)}/accept`)
    await opts.reload()
    return { groupId: r.group?.id ?? pendingInvite.group.id, status: 'accepted' }
  }

  const name = dmGroupName(opts.meUsername, opts.otherUsername)
  const color = dmColorFor(opts.otherUsername)
  const created = await groupCall<{ group: Group }>('POST', '/groups', { name, color })
  await groupCall('POST', `/groups/${gid(created.group.id)}/invites`, { username: opts.otherUsername })
  await opts.reload()
  return { groupId: created.group.id, status: 'created' }
}
