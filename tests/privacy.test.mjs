// Unit tests for messaging & group privacy rules, new settings defaults, and ChatNotifier allowGroup filtering.
// Run: node --test tests/privacy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowsAudience,
  canPeerInviteToGroup,
  canPeerRequestDm,
  canPeerTextYou,
  isDmGroupAllowed,
  isDmInviteAllowed,
  isFriendUsername,
  isGroupInviteAllowed
} from '../src/shared/privacy.ts'
import { DEFAULT_SETTINGS, withDefaults } from '../src/shared/settings.ts'
import { ChatNotifier } from '../src/shared/chat-notify.ts'

function mkGroup(id, name, members = []) {
  return {
    id,
    name,
    color: '#2f5f8a',
    owner: members[0]?.username ?? 'alice',
    role: 'owner',
    createdAt: 1_700_000_000_000,
    members: members.map((m) => ({
      username: m.username,
      displayName: m.displayName ?? m.username,
      photoUrl: '',
      verified: false,
      role: 'member',
      joinedAt: 1_700_000_000_000
    }))
  }
}

const friends = [{ username: 'Alice' }, { username: 'sam_r' }]

test('isFriendUsername normalizes leading @ and case', () => {
  assert.equal(isFriendUsername('@alice', friends), true)
  assert.equal(isFriendUsername('SAM_R', friends), true)
  assert.equal(isFriendUsername('stranger', friends), false)
  assert.equal(isFriendUsername('', friends), false)
  assert.equal(isFriendUsername(null, friends), false)
})

test('allowsAudience handles everyone, friends, and nobody', () => {
  assert.equal(allowsAudience('everyone', false), true)
  assert.equal(allowsAudience('everyone', true), true)
  assert.equal(allowsAudience('friends', true), true)
  assert.equal(allowsAudience('friends', false), false)
  assert.equal(allowsAudience('nobody', true), false)
  assert.equal(allowsAudience('nobody', false), false)
})

test('canPeerTextYou, canPeerRequestDm, and canPeerInviteToGroup obey settings', () => {
  assert.equal(canPeerTextYou('stranger', { dmWhoCanMessage: 'everyone' }, friends), true)
  assert.equal(canPeerTextYou('stranger', { dmWhoCanMessage: 'friends' }, friends), false)
  assert.equal(canPeerTextYou('alice', { dmWhoCanMessage: 'friends' }, friends), true)
  assert.equal(canPeerTextYou('alice', { dmWhoCanMessage: 'nobody' }, friends), false)

  // If dmWhoCanMessage is nobody, requests are always blocked too.
  assert.equal(canPeerRequestDm('alice', { dmWhoCanMessage: 'nobody', dmWhoCanRequest: 'everyone' }, friends), false)
  assert.equal(canPeerRequestDm('stranger', { dmWhoCanMessage: 'everyone', dmWhoCanRequest: 'friends' }, friends), false)
  assert.equal(canPeerRequestDm('alice', { dmWhoCanMessage: 'everyone', dmWhoCanRequest: 'friends' }, friends), true)
  assert.equal(canPeerRequestDm('alice', { dmWhoCanMessage: 'everyone', dmWhoCanRequest: 'nobody' }, friends), false)

  assert.equal(canPeerInviteToGroup('stranger', { groupWhoCanAdd: 'everyone' }, friends), true)
  assert.equal(canPeerInviteToGroup('stranger', { groupWhoCanAdd: 'friends' }, friends), false)
  assert.equal(canPeerInviteToGroup('sam_r', { groupWhoCanAdd: 'friends' }, friends), true)
  assert.equal(canPeerInviteToGroup('sam_r', { groupWhoCanAdd: 'nobody' }, friends), false)
})

test('isDmGroupAllowed leaves study groups untouched and filters DM conversations', () => {
  const studyGroup = mkGroup('g1', 'Physics Lab', [{ username: 'me' }, { username: 'stranger' }])
  const dmFriend = mkGroup('dm1', 'DM · @alice · @me', [{ username: 'me' }, { username: 'alice' }])
  const dmStranger = mkGroup('dm2', 'DM · @me · @stranger', [{ username: 'me' }, { username: 'stranger' }])

  assert.equal(isDmGroupAllowed(studyGroup, 'me', { dmWhoCanMessage: 'nobody' }, friends), true)
  assert.equal(isDmGroupAllowed(dmFriend, 'me', { dmWhoCanMessage: 'friends' }, friends), true)
  assert.equal(isDmGroupAllowed(dmStranger, 'me', { dmWhoCanMessage: 'friends' }, friends), false)
  assert.equal(isDmGroupAllowed(dmFriend, 'me', { dmWhoCanMessage: 'nobody' }, friends), false)
})

