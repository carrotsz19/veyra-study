import type { FriendCard, Group, GroupInvite, GroupItem } from './types'

/**
 * Direct messages run on top of the existing group server with zero server changes
 * by tagging DM rooms with a canonical name (`DM · @userA · @userB`, sorted).
 * Older builds still display a readable label, while new builds separate DMs into
 * the dedicated Messages tab and keep Group work focused on study groups.
 */
export const DM_NAME_RE = /^DM(?:\s*·\s*|:)@([a-z0-9_.-]+)(?:\s*·\s*|:)@([a-z0-9_.-]+)$/i

const DM_COLORS = ['#b3492b', '#3f6b4a', '#2f5f8a', '#7a4f9a', '#a86f1d', '#2f7d7a', '#9a3f63', '#5b5a55']

export function normalizeHandle(username: string): string {
  return username.trim().replace(/^@+/, '').toLowerCase()
}

/** Deterministic canonical name for a 1-on-1 DM between two usernames (max 60 chars). */
export function dmGroupName(userA: string, userB: string): string {
  const a = normalizeHandle(userA)
  const b = normalizeHandle(userB)
  const [u1, u2] = a <= b ? [a, b] : [b, a]
  const pretty = `DM · @${u1} · @${u2}`
  if (pretty.length <= 60) return pretty
  return `DM:@${u1.slice(0, 26)}:@${u2.slice(0, 26)}`
}

/** Parses a DM room name into its two lowercase handles, or null for regular study groups. */
export function parseDmName(name: string | null | undefined): [string, string] | null {
  if (!name) return null
  const m = name.trim().match(DM_NAME_RE)
  if (!m) return null
  return [m[1].toLowerCase(), m[2].toLowerCase()]
}

/** True when a group (or group name) is a 1-on-1 direct message conversation. */
export function isDmGroup(groupOrName: Pick<Group, 'name'> | string | null | undefined): boolean {
  if (!groupOrName) return false
  const name = typeof groupOrName === 'string' ? groupOrName : groupOrName.name
  return parseDmName(name) !== null
}

/** Deterministic colour for a peer's DM room. */
export function dmColorFor(username: string): string {
  const clean = normalizeHandle(username)
  let h = 0
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0
  return DM_COLORS[h % DM_COLORS.length]
}

export interface DmPeer {
  username: string
  displayName: string
  photoUrl: string
  verified: boolean
  /** True once the peer has accepted the invite and appears in group.members. */
  joined: boolean
}

/** Resolves the other person in a DM, even before they accept the invite. */
export function dmPeer(group: Group, meUsername: string | null | undefined, friends?: FriendCard[]): DmPeer {
  const me = normalizeHandle(meUsername ?? '')
  const other = group.members.find((m) => normalizeHandle(m.username) !== me)
  if (other) {
    const f = friends?.find((x) => normalizeHandle(x.username) === normalizeHandle(other.username))
    return {
      username: other.username,
      displayName: other.displayName?.trim() || f?.displayName?.trim() || `@${other.username}`,
      photoUrl: other.photoUrl || f?.photoUrl || '',
      verified: !!other.verified,
      joined: true
    }
  }
  const parsed = parseDmName(group.name)
  const peerHandle = parsed ? (parsed[0] === me ? parsed[1] : parsed[0]) : ''
  const f = peerHandle ? friends?.find((x) => normalizeHandle(x.username) === peerHandle) : undefined
  if (peerHandle) {
    return {
      username: f?.username || peerHandle,
      displayName: f?.displayName?.trim() || `@${peerHandle}`,
      photoUrl: f?.photoUrl || '',
      verified: false,
      joined: false
    }
  }
  const fallback = group.members[0]
  return {
    username: fallback?.username || 'unknown',
    displayName: fallback?.displayName?.trim() || group.name,
    photoUrl: fallback?.photoUrl || '',
    verified: !!fallback?.verified,
    joined: group.members.length > 1
  }
}

/** Resolves the sender of an incoming DM invite. */
export function dmInvitePeer(invite: GroupInvite, meUsername: string | null | undefined, friends?: FriendCard[]): DmPeer {
  const inviter = invite.invitedBy
  if (inviter?.username) {
    const f = friends?.find((x) => normalizeHandle(x.username) === normalizeHandle(inviter.username))
    return {
      username: inviter.username,
      displayName: inviter.displayName?.trim() || f?.displayName?.trim() || `@${inviter.username}`,
      photoUrl: inviter.photoUrl || f?.photoUrl || '',
      verified: !!inviter.verified,
      joined: true
    }
  }
  const me = normalizeHandle(meUsername ?? '')
  const parsed = parseDmName(invite.group.name)
  const peerHandle = parsed ? (parsed[0] === me ? parsed[1] : parsed[0]) : ''
  const f = peerHandle ? friends?.find((x) => normalizeHandle(x.username) === peerHandle) : undefined
  return {
    username: f?.username || peerHandle || 'someone',
    displayName: f?.displayName?.trim() || (peerHandle ? `@${peerHandle}` : invite.group.name),
    photoUrl: f?.photoUrl || '',
    verified: false,
    joined: false
  }
}

/** Finds an existing DM room with `otherUsername` (including pending ones they haven't joined yet). */
export function findDmWith(groups: Group[], meUsername: string | null | undefined, otherUsername: string): Group | undefined {
  const me = normalizeHandle(meUsername ?? '')
  const target = normalizeHandle(otherUsername)
  if (!target) return undefined
  return groups.find((g) => {
    const pair = parseDmName(g.name)
    if (!pair) return false
    if (pair.includes(target) && (!me || pair.includes(me))) return true
    return g.members.some((m) => normalizeHandle(m.username) === target)
  })
}

/** Finds an incoming DM invite already sent by `otherUsername` so we can accept instead of duplicating. */
export function findDmInviteFrom(invites: GroupInvite[], otherUsername: string): GroupInvite | undefined {
  const target = normalizeHandle(otherUsername)
  if (!target) return undefined
  return invites.find((inv) => {
    if (!isDmGroup(inv.group)) return false
    if (inv.invitedBy && normalizeHandle(inv.invitedBy.username) === target) return true
    const pair = parseDmName(inv.group.name)
    return !!pair && pair.includes(target)
  })
}

export interface DmMessageHit {
  groupId: string
  messageId: string
  peer: DmPeer
  text: string
  createdAt: number
  createdBy: string
}

/** Multi-term case-insensitive search across all DM messages, newest first. */
export function searchDmMessages(
  conversations: { group: Group; peer: DmPeer; messages: GroupItem<'message'>[] }[],
  query: string,
  limit = 60
): DmMessageHit[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return []
  const hits: DmMessageHit[] = []
  for (const conv of conversations) {
    for (const m of conv.messages) {
      const text = m.data?.text ?? ''
      if (!text) continue
      const lower = text.toLowerCase()
      if (terms.every((t) => lower.includes(t))) {
        hits.push({
          groupId: conv.group.id,
          messageId: m.id,
          peer: conv.peer,
          text,
          createdAt: m.createdAt,
          createdBy: m.createdBy
        })
      }
    }
  }
  hits.sort((a, b) => b.createdAt - a.createdAt)
  return hits.slice(0, limit)
}
