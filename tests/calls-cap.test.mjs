// The month's call-relay allowance (server/calls.mjs). Run: node --test tests/calls-cap.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8798
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
async function start() {
  server = spawn(process.execPath, [process.env.SERVER_FILE || 'server/group-server.mjs'], {
    // A 1,000-byte allowance, so a test can use it up.
    env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off', VOICE_CAP_GB: '0.000001', OWNERS: 'ann', CF_TURN_KEY_ID: '', CF_ANALYTICS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) return
    } catch {}
    await sleep(100)
  }
}
const stop = () => new Promise((r) => (server.once('exit', r), server.kill()))

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-calls-cap-test-'))
  await start()
})
after(async () => {
  await stop()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('past the allowance every call ends, new ones are refused, and it stays closed after a restart', async () => {
  const [ann, bob] = [await login('ann'), await login('bob')]
  const group = (await api(ann, 'POST', '/groups', { name: 'Bio' })).body.group
  await api(bob, 'POST', `/join/${group.inviteCode}`)
  const a = (await api(ann, 'POST', `/groups/${group.id}/voice/join`, { relay: true })).body
  const b = (await api(bob, 'POST', `/groups/${group.id}/voice/join`, { relay: true })).body
  assert.ok(a.sid && b.sid)

  // Reports from someone not in a call don't count; real ones add up.
  await api(ann, 'POST', '/voice/usage', { sid: 'wrong', bytes: 5000 })
  assert.equal((await api(ann, 'GET', '/admin/overview')).body.voice.used, 0)
  await api(ann, 'POST', '/voice/usage', { sid: a.sid, bytes: 600 })
  let o = (await api(ann, 'GET', '/admin/overview')).body.voice
  assert.equal(o.used, 600)
  assert.equal(o.closed, false)

  await api(bob, 'POST', '/voice/usage', { sid: b.sid, bytes: 600 })
  o = (await api(ann, 'GET', '/admin/overview')).body.voice
  assert.equal(o.closed, true)
  const endedA = (await api(ann, 'GET', `/poll/voice?sid=${a.sid}`)).body.messages
  assert.deepEqual(endedA.at(-1), { type: 'ended', reason: 'cap' })
  assert.deepEqual((await api(bob, 'GET', '/voice/rooms')).body.rooms, {})

  const refused = await api(bob, 'POST', `/groups/${group.id}/voice/join`, { relay: true })
  assert.equal(refused.status, 403)
  assert.match(refused.body.error, /paused until/)

  await stop()
  await start()
  sessions.clear()
  assert.equal((await api(await login('bob'), 'POST', `/groups/${group.id}/voice/join`)).status, 403)
})
