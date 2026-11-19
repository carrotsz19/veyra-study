// DM / group chat desktop notification logic. Run: node --test tests/chat-notify.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatNotifier, formatChatNotice } from '../src/shared/chat-notify.ts'

function mkGroup(id, name, members) {
  return {
    id,
    name,
    color: '#6366f1',
    owner: members[0]?.username ?? 'alice',
    role: 'member',
    createdAt: 1_700_000_000_000,
    members: members.map((m) => ({
      username: m.username,
      displayName: m.displayName ?? '',
      photoUrl: '',
      verified: true,
      role: 'member',
      joinedAt: 1_700_000_000_000
    }))
  }
}

function mkMsg(id, seq, createdBy, text, extra = {}) {
  return {
    id,
    kind: 'message',
    data: { text },
    rev: 1,
    createdBy,
    createdAt: extra.createdAt ?? 1_800_000_000_000,
    updatedBy: createdBy,
    updatedAt: extra.updatedAt ?? 1_800_000_000_000,
    deleted: false,
    seq,
    ...extra
  }
}

test('formatChatNotice formats DM (<= 2 members) and multi-member group notices cleanly', () => {
  const dm = mkGroup('g1', 'Alice & Me', [
    { username: 'me', displayName: 'Me' },
    { username: 'alice', displayName: 'Alice Chen' }
  ])
  const singleDm = formatChatNotice(dm, [mkMsg('m1', 2, 'alice', '  Hey   there!\nHow are you? ')])
  assert.equal(singleDm.title, 'Alice Chen')
  assert.equal(singleDm.body, 'Hey there! How are you?')
  assert.equal(singleDm.count, 1)

  const multiDm = formatChatNotice(dm, [
    mkMsg('m1', 2, 'alice', 'First'),
    mkMsg('m2', 3, 'alice', 'Second')
  ])
  assert.equal(multiDm.title, 'Alice Chen')
  assert.equal(multiDm.body, '2 new messages — Second')
  assert.equal(multiDm.count, 2)

  const studyGroup = mkGroup('g2', 'CS 101', [
    { username: 'me', displayName: 'Me' },
    { username: 'alice', displayName: 'Alice' },
    { username: 'bob', displayName: '' }
  ])
  const singleGrp = formatChatNotice(studyGroup, [mkMsg('m3', 4, 'bob', 'Notes uploaded')])
  assert.equal(singleGrp.title, '@bob · CS 101')
  assert.equal(singleGrp.body, 'Notes uploaded')

  const multiGrp = formatChatNotice(studyGroup, [
    mkMsg('m3', 4, 'alice', 'Ready?'),
    mkMsg('m4', 5, 'bob', 'On my way')
  ])
  assert.equal(multiGrp.title, 'CS 101')
  assert.equal(multiGrp.body, '2 new messages — @bob: On my way')
})

