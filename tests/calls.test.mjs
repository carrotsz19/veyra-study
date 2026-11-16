// Tests for voice rooms (server/calls.mjs). Run: node --test tests/calls.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8795
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let server
let dataDir
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function pass(username) {
  const nowS = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ aud: 'veyra-group', u: username, n: username, p: '', v: true, iat: nowS, exp: nowS + 900 }))
  return `${body}.${b64url(createHmac('sha256', KEY).update(body).digest())}`
}
async function api(token, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const sessions = new Map()
const login = async (u) => {
  if (!sessions.has(u)) sessions.set(u, (await api(null, 'POST', '/session', { pass: pass(u) })).body.session)
  return sessions.get(u)
}
let group
let other

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-calls-test-'))
  server = spawn(process.execPath, [process.env.SERVER_FILE || 'server/group-server.mjs'], { env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) break
    } catch {}
    await sleep(100)
  }
  const ann = await login('ann')
  group = (await api(ann, 'POST', '/groups', { name: 'Bio' })).body.group
  other = (await api(ann, 'POST', '/groups', { name: 'Chem' })).body.group
  for (const u of ['bob', 'cat']) await api(await login(u), 'POST', `/join/${group.inviteCode}`)
  await login('eve')
})
after(async () => {
  await new Promise((r) => (server.once('exit', r), server.kill()))
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('join, see who is in, pass offers between two people, mute, leave', async () => {
  const [ann, bob] = [await login('ann'), await login('bob')]
  const v0 = (await api(ann, 'GET', '/poll?since=0')).body.voice
  assert.equal(typeof v0, 'number')

  const a = (await api(ann, 'POST', `/groups/${group.id}/voice/join`)).body
  assert.ok(a.sid && a.iceServers.length)
  assert.deepEqual(a.people.map((p) => p.username), ['ann'])

  // Bob's change feed wakes (without moving seq) when Ann joins: he sees her in the room.
  const seq = (await api(bob, 'GET', '/poll?since=0')).body.seq
  const quick = await api(bob, 'GET', `/poll?since=${seq}&voice=${v0}`)
  assert.notEqual(quick.body.voice, v0)
  assert.equal(quick.body.seq, seq)
  assert.deepEqual((await api(bob, 'GET', '/voice/rooms')).body.rooms[group.id].map((p) => p.username), ['ann'])

  const b = (await api(bob, 'POST', `/groups/${group.id}/voice/join`)).body
  assert.deepEqual(b.people.map((p) => p.username).sort(), ['ann', 'bob'])

  // Ann hears that Bob joined, then gets his offer.
  const m1 = (await api(ann, 'GET', `/poll/voice?sid=${a.sid}`)).body.messages
  assert.ok(m1.some((m) => m.type === 'room' && m.people.length === 2))
  const waiting = api(ann, 'GET', `/poll/voice?sid=${a.sid}`)
  await sleep(100)
  assert.equal((await api(bob, 'POST', '/voice/signal', { to: 'ann', toSid: a.sid, sid: b.sid, data: { kind: 'offer', sdp: 'x' } })).status, 200)
  const m2 = (await waiting).body.messages
  assert.deepEqual(m2, [{ type: 'signal', from: 'bob', fromSid: b.sid, data: { kind: 'offer', sdp: 'x' } }])

  // A stale sid can't send.
  assert.equal((await api(bob, 'POST', '/voice/signal', { to: 'ann', toSid: 'old', sid: b.sid, data: { kind: 'offer' } })).status, 410)

  assert.equal((await api(bob, 'PATCH', `/groups/${group.id}/voice/state`, { muted: true })).status, 200)
  const m3 = (await api(ann, 'GET', `/poll/voice?sid=${a.sid}`)).body.messages
  assert.equal(m3.at(-1).people.find((p) => p.username === 'bob').muted, true)

  await api(bob, 'POST', `/groups/${group.id}/voice/leave`, { sid: b.sid })
  const m4 = (await api(ann, 'GET', `/poll/voice?sid=${a.sid}`)).body.messages
  assert.deepEqual(m4.at(-1).people.map((p) => p.username), ['ann'])
  assert.deepEqual((await api(bob, 'GET', `/poll/voice?sid=${b.sid}`)).body.messages, [{ type: 'ended' }])
  await api(ann, 'POST', `/groups/${group.id}/voice/leave`, { sid: a.sid })
  assert.deepEqual((await api(ann, 'GET', '/voice/rooms')).body.rooms, {})
})

test('outsiders can’t join or see the room; joining another group’s room leaves the first', async () => {
  const [ann, cat, eve] = [await login('ann'), await login('cat'), await login('eve')]
  assert.equal((await api(eve, 'POST', `/groups/${group.id}/voice/join`)).status, 404)
  const c = (await api(cat, 'POST', `/groups/${group.id}/voice/join`)).body
  assert.deepEqual((await api(eve, 'GET', '/voice/rooms')).body.rooms, {})
  assert.equal((await api(eve, 'POST', '/voice/signal', { to: 'cat', toSid: c.sid, sid: 'x', data: { kind: 'offer' } })).status, 409)

  await api(ann, 'POST', `/groups/${group.id}/voice/join`)
  const moved = (await api(ann, 'POST', `/groups/${other.id}/voice/join`)).body
  const rooms = (await api(ann, 'GET', '/voice/rooms')).body
  assert.deepEqual(rooms.rooms[group.id].map((p) => p.username), ['cat'])
  assert.deepEqual(rooms.rooms[other.id].map((p) => p.username), ['ann'])
  assert.equal(rooms.mine, other.id)
  await api(ann, 'POST', `/groups/${other.id}/voice/leave`, { sid: moved.sid })
  await api(cat, 'POST', `/groups/${group.id}/voice/leave`, { sid: c.sid })
})

test('joining again from another device replaces the first; an old leave doesn’t end the new one', async () => {
  const bob = await login('bob')
  const first = (await api(bob, 'POST', `/groups/${group.id}/voice/join`)).body
  const second = (await api(bob, 'POST', `/groups/${group.id}/voice/join`)).body
  assert.notEqual(first.sid, second.sid)
  assert.deepEqual((await api(bob, 'GET', `/poll/voice?sid=${first.sid}`)).body.messages, [{ type: 'ended' }])
  await api(bob, 'POST', `/groups/${group.id}/voice/leave`, { sid: first.sid })
  assert.deepEqual((await api(bob, 'GET', '/voice/rooms')).body.rooms[group.id].map((p) => p.username), ['bob'])
  await api(bob, 'POST', `/groups/${group.id}/voice/leave`, { sid: second.sid })
})

test('someone removed from the group is taken out of its voice room', async () => {
  const [ann, cat] = [await login('ann'), await login('cat')]
  const c = (await api(cat, 'POST', `/groups/${group.id}/voice/join`)).body
  await api(ann, 'DELETE', `/groups/${group.id}/members/cat`)
  assert.deepEqual((await api(cat, 'GET', `/poll/voice?sid=${c.sid}`)).body.messages, [{ type: 'ended', reason: 'removed' }])
  assert.deepEqual((await api(ann, 'GET', '/voice/rooms')).body.rooms, {})
})
