// Tests for the group server and the relay. Run: node --test tests/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import relay from '../relay/worker.js'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8795
const BASE = `http://127.0.0.1:${PORT}`
let server
let dataDir

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function pass(username, extra = {}, key = KEY) {
  const nowS = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ aud: 'veyra-group', u: username, n: username.toUpperCase(), p: '', v: true, iat: nowS, exp: nowS + 900, ...extra }))
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}
// One session per person (the server allows 20 sign-ins a minute from one address).
const sessions = new Map()
const login = async (u) => {
  if (!sessions.has(u)) sessions.set(u, (await api(null, 'POST', '/session', { pass: pass(u) })).body.session)
  return sessions.get(u)
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-group-test-'))
  server = spawn(process.execPath, ['server/group-server.mjs'], {
    env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})
after(async () => {
  // Wait for the server to exit (it holds the database open) before deleting its folder.
  await new Promise((r) => {
    server.once('exit', r)
    server.kill()
  })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/* ---------------- sign-in ---------------- */
test('a valid pass gives a session; forged, expired or foreign passes do not', async () => {
  const ok = await api(null, 'POST', '/session', { pass: pass('alice') })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.me.username, 'alice')
  assert.equal((await api(null, 'POST', '/session', { pass: pass('alice', {}, 'wrong-key-wrong-key-wrong-key-wrong') })).status, 401)
  assert.equal((await api(null, 'POST', '/session', { pass: pass('alice', { exp: 1 }) })).status, 401)
  assert.equal((await api(null, 'POST', '/session', { pass: pass('alice', { aud: 'something-else' }) })).status, 401)
  assert.equal((await api(null, 'POST', '/session', { pass: 'garbage' })).status, 401)
  assert.equal((await api('0'.repeat(64), 'GET', '/groups')).status, 401)
  assert.equal((await api(null, 'GET', '/groups')).status, 401)
})

/* ---------------- groups, membership, invites ---------------- */
test('only members can see or change a group', async () => {
  const a = await login('alice')
  const b = await login('bob')
  const g = (await api(a, 'POST', '/groups', { name: 'Bio study' })).body.group
  assert.equal(g.role, 'owner')
  assert.ok(g.inviteCode)

  // Bob isn't in it: every group route looks like "not found".
  assert.equal((await api(b, 'GET', `/groups/${g.id}`)).status, 404)
  assert.equal((await api(b, 'GET', `/groups/${g.id}/items`)).status, 404)
  assert.equal((await api(b, 'POST', `/groups/${g.id}/items`, { kind: 'task', data: { title: 'sneaky' } })).status, 404)
  assert.equal((await api(b, 'POST', `/groups/${g.id}/invites`, { username: 'carol' })).status, 404)
  assert.equal((await api(b, 'PATCH', `/groups/${g.id}`, { name: 'mine now' })).status, 404)
  assert.equal((await api(b, 'GET', '/groups')).body.groups.length, 0)
})

test('invites by @username must be accepted; unknown people are explained', async () => {
  const a = await login('alice')
  const c = await login('carol')
  const g = (await api(a, 'POST', '/groups', { name: 'History' })).body.group
  const unknown = await api(a, 'POST', `/groups/${g.id}/invites`, { username: '@nobody' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /hasn’t|has used/)
  assert.equal((await api(a, 'POST', `/groups/${g.id}/invites`, { username: '@Carol' })).status, 200)
  // Not a member until she accepts.
  assert.equal((await api(c, 'GET', `/groups/${g.id}`)).status, 404)
  const inv = (await api(c, 'GET', '/invites')).body.invites
  assert.equal(inv.length, 1)
  assert.equal(inv[0].invitedBy.username, 'alice')
  const acc = await api(c, 'POST', `/invites/${inv[0].id}/accept`)
  assert.equal(acc.body.group.role, 'member')
  assert.equal((await api(c, 'GET', `/groups/${g.id}`)).status, 200)
  // Members don't see the invite code; owners do.
  assert.equal(acc.body.group.inviteCode, undefined)
})

test('joining by code shows a preview first', async () => {
  const a = await login('alice')
  const d = await login('dave')
  const g = (await api(a, 'POST', '/groups', { name: 'Calc' })).body.group
  const pre = await api(d, 'GET', `/join/${g.inviteCode.toLowerCase()}`)
  assert.equal(pre.status, 200)
  assert.equal(pre.body.preview.name, 'Calc')
  assert.equal(pre.body.preview.owner.username, 'alice')
  assert.equal(pre.body.preview.alreadyIn, false)
  assert.equal((await api(d, 'GET', `/groups/${g.id}`)).status, 404, 'previewing must not join')
  assert.equal((await api(d, 'POST', `/join/${g.inviteCode}`)).status, 200)
  assert.equal((await api(d, 'GET', `/groups/${g.id}`)).status, 200)
  assert.equal((await api(d, 'GET', '/join/ZZZZZZ')).status, 404)
})

test('search finds people who have used group work', async () => {
  const a = await login('alice')
  await login('erin')
  const r = await api(a, 'GET', '/users/search?q=@er')
  assert.deepEqual(r.body.users.map((u) => u.username), ['erin'])
  assert.equal((await api(a, 'GET', '/users/search?q=e')).body.users.length, 0, 'needs 2+ characters')
})

/* ---------------- items ---------------- */
test('tasks, notes with revisions, messages and deadlines', async () => {
  const a = await login('alice')
  const b = await login('bob')
  const g = (await api(a, 'POST', '/groups', { name: 'Lab' })).body.group
  await api(b, 'POST', `/join/${g.inviteCode}`)

  const task = (await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'task', data: { title: 'Write intro', assignee: 'bob', due: '2026-12-01' } })).body.item
  assert.equal(task.data.assignee, 'bob')
  const notMember = (await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'task', data: { title: 'x', assignee: 'mallory' } })).body.item
  assert.equal(notMember.data.assignee, null, 'assignee must be a member')
  const done = await api(b, 'PUT', `/groups/${g.id}/items/${task.id}`, { data: { ...task.data, done: true, doneBy: 'bob', doneAt: 1 } })
  assert.equal(done.body.item.data.done, true)
  assert.equal(done.body.item.updatedBy, 'bob')

  // Notes: a save from an old copy is refused with the current version.
  const note = (await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'note', data: { title: 'Plan', content: { type: 'doc', content: [] } } })).body.item
  const n2 = await api(b, 'PUT', `/groups/${g.id}/items/${note.id}`, { rev: note.rev, data: { ...note.data, title: 'Plan v2' } })
  assert.equal(n2.body.item.rev, 2)
  const stale = await api(a, 'PUT', `/groups/${g.id}/items/${note.id}`, { rev: note.rev, data: { ...note.data, title: 'mine' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.current.data.title, 'Plan v2')
  assert.match(stale.body.error, /@bob/)

  // Unsafe links are removed from shared notes.
  const evil = (await api(a, 'POST', `/groups/${g.id}/items`, {
    kind: 'note',
    data: { title: 'x', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold' }] }, { type: 'text', text: 'ok', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] }] } }
  })).body.item
  const marks = evil.data.content.content[0].content.map((t) => (t.marks ?? []).map((m) => m.type))
  assert.deepEqual(marks, [['bold'], ['link']])

  // Messages: only the sender (or the owner) can delete.
  const msg = (await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'message', data: { text: 'hi team' } })).body.item
  assert.equal((await api(b, 'DELETE', `/groups/${g.id}/items/${msg.id}`)).status, 403)
  const bmsg = (await api(b, 'POST', `/groups/${g.id}/items`, { kind: 'message', data: { text: 'hello' } })).body.item
  assert.equal((await api(a, 'DELETE', `/groups/${g.id}/items/${bmsg.id}`)).status, 200, 'owner may delete')
  assert.equal((await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'message', data: { text: '   ' } })).status, 400)

  // Deadlines need a date.
  assert.equal((await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'event', data: { title: 'Presentation' } })).status, 400)
  const ev = (await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'event', data: { title: 'Presentation', date: '2026-12-05', time: '14:00' } })).body.item
  assert.equal(ev.data.time, '14:00')

  // Change feed: since=N returns only later changes, including deletions.
  const all = await api(b, 'GET', `/groups/${g.id}/items`)
  assert.ok(all.body.items.some((i) => i.id === ev.id))
  assert.ok(!all.body.items.some((i) => i.id === bmsg.id), 'first load skips deleted')
  await api(a, 'DELETE', `/groups/${g.id}/items/${task.id}`)
  const later = await api(b, 'GET', `/groups/${g.id}/items?since=${all.body.seq}`)
  assert.deepEqual(later.body.items.map((i) => [i.id, i.deleted]), [[task.id, true]])
})