test('ChatNotifier silently seeds existing messages on startup and notifies only on new unfocused messages', async () => {
  let now = 1_800_000_000_000
  let active = false
  let enabled = true
  const dm = mkGroup('dm1', 'Study Buddy', [
    { username: 'me', displayName: 'Me' },
    { username: 'sam', displayName: 'Sam' }
  ])
  const serverItems = [mkMsg('old1', 5, 'sam', 'Old message', { createdAt: now - 60_000 })]
  const notices = []

  const notifier = new ChatNotifier({
    call: async (_method, path) => {
      if (path === '/groups') return { groups: [dm] }
      if (path.startsWith('/groups/dm1/items')) {
        const since = Number(new URLSearchParams(path.split('?')[1]).get('since') ?? 0)
        const items = serverItems.filter((it) => it.seq > since)
        const seq = serverItems.reduce((m, it) => Math.max(m, it.seq), 0)
        return { items, seq }
      }
      throw new Error(`unexpected ${path}`)
    },
    meId: () => 'me',
    enabled: () => enabled,
    isWindowActive: () => active,
    notify: (n) => notices.push(n),
    now: () => now
  })

  // Initial online seed must NOT notify for historical messages.
  await notifier.check()
  assert.equal(notices.length, 0)

  // Own message should not notify.
  now += 1000
  serverItems.push(mkMsg('mine1', 6, 'me', 'Hello Sam', { createdAt: now }))
  await notifier.check()
  assert.equal(notices.length, 0)

  // Deleted message or edit (rev > 1) or non-message item should not notify.
  now += 1000
  serverItems.push(
    mkMsg('del1', 7, 'sam', 'Oops', { deleted: true, createdAt: now }),
    mkMsg('edit1', 8, 'sam', 'Edited', { rev: 2, createdAt: now }),
    { id: 'task1', kind: 'task', data: { title: 'Read ch 2' }, rev: 1, createdBy: 'sam', createdAt: now, updatedBy: 'sam', updatedAt: now, deleted: false, seq: 9 }
  )
  await notifier.check()
  assert.equal(notices.length, 0)

  // Incoming message while unfocused -> notifies!
  now += 1000
  serverItems.push(mkMsg('new1', 10, 'sam', 'Did you see slide 4?', { createdAt: now }))
  await notifier.check()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].groupId, 'dm1')
  assert.equal(notices[0].title, 'Sam')
  assert.equal(notices[0].body, 'Did you see slide 4?')

  // Incoming message while window IS focused -> suppressed, and advances seenSeq so it doesn't fire later when blurred.
  active = true
  now += 1000
  serverItems.push(mkMsg('seen1', 11, 'sam', 'Saw you online', { createdAt: now }))
  await notifier.check()
  assert.equal(notices.length, 1)

  active = false
  await notifier.check()
  assert.equal(notices.length, 1)

  // Toggling off then back on silently re-seeds instead of flooding missed backlog.
  enabled = false
  notifier.onSettingsChanged()
  now += 1000
  serverItems.push(mkMsg('missed1', 12, 'sam', 'While muted', { createdAt: now }))
  await notifier.check()
  assert.equal(notices.length, 1)

  enabled = true
  await notifier.check()
  assert.equal(notices.length, 1)

  // Next message after re-enabling notifies normally.
  now += 1000
  serverItems.push(mkMsg('after1', 13, 'sam', 'Back again!', { createdAt: now }))
  await notifier.check()
  assert.equal(notices.length, 2)
  assert.equal(notices[1].body, 'Back again!')
})

test('ChatNotifier ignores old history when joining an existing group, but notifies for brand-new DMs', async () => {
  let now = 1_800_000_000_000
  const groups = []
  const itemsByGroup = new Map()
  const notices = []

  const notifier = new ChatNotifier({
    call: async (_method, path) => {
      if (path === '/groups') return { groups }
      const m = path.match(/^\/groups\/([^/]+)\/items\?since=(\d+)$/)
      assert.ok(m)
      const list = itemsByGroup.get(m[1]) ?? []
      const since = Number(m[2])
      return {
        items: list.filter((it) => it.seq > since),
        seq: list.reduce((acc, it) => Math.max(acc, it.seq), 0)
      }
    },
    meId: () => 'me',
    enabled: () => true,
    isWindowActive: () => false,
    notify: (n) => notices.push(n),
    now: () => now
  })

  // Seed with zero groups.
  await notifier.check()
  assert.equal(notices.length, 0)

  // User joins an older group with historical messages from yesterday -> no flood.
  now += 5000
  const oldGroup = mkGroup('oldG', 'History Class', [
    { username: 'me', displayName: 'Me' },
    { username: 'prof', displayName: 'Prof' },
    { username: 'ta', displayName: 'TA' }
  ])
  groups.push(oldGroup)
  itemsByGroup.set('oldG', [mkMsg('hist1', 1, 'prof', 'Welcome from last week', { createdAt: now - 86_400_000 })])
  await notifier.check()
  assert.equal(notices.length, 0)

  // Someone creates a brand-new DM and sends a message right now -> notifies!
  now += 5000
  const freshDm = mkGroup('newDm', 'Direct', [
    { username: 'me', displayName: 'Me' },
    { username: 'alex', displayName: 'Alex' }
  ])
  groups.push(freshDm)
  itemsByGroup.set('newDm', [mkMsg('fresh1', 1, 'alex', 'Hey, quick question', { createdAt: now - 1000 })])
  await notifier.check()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].groupId, 'newDm')
  assert.equal(notices[0].title, 'Alex')
  assert.equal(notices[0].body, 'Hey, quick question')
})
