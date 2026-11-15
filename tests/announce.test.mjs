// Tests for the owner's announcements (server/announce.mjs). Run: node --test tests/announce.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8794
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
const titles = async (u) => (await api(await login(u), 'GET', '/announcements')).body.announcements.map((a) => a.title)

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-announce-test-'))
  server = spawn(process.execPath, [process.env.SERVER_FILE || 'server/group-server.mjs'], { env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off', OWNERS: 'boss' }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(BASE + '/health')).ok) break
    } catch {}
    await sleep(100)
  }
  for (const u of ['boss', 'ann', 'bob', 'cat']) await login(u)
})
after(async () => {
  await new Promise((r) => (server.once('exit', r), server.kill()))
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('to everyone, to chosen people, and to people with Veyra AI', async () => {
  const boss = await login('boss')
  await api(boss, 'PUT', '/admin/ai/users/cat', {})
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: 'Hello all', body: 'Welcome', audience: 'all' })).status, 200)
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: 'For Ann', body: 'Just you', audience: 'users', usernames: ['@Ann'] })).status, 200)
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: 'AI news', body: 'New model', audience: 'ai', link: 'https://example.org/ai' })).status, 200)
  assert.deepEqual(await titles('ann'), ['For Ann', 'Hello all'])
  assert.deepEqual(await titles('bob'), ['Hello all'])
  assert.deepEqual(await titles('cat'), ['AI news', 'Hello all'])
  assert.deepEqual(await titles('boss'), ['AI news', 'Hello all']) // the owner has Veyra AI
  const list = (await api(boss, 'GET', '/admin/announcements')).body.announcements
  assert.deepEqual(list.map((a) => [a.title, a.reach]), [['AI news', 2], ['For Ann', 1], ['Hello all', 4]])
})

test('dismissing hides it for that person only, and counts as seen', async () => {
  const ann = await login('ann')
  const a = (await api(ann, 'GET', '/announcements')).body.announcements.find((x) => x.title === 'Hello all')
  await api(ann, 'POST', `/announcements/${a.id}/read`)
  assert.deepEqual(await titles('ann'), ['For Ann'])
  assert.ok((await titles('bob')).includes('Hello all'))
  const seen = (await api(await login('boss'), 'GET', '/admin/announcements')).body.announcements.find((x) => x.title === 'Hello all').seen
  assert.equal(seen, 1)
})

test('expired ones and deleted ones go away; bad input is refused; only the owner can send', async () => {
  const boss = await login('boss')
  const short = await api(boss, 'POST', '/admin/announcements', { title: 'Brief', body: 'Soon gone', audience: 'all', expiresAt: Date.now() + 800 })
  assert.ok((await titles('bob')).includes('Brief'))
  await sleep(1000)
  assert.ok(!(await titles('bob')).includes('Brief'))
  const all = (await api(boss, 'GET', '/admin/announcements')).body.announcements
  await api(boss, 'DELETE', `/admin/announcements/${all.find((a) => a.title === 'AI news').id}`)
  assert.ok(!(await titles('cat')).includes('AI news'))
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: 'x', body: 'y', audience: 'users', usernames: ['nobody'] })).status, 400)
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: '', body: 'y', audience: 'all' })).status, 400)
  assert.equal((await api(boss, 'POST', '/admin/announcements', { title: 'x', body: 'y', audience: 'all', link: 'javascript:alert(1)' })).status, 400)
  const bob = await login('bob')
  assert.equal((await api(bob, 'POST', '/admin/announcements', { title: 'x', body: 'y', audience: 'all' })).status, 403)
  assert.equal((await api(bob, 'GET', '/admin/announcements')).status, 403)
  assert.equal((await api(bob, 'DELETE', `/admin/announcements/${short.body.id}`)).status, 403)
})