test('long-poll wakes up when a group changes', async () => {
  const a = await login('alice')
  const b = await login('bob')
  const g = (await api(a, 'POST', '/groups', { name: 'Poll' })).body.group
  await api(b, 'POST', `/join/${g.inviteCode}`)
  const current = (await api(b, 'GET', '/poll?since=0')).body.seq // answers at once: there are changes after 0
  const t0 = Date.now()
  const poll = api(b, 'GET', `/poll?since=${current}`) // nothing new yet: waits
  await new Promise((r) => setTimeout(r, 300))
  await api(a, 'POST', `/groups/${g.id}/items`, { kind: 'message', data: { text: 'ping' } })
  const res = await poll
  assert.equal(res.status, 200)
  assert.ok(res.body.seq > current)
  const waited = Date.now() - t0
  assert.ok(waited >= 250 && waited < 5000, `waited for the change, then woke promptly (${waited} ms)`)
})

test('an owner leaving hands the group on', async () => {
  const a = await login('alice')
  const b = await login('bob')
  const g = (await api(a, 'POST', '/groups', { name: 'Handover' })).body.group
  await api(b, 'POST', `/join/${g.inviteCode}`)
  await api(a, 'POST', `/groups/${g.id}/leave`)
  const view = (await api(b, 'GET', `/groups/${g.id}`)).body.group
  assert.equal(view.owner, 'bob')
  assert.equal(view.role, 'owner')
  assert.equal((await api(a, 'GET', `/groups/${g.id}`)).status, 404)
})

