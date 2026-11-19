// Unit tests for canonical DM naming, peer resolution, deduplication, and global message search.
// Run: node --test tests/dm.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dmColorFor,
  dmGroupName,
  dmInvitePeer,
  dmPeer,
  findDmInviteFrom,
  findDmWith,
  isDmGroup,
  parseDmName,
  searchDmMessages
} from '../src/shared/dm.ts'
import { formatChatNotice } from '../src/shared/chat-notify.ts'

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
      displayName: m.displayName ?? '',
      photoUrl: m.photoUrl ?? '',
      verified: !!m.verified,
      role: m.role ?? 'member',
      joinedAt: 1_700_000_000_000
    }))
  }
}

test('dmGroupName is canonical, order-independent, and stays <= 60 chars', () => {
  assert.equal(dmGroupName('Zoe', 'alice'), 'DM · @alice · @zoe')
  assert.equal(dmGroupName('@Alice', '@Zoe'), 'DM · @alice · @zoe')
  assert.deepEqual(parseDmName('DM · @alice · @zoe'), ['alice', 'zoe'])
  assert.equal(isDmGroup('DM · @alice · @zoe'), true)
  assert.equal(isDmGroup('Biology Study Group'), false)

  const longA = 'a'.repeat(35)
  const longB = 'b'.repeat(35)
  const longName = dmGroupName(longA, longB)
  assert.ok(longName.length <= 60, `expected <= 60 chars, got ${longName.length}`)
  assert.equal(isDmGroup(longName), true)
  assert.deepEqual(parseDmName(longName), ['a'.repeat(26), 'b'.repeat(26)])
})

test('dmPeer resolves joined members and pending invitees from friends list', () => {
  const friends = [
    { id: 'f1', username: 'sam', displayName: 'Sam Rivera', photoUrl: 'https://img/sam.png', about: '', isPrivate: false }
  ]

  // Pending DM where Sam hasn't accepted the invite yet (only "me" is in group.members).
  const pendingDm = mkGroup('dm1', dmGroupName('me', 'sam'), [{ username: 'me', displayName: 'Me' }])
  const pendingPeer = dmPeer(pendingDm, 'me', friends)
  assert.equal(pendingPeer.username, 'sam')
  assert.equal(pendingPeer.displayName, 'Sam Rivera')
  assert.equal(pendingPeer.photoUrl, 'https://img/sam.png')
  assert.equal(pendingPeer.joined, false)

  // Joined DM where Sam is in group.members.
  const activeDm = mkGroup('dm1', dmGroupName('me', 'sam'), [
    { username: 'me', displayName: 'Me' },
    { username: 'sam', displayName: 'Sam R.', photoUrl: 'https://img/sam2.png', verified: true }
  ])
  const activePeer = dmPeer(activeDm, 'me', friends)
  assert.equal(activePeer.displayName, 'Sam R.')
  assert.equal(activePeer.verified, true)
  assert.equal(activePeer.joined, true)
})

test('findDmWith deduplicates existing and pending DMs without matching study groups', () => {
  const studyGroup = mkGroup('g1', 'Physics Lab', [
    { username: 'me', displayName: 'Me' },
    { username: 'alex', displayName: 'Alex' }
  ])
  const pendingDm = mkGroup('dm1', dmGroupName('me', 'alex'), [{ username: 'me', displayName: 'Me' }])

  assert.equal(findDmWith([studyGroup], 'me', 'alex'), undefined)
  assert.equal(findDmWith([studyGroup, pendingDm], 'me', 'Alex')?.id, 'dm1')
  assert.equal(findDmWith([studyGroup, pendingDm], 'me', '@alex')?.id, 'dm1')
})

test('findDmInviteFrom and dmInvitePeer resolve incoming DM message requests', () => {
  const groupInv = {
    id: 'inv1',
    group: { id: 'g1', name: 'Calculus Group', color: '#333' },
    invitedBy: { username: 'kai', displayName: 'Kai', photoUrl: '', verified: true },
    createdAt: 100
  }
  const dmInv = {
    id: 'inv2',
    group: { id: 'dm2', name: dmGroupName('me', 'kai'), color: dmColorFor('kai') },
    invitedBy: { username: 'kai', displayName: 'Kai Chen', photoUrl: '', verified: true },
    createdAt: 200
  }

  assert.equal(findDmInviteFrom([groupInv], 'kai'), undefined)
  assert.equal(findDmInviteFrom([groupInv, dmInv], 'KAI')?.id, 'inv2')
  const peer = dmInvitePeer(dmInv, 'me')
  assert.equal(peer.username, 'kai')
  assert.equal(peer.displayName, 'Kai Chen')
})

test('searchDmMessages finds multi-term matches across all DMs sorted newest-first', () => {
  const dmA = mkGroup('dmA', dmGroupName('me', 'alice'), [
    { username: 'me', displayName: 'Me' },
    { username: 'alice', displayName: 'Alice' }
  ])
  const dmB = mkGroup('dmB', dmGroupName('me', 'bob'), [
    { username: 'me', displayName: 'Me' },
    { username: 'bob', displayName: 'Bob' }
  ])
  const msg = (id, createdBy, text, createdAt) => ({
    id,
    kind: 'message',
    data: { text },
    rev: 1,
    createdBy,
    createdAt,
    updatedBy: createdBy,
    updatedAt: createdAt,
    deleted: false,
    seq: 1
  })

  const hits = searchDmMessages(
    [
      {
        group: dmA,
        peer: dmPeer(dmA, 'me'),
        messages: [
          msg('m1', 'alice', 'Did you finish the biology lab report?', 1000),
          msg('m2', 'me', 'Almost done with the lab!', 2000)
        ]
      },
      {
        group: dmB,
        peer: dmPeer(dmB, 'me'),
        messages: [
          msg('m3', 'bob', 'Biology lab slides are in Drive', 3000)
        ]
      }
    ],
    'biology lab'
  )

  assert.equal(hits.length, 2)
  assert.equal(hits[0].messageId, 'm3')
  assert.equal(hits[0].groupId, 'dmB')
  assert.equal(hits[1].messageId, 'm1')
  assert.equal(hits[1].groupId, 'dmA')
})

test('formatChatNotice marks canonical DM rooms with isDm=true and hides raw DM tag in title', () => {
  const dm = mkGroup('dm1', dmGroupName('me', 'nina'), [
    { username: 'me', displayName: 'Me' },
    { username: 'nina', displayName: 'Nina' }
  ])
  const notice = formatChatNotice(dm, [
    {
      id: 'm1',
      kind: 'message',
      data: { text: 'Hey!' },
      rev: 1,
      createdBy: 'nina',
      createdAt: 1000,
      updatedBy: 'nina',
      updatedAt: 1000,
      deleted: false,
      seq: 1
    }
  ])
  assert.equal(notice.isDm, true)
  assert.equal(notice.title, 'Nina')
  assert.equal(notice.body, 'Hey!')
})