test('isDmInviteAllowed and isGroupInviteAllowed filter incoming invites accurately', () => {
  const dmInvFriend = {
    id: 'inv1',
    group: { id: 'dm1', name: 'DM · @alice · @me', color: '#333' },
    invitedBy: { username: 'alice', displayName: 'Alice', photoUrl: '', verified: false },
    createdAt: 100
  }
  const dmInvStranger = {
    id: 'inv2',
    group: { id: 'dm2', name: 'DM · @me · @stranger', color: '#333' },
    invitedBy: { username: 'stranger', displayName: 'Stranger', photoUrl: '', verified: false },
    createdAt: 100
  }
  const grpInvStranger = {
    id: 'inv3',
    group: { id: 'g1', name: 'Bio 101', color: '#333' },
    invitedBy: { username: 'stranger', displayName: 'Stranger', photoUrl: '', verified: false },
    createdAt: 100
  }

  assert.equal(isDmInviteAllowed(dmInvFriend, 'me', { dmWhoCanMessage: 'everyone', dmWhoCanRequest: 'friends' }, friends), true)
  assert.equal(isDmInviteAllowed(dmInvStranger, 'me', { dmWhoCanMessage: 'everyone', dmWhoCanRequest: 'friends' }, friends), false)
  assert.equal(isGroupInviteAllowed(grpInvStranger, { groupWhoCanAdd: 'friends' }, friends), false)
  assert.equal(isGroupInviteAllowed(grpInvStranger, { groupWhoCanAdd: 'everyone' }, friends), true)
})

test('withDefaults preserves and defaults assistantCollapseSidebar and privacy settings', () => {
  const d = withDefaults({})
  assert.equal(d.assistantCollapseSidebar, DEFAULT_SETTINGS.assistantCollapseSidebar)
  assert.equal(d.assistantCollapseSidebar, 'auto')
  assert.equal(d.dmWhoCanMessage, 'everyone')
  assert.equal(d.dmWhoCanRequest, 'everyone')
  assert.equal(d.groupWhoCanAdd, 'everyone')

  const custom = withDefaults({
    assistantCollapseSidebar: 'never',
    dmWhoCanMessage: 'friends',
    dmWhoCanRequest: 'nobody',
    groupWhoCanAdd: 'friends'
  })
  assert.equal(custom.assistantCollapseSidebar, 'never')
  assert.equal(custom.dmWhoCanMessage, 'friends')
  assert.equal(custom.dmWhoCanRequest, 'nobody')
  assert.equal(custom.groupWhoCanAdd, 'friends')
})

test('ChatNotifier respects allowGroup predicate for privacy-filtered DMs', async () => {
  const dmFriend = mkGroup('dm1', 'DM · @alice · @me', [{ username: 'me' }, { username: 'alice' }])
  const dmStranger = mkGroup('dm2', 'DM · @me · @stranger', [{ username: 'me' }, { username: 'stranger' }])
  let t = 1_700_000_010_000
  const msgs = { dm1: [], dm2: [] }
  const notices = []

  const notifier = new ChatNotifier({
    call: async (_method, path) => {
      if (path === '/groups') return { groups: [dmFriend, dmStranger] }
      const m = /^\/groups\/([^/]+)\/items/.exec(path)
      if (m) {
        const list = msgs[m[1]] ?? []
        const since = Number(new URLSearchParams(path.split('?')[1] ?? '').get('since') ?? 0)
        const items = list.filter((it) => it.seq > since)
        const seq = list.reduce((acc, it) => Math.max(acc, it.seq), 0)
        return { items, seq }
      }
      throw new Error(`unexpected path: ${path}`)
    },
    meId: () => 'me',
    enabled: () => true,
    isWindowActive: () => false,
    allowGroup: (g) => isDmGroupAllowed(g, 'me', { dmWhoCanMessage: 'friends' }, friends),
    notify: (n) => notices.push(n),
    now: () => t
  })

  // Baseline poll
  await notifier.check()
  assert.equal(notices.length, 0)

  // Messages arrive from both a friend and a stranger
  t += 5000
  msgs.dm1.push({ id: 'm1', kind: 'message', data: { text: 'hey friend!' }, rev: 1, seq: 1, deleted: false, createdBy: 'alice', updatedBy: 'alice', createdAt: t, updatedAt: t })
  msgs.dm2.push({ id: 'm2', kind: 'message', data: { text: 'hey stranger!' }, rev: 1, seq: 1, deleted: false, createdBy: 'stranger', updatedBy: 'stranger', createdAt: t, updatedAt: t })

  await notifier.check()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].groupId, 'dm1')
  assert.equal(notices[0].isDm, true)
})