/* ---------------- personal sync ---------------- */
test('personal sync: your own records only, newest edit wins, paged pulls', async () => {
  const a = await login('alice')
  const b = await login('bob')
  const rec = (id, title, updatedAt, deviceId = 'pc-1', extra = {}) => ({ id, kind: 'task', data: { title }, createdAt: 1, updatedAt, deletedAt: null, deviceId, ...extra })

  let r = await api(a, 'POST', '/sync/push', { records: [rec('t1', 'Essay', 100), rec('t2', 'Lab', 100)] })
  assert.equal(r.status, 200)
  assert.equal(r.body.accepted, 2)

  // Bob never sees Alice's records.
  assert.equal((await api(b, 'GET', '/sync/pull?since=0')).body.records.length, 0)

  // An older edit from another device loses; a newer one wins; a tie goes to the higher device id.
  r = await api(a, 'POST', '/sync/push', { records: [rec('t1', 'old', 50, 'pc-2'), rec('t2', 'Lab report', 200, 'pc-2')] })
  assert.equal(r.body.accepted, 1)
  r = await api(a, 'POST', '/sync/push', { records: [rec('t2', 'tie-low', 200, 'pc-0'), rec('t1', 'tie-high', 100, 'pc-9')] })
  assert.equal(r.body.accepted, 1)
  const all = (await api(a, 'GET', '/sync/pull?since=0')).body.records
  assert.deepEqual(Object.fromEntries(all.map((x) => [x.id, x.data.title])), { t1: 'tie-high', t2: 'Lab report' })

  // Deletes travel as tombstones; bad records and other kinds are skipped.
  r = await api(a, 'POST', '/sync/push', { records: [rec('t2', 'Lab report', 300, 'pc-1', { deletedAt: 300 }), { id: '../x', kind: 'task', data: {} }, rec('s1', 'x', 1, 'pc', { kind: 'settings' })] })
  assert.equal(r.body.accepted, 1)
  assert.equal(r.body.skipped, 2)

  // Pull pages through everything changed since a cursor.
  const first = (await api(a, 'GET', '/sync/pull?since=0&limit=1')).body
  assert.equal(first.records.length, 1)
  assert.equal(first.more, true)
  const rest = (await api(a, 'GET', `/sync/pull?since=${first.seq}&limit=10`)).body
  assert.equal(rest.more, false)
  assert.equal(rest.records.find((x) => x.id === 't2').deletedAt, 300)
  assert.equal((await api(a, 'GET', `/sync/pull?since=${rest.seq}`)).body.records.length, 0)
})

