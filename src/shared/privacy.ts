import type { AppSettings, PrivacyAudience } from './settings'
import type { FriendCard, Group, GroupInvite } from './types'

const DM_NAME_RE = /^DM(?:\s*·\s*|:)@([a-z0-9_.-]+)(?:\s*·\s*|:)@([a-z0-9_.-]+)$/i

function cleanHandle(u: string | null | undefined): string {
  return (u ?? '').trim().replace(/^@+/, '').toLowerCase()
}

function parseDmHandles(name: string): [string, string] | null {
  const m = DM_NAME_RE.exec(name.trim())
  return m ? [m[1].toLowerCase(), m[2].toLowerCase()] : null
}

function dmPeerUsername(group: Group, meUsername: string | null | undefined): string {
  const me = cleanHandle(meUsername)
  const otherMember = group.members.find((m) => cleanHandle(m.username) !== me)
  if (otherMember) return cleanHandle(otherMember.username)
  const pair = parseDmHandles(group.name)
  if (!pair) return ''
  return pair[0] === me ? pair[1] : pair[0]
}

/** True when `username` is in the signed-in user's Veyra friends list. */
export function isFriendUsername(username: string | null | undefined, friends: readonly Pick<FriendCard, 'username'>[]): boolean {
  const clean = cleanHandle(username)
  if (!clean) return false
  return friends.some((f) => cleanHandle(f.username) === clean)
}

/** Evaluates a 3-way audience rule (`everyone` / `friends` / `nobody`) for a given relationship. */
export function allowsAudience(audience: PrivacyAudience, isFriend: boolean): boolean {
  if (audience === 'everyone') return true
  if (audience === 'friends') return isFriend
  return false
}

export type MessagingPrivacy = Pick<AppSettings, 'dmWhoCanMessage' | 'dmWhoCanRequest' | 'groupWhoCanAdd'>

/** Whether direct messages from `peerUsername` are allowed by the user's "Who can text you" setting. */
export function canPeerTextYou(
  peerUsername: string | null | undefined,
  privacy: Pick<MessagingPrivacy, 'dmWhoCanMessage'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  return allowsAudience(privacy.dmWhoCanMessage, isFriendUsername(peerUsername, friends))
}

/** Whether an incoming DM message request from `inviterUsername` is allowed. */
export function canPeerRequestDm(
  inviterUsername: string | null | undefined,
  privacy: Pick<MessagingPrivacy, 'dmWhoCanMessage' | 'dmWhoCanRequest'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  if (privacy.dmWhoCanMessage === 'nobody') return false
  return allowsAudience(privacy.dmWhoCanRequest, isFriendUsername(inviterUsername, friends))
}

/** Whether a study group invite from `inviterUsername` is allowed by "Who can add you to groups". */
export function canPeerInviteToGroup(
  inviterUsername: string | null | undefined,
  privacy: Pick<MessagingPrivacy, 'groupWhoCanAdd'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  return allowsAudience(privacy.groupWhoCanAdd, isFriendUsername(inviterUsername, friends))
}

/** Convenience filter for DM conversations against `dmWhoCanMessage`. */
export function isDmGroupAllowed(
  group: Group,
  meUsername: string | null | undefined,
  privacy: Pick<MessagingPrivacy, 'dmWhoCanMessage'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  if (!parseDmHandles(group.name)) return true
  if (privacy.dmWhoCanMessage === 'everyone') return true
  if (privacy.dmWhoCanMessage === 'nobody') return false
  return canPeerTextYou(dmPeerUsername(group, meUsername), privacy, friends)
}

/** Convenience filter for incoming DM requests against `dmWhoCanMessage` + `dmWhoCanRequest`. */
export function isDmInviteAllowed(
  invite: GroupInvite,
  meUsername: string | null | undefined,
  privacy: Pick<MessagingPrivacy, 'dmWhoCanMessage' | 'dmWhoCanRequest'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  const me = cleanHandle(meUsername)
  const pair = parseDmHandles(invite.group.name)
  const inviter = cleanHandle(invite.invitedBy?.username) || (pair ? (pair[0] === me ? pair[1] : pair[0]) : '')
  return canPeerRequestDm(inviter, privacy, friends)
}

/** Convenience filter for incoming study group invites against `groupWhoCanAdd`. */
export function isGroupInviteAllowed(
  invite: GroupInvite,
  privacy: Pick<MessagingPrivacy, 'groupWhoCanAdd'>,
  friends: readonly Pick<FriendCard, 'username'>[]
): boolean {
  if (privacy.groupWhoCanAdd === 'everyone') return true
  if (privacy.groupWhoCanAdd === 'nobody') return false
  return canPeerInviteToGroup(invite.invitedBy?.username, privacy, friends)
}