/* ---------------- relay ---------------- */
function relayEnv(home) {
  const kv = new Map()
  return {
    RELAY: { get: async (k, type) => (kv.has(k) ? (type === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) },
    RELAY_SECRET: 'relay-secret-123',
    SIGNING_KEY: KEY,
    VEYRA: {
      fetch: async (req) => {
        const args = await req.json()
        const ok = args[0] === 'ck_' + 'a'.repeat(32) && (req.headers.get('Cookie') || '').includes('vs_')
        return new Response(JSON.stringify({ ok: true, v: ok ? home : { signedIn: false } }))
      }
    }
  }
}
const call = (env, method, path, body, headers = {}) =>
  relay.fetch(new Request('https://relay.test' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }), env)

test('relay: only the phone (with the secret) can publish the address', async () => {
  const env = relayEnv({})
  assert.equal((await call(env, 'GET', '/server')).status, 404)
  assert.equal((await call(env, 'PUT', '/server', { url: 'https://evil.example' })).status, 403)
  assert.equal((await call(env, 'PUT', '/server', { url: 'https://evil.example' }, { Authorization: 'Bearer wrong' })).status, 403)
  assert.equal((await call(env, 'PUT', '/server', { url: 'http://not-https.example' }, { Authorization: 'Bearer relay-secret-123' })).status, 400)
  assert.equal((await call(env, 'PUT', '/server', { url: 'https://abc-def.trycloudflare.com' }, { Authorization: 'Bearer relay-secret-123' })).status, 200)
  assert.equal((await (await call(env, 'GET', '/server')).json()).url, 'https://abc-def.trycloudflare.com')
})

test('relay: a signed-in Veyra user gets a pass the server accepts', async () => {
  const env = relayEnv({ signedIn: true, user: { username: 'Frank', displayName: 'Frank F', emailVerified: true, photoUrl: 'javascript:x' } })
  assert.equal((await call(env, 'POST', '/identify', { handle: 'nope', cookie: 'x' })).status, 400)
  assert.equal((await call(env, 'POST', '/identify', { handle: 'ck_' + 'b'.repeat(32), cookie: '__Host-vs_x=y' })).status, 401)
  const r = await call(env, 'POST', '/identify', { handle: 'ck_' + 'a'.repeat(32), cookie: '__Host-vs_abc=tok' })
  assert.equal(r.status, 200)
  const { pass: p } = await r.json()
  const s = await api(null, 'POST', '/session', { pass: p })
  assert.equal(s.status, 200)
  assert.equal(s.body.me.username, 'frank', 'usernames are lower-cased')
  assert.equal(s.body.me.verified, true)
  assert.equal(s.body.me.photoUrl, '', 'non-https photo dropped')
})

/* ---------------- the owner's view: users, groups, moderation ---------------- */
test('only an owner can use /admin; it lists users and groups and can moderate', async () => {
  const boss = await login('carrotsz19') // the default owner
  const mia = await login('mia')
  const leo = await login('leo')

  // Not for anyone else.
  assert.equal((await api(mia, 'GET', '/admin/overview')).status, 403)
  assert.equal((await api(mia, 'GET', '/admin/users')).status, 403)
  assert.equal((await api(mia, 'POST', '/admin/users/leo/block', {})).status, 403)
  assert.equal((await api(boss, 'GET', '/me')).body.owner, true)
  assert.equal((await api(mia, 'GET', '/me')).body.owner, false)

  // A group with a message and a task, to moderate.
  const g = (await api(mia, 'POST', '/groups', { name: 'Chem lab' })).body.group
  const code = g.inviteCode
  await api(leo, 'POST', `/join/${code}`)
  const msg = (await api(leo, 'POST', `/groups/${g.id}/items`, { kind: 'message', data: { text: 'rude message' } })).body.item
  await api(mia, 'POST', `/groups/${g.id}/items`, { kind: 'task', data: { title: 'Write the method' } })

  const over = (await api(boss, 'GET', '/admin/overview')).body
  assert.ok(over.users >= 3 && over.groups >= 1 && over.items.messages >= 1)

  const users = (await api(boss, 'GET', '/admin/users')).body.users
  const leoRow = users.find((u) => u.username === 'leo')
  assert.equal(leoRow.groups, 1)
  assert.equal(leoRow.blocked, null)
  assert.equal(users.find((u) => u.username === 'carrotsz19').owner, true)

  const groups = (await api(boss, 'GET', '/admin/groups')).body.groups
  const row = groups.find((x) => x.id === g.id)
  assert.equal(row.members, 2)
  assert.equal(row.messages, 1)

  const detail = (await api(boss, 'GET', `/admin/groups/${g.id}`)).body
  assert.equal(detail.members.length, 2)
  assert.equal(detail.items.find((i) => i.id === msg.id).text, 'rude message')

  // Delete the message: gone for the group too.
  assert.equal((await api(boss, 'DELETE', `/admin/groups/${g.id}/items/${msg.id}`)).status, 200)
  const seen = (await api(mia, 'GET', `/groups/${g.id}/items`)).body.items
  assert.equal(seen.some((i) => i.id === msg.id), false)

  // Block leo: his session stops working, and he can't sign in again.
  assert.equal((await api(boss, 'POST', '/admin/users/carrotsz19/block', {})).status, 400) // not an owner
  assert.equal((await api(boss, 'POST', '/admin/users/leo/block', { reason: 'spam' })).status, 200)
  assert.equal((await api(leo, 'GET', '/groups')).status, 401) // signed out everywhere
  const again = await api(null, 'POST', '/session', { pass: pass('leo') })
  assert.equal(again.status, 403)
  assert.equal((await api(boss, 'GET', '/admin/users')).body.users.find((u) => u.username === 'leo').blocked.reason, 'spam')

  // Unblock: he can come back.
  assert.equal((await api(boss, 'DELETE', '/admin/users/leo/block')).status, 200)
  assert.equal((await api(null, 'POST', '/session', { pass: pass('leo') })).status, 200)

  // Remove the group's owner: the next member takes over. Then delete the group.
  assert.equal((await api(boss, 'DELETE', `/admin/groups/${g.id}/members/mia`)).status, 200)
  assert.equal((await api(boss, 'GET', `/admin/groups/${g.id}`)).body.group.owner, 'leo')
  assert.equal((await api(boss, 'DELETE', `/admin/groups/${g.id}`)).status, 200)
  assert.equal((await api(boss, 'GET', `/admin/groups/${g.id}`)).status, 404)
})
