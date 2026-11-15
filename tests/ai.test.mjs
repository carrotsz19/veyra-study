// Tests for Veyra AI on the group server, against a fake Anthropic API (no real requests, no cost).
// Run: node --test tests/ai.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8796
const MOCK = 8797
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- a fake Anthropic API ----------
 * The prompt steers it: USAGE:<in>,<out> sets the usage it reports; THINK:<ms> waits that long
 * after message_start before any text (like thinking); REFUSE ends with stop_reason refusal. */
const seen = []
const mock = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' }))
  }
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw)
  seen.push({ key: req.headers.authorization, body })
  const prompt = body.messages[0].content
  const [inTok, outTok] = (/USAGE:(\d+),(\d+)/.exec(prompt) ?? [0, 1000, 200]).slice(1).map(Number)
  const think = Number(/THINK:(\d+)/.exec(prompt)?.[1] ?? 0)
  const refuse = prompt.includes('REFUSE')
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let closed = false
  req.on('close', () => (closed = true))
  send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTok, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
  await sleep(think)
  if (closed) return
  send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
  send('content_block_stop', { index: 0 })
  send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
  for (const part of refuse ? ['Par'] : ['- One idea\n', '- Another idea\n', '- Done']) {
    send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: part } })
    await sleep(20)
  }
  send('content_block_stop', { index: 1 })
  send('message_delta', { delta: { stop_reason: refuse ? 'refusal' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outTok } })
  send('message_stop', {})
  res.end()
})

/* ---------- the group server ---------- */
let server
let dataDir
const start = () =>
  new Promise((resolve, reject) => {
    // SERVER_FILE=server/dist/group-server.mjs tests the bundled file the phone runs.
    server = spawn(process.execPath, [process.env.SERVER_FILE || 'server/group-server.mjs'], {
      env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off', OWNERS: 'boss', ANTHROPIC_API_KEY: 'sk-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, AI_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    server.stderr.on('data', (d) => process.stderr.write(d))
    ;(async () => {
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(BASE + '/health')).ok) return resolve()
        } catch {}
        await sleep(100)
      }
      reject(new Error('server did not start'))
    })()
  })
const stop = () =>
  new Promise((r) => {
    server.once('exit', r)
    server.kill()
  })

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
/** Sends a request and reads the whole answer back the way the app does. */
async function ask(token, prompt, model) {
  const r = await api(token, 'POST', '/ai/jobs', { system: 'Be brief.', prompt, model })
  if (r.status !== 200) return r
  let text = ''
  for (;;) {
    const p = await api(token, 'GET', `/ai/jobs/${r.body.id}?from=${text.length}`)
    text += p.body.text
    if (p.body.done) return { status: 200, job: r.body, text, error: p.body.error }
  }
}
const advance = async (token, ms) => api(token, 'POST', '/ai/test/clock', { ms })
const spendOf = async (boss, u) => (await api(boss, 'GET', '/admin/ai/users')).body.users.find((x) => x.username === u)
const H = 3600_000

before(async () => {
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r))
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-ai-test-'))
  await start()
})
after(async () => {
  await stop()
  mock.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('scaling: a quiet month raises limits, at most 10% an hour', async () => {
  const boss = await login('boss')
  await login('dana')
  assert.equal((await api(boss, 'PUT', '/admin/ai/users/dana', { fiveHour: 0.4, week: 2.25 })).status, 200)
  const first = await spendOf(boss, 'dana')
  assert.equal(first.windows['5h'].limit, 0.4) // starts at 1x
  await advance(boss, 3 * H)
  const later = await spendOf(boss, 'dana')
  assert.ok(Math.abs(later.windows['5h'].limit - 0.4 * 1.3) < 0.001, `3 h later: ${later.windows['5h'].limit}`)
  await advance(boss, 20 * H)
  assert.ok(Math.abs((await spendOf(boss, 'dana')).windows.week.limit - 4.5) < 0.001) // capped at 2x
  const view = (await api(await login('dana'), 'GET', '/ai')).body
  assert.equal(view.boost, true)
  // Turn scaling off for the rest (so limits are exactly what's set), and let the multiplier settle back.
  await api(boss, 'PUT', '/admin/ai/settings', { scaling: false })
  await advance(boss, 20 * H)
  assert.equal((await spendOf(boss, 'dana')).windows['5h'].limit, 0.4)
})

test('only approved people can use it; only the owner can see or change the settings', async () => {
  const eve = await login('eve')
  const v = (await api(eve, 'GET', '/ai')).body
  assert.equal(v.approved, false)
  assert.match(v.blocked, /invitation/)
  assert.equal((await api(eve, 'POST', '/ai/jobs', { prompt: 'hi' })).status, 403)
  for (const [m, p] of [['GET', '/admin/ai'], ['GET', '/admin/ai/users'], ['PUT', '/admin/ai/settings'], ['PUT', '/admin/ai/models'], ['PUT', '/admin/ai/users/eve'], ['DELETE', '/admin/ai/users/eve']])
    assert.equal((await api(eve, m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 403, `${m} ${p}`)
  const boss = await login('boss')
  const admin = (await api(boss, 'GET', '/admin/ai')).body
  assert.equal(admin.keySet, true)
  assert.deepEqual(admin.available.map((m) => m.id), ['claude-haiku-5-5'])
  assert.equal(seen.length, 0) // listing models isn't a message
})

test('an answer comes back in pieces; the key never leaves the server; the cost is charged', async () => {
  const boss = await login('boss')
  const amy = await login('amy')
  await api(boss, 'PUT', '/admin/ai/users/amy', { fiveHour: 0.01, week: 0.02, month: 0.03 })
  const r = await ask(amy, 'Summarize USAGE:10000,10000')
  assert.equal(r.status, 200)
  assert.equal(r.text, '- One idea\n- Another idea\n- Done')
  assert.equal(r.job.model.id, 'claude-haiku-5-5')
  assert.equal(seen.at(-1).key, 'Bearer sk-test-key') // the SDK sends the key this way
  assert.equal(seen.at(-1).body.system, 'Be brief.')
  const u = await spendOf(boss, 'amy')
  assert.ok(Math.abs(u.windows['5h'].spent - 0.006) < 1e-9, `charged ${u.windows['5h'].spent}`) // 10k in at $0.10/M + 10k out at $0.50/M
  const view = (await api(amy, 'GET', '/ai')).body
  assert.equal(view.limits.find((l) => l.kind === '5h').used, 0.6)
  assert.ok(view.limits.every((l) => l.resetsAt > Date.now()))
  assert.ok(!JSON.stringify(view).includes('0.006')) // people see bars, not dollars
})

test('each window stops someone at its limit and resets after it ends', async () => {
  const boss = await login('boss')
  const amy = await login('amy')
  assert.equal((await ask(amy, 'USAGE:10000,10000')).status, 200) // 5 h: 0.012 of 0.01
  const r = await api(amy, 'POST', '/ai/jobs', { prompt: 'more' })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /5-hour/)
  await advance(boss, 5 * H + 1000)
  assert.equal((await ask(amy, 'USAGE:10000,10000')).status, 200) // week: 0.018 of 0.02
  assert.equal((await ask(amy, 'USAGE:10000,10000')).status, 200) // week: 0.024
  await advance(boss, 5 * H + 1000)
  assert.match((await api(amy, 'POST', '/ai/jobs', { prompt: 'more' })).body.error, /weekly/)
  await advance(boss, 7 * 24 * H)
  assert.equal((await ask(amy, 'USAGE:10000,10000')).status, 200) // month: 0.030 of 0.03
  await advance(boss, 5 * H + 1000)
  assert.match((await api(amy, 'POST', '/ai/jobs', { prompt: 'more' })).body.error, /monthly/)
  await advance(boss, 30 * 24 * H)
  assert.equal((await ask(amy, 'USAGE:100,100')).status, 200)
})

test('near a limit, requests move to the cheapest model', async () => {
  const boss = await login('boss')
  const ben = await login('ben')
  await api(boss, 'PUT', '/admin/ai/models', {
    models: [
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · fast' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · smarter' }
    ]
  })
  await api(boss, 'PUT', '/admin/ai/users/ben', { fiveHour: 0.01, week: null, month: null })
  const a = await ask(ben, 'USAGE:1000,1000', 'claude-sonnet-5-5') // $0.002 + $0.01: over the 5-hour limit
  assert.equal(a.job.model.id, 'claude-sonnet-5-5')
  assert.equal(a.job.downgraded, false)
  await advance(boss, 5 * H + 1000)
  await ask(ben, 'USAGE:1000,15000') // haiku: 0.0001 + 0.0075 = 0.0076 → 76%
  const b = await ask(ben, 'USAGE:10,10', 'claude-sonnet-5-5')
  assert.equal(b.job.model.id, 'claude-haiku-5-5')
  assert.equal(b.job.downgraded, true)
})

test('one request at a time per person', async () => {
  const boss = await login('boss')
  const cal = await login('cal')
  await api(boss, 'PUT', '/admin/ai/users/cal', { fiveHour: null, week: null, month: null })
  const [x, y] = await Promise.all([api(cal, 'POST', '/ai/jobs', { prompt: 'THINK:400 USAGE:10,10' }), api(cal, 'POST', '/ai/jobs', { prompt: 'THINK:400 USAGE:10,10' })])
  assert.deepEqual([x.status, y.status].sort(), [200, 409])
  await sleep(800)
})

test('stopping during thinking is still charged (estimated), not free', async () => {
  const boss = await login('boss')
  const cal = await login('cal')
  const before = (await spendOf(boss, 'cal')).last30
  const r = await api(cal, 'POST', '/ai/jobs', { prompt: 'THINK:4000 USAGE:1000,1000' })
  await sleep(1500)
  await api(cal, 'DELETE', `/ai/jobs/${r.body.id}`)
  for (let i = 0; i < 20 && !(await api(cal, 'GET', `/ai/jobs/${r.body.id}`)).body.done; i++) await sleep(100)
  const charged = (await spendOf(boss, 'cal')).last30 - before
  // ~1.5 s of thinking at ~100 tokens/s at $0.50/M, plus the input
  assert.ok(charged > 0.00005 && charged < 0.001, `charged ${charged}`)
})

test('a refusal is reported and charged', async () => {
  const boss = await login('boss')
  const cal = await login('cal')
  const before = (await spendOf(boss, 'cal')).last30
  const r = await ask(cal, 'REFUSE USAGE:2000,100')
  assert.match(r.error, /declined/)
  assert.ok((await spendOf(boss, 'cal')).last30 - before > 0)
})

test('too much text is refused before anything is sent', async () => {
  const cal = await login('cal')
  const n = seen.length
  const r = await api(cal, 'POST', '/ai/jobs', { prompt: 'x'.repeat(40_000) })
  assert.equal(r.status, 413)
  assert.match(r.body.error, /too long/)
  assert.equal(seen.length, n)
})

test('the monthly total stops everyone but the owner; requests in progress count toward it', async () => {
  const boss = await login('boss')
  const cal = await login('cal')
  // Spent so far this month is small; a total just above it leaves room for one held request.
  const spent = (await api(boss, 'GET', '/admin/ai')).body.month.spent
  await api(boss, 'PUT', '/admin/ai/settings', { cap: spent + 0.009 })
  const slow = await api(cal, 'POST', '/ai/jobs', { prompt: 'THINK:600 USAGE:10,10' }) // holds ~$0.006 while it runs
  assert.equal(slow.status, 200)
  const dee = await login('dee')
  await api(boss, 'PUT', '/admin/ai/users/dee', { fiveHour: null, week: null, month: null })
  const r = await api(dee, 'POST', '/ai/jobs', { prompt: 'USAGE:10,10' })
  assert.equal(r.status, 403)
  assert.match(r.body.error, /month/)
  assert.equal((await ask(boss, 'USAGE:10,10')).status, 200) // the owner isn't limited
  await sleep(900)
  // At 100% everyone else is paused; at 85% they're held to a fair share and the cheapest model.
  await api(boss, 'PUT', '/admin/ai/settings', { cap: 0.0001 })
  assert.match((await api(dee, 'GET', '/ai')).body.blocked, /paused/)
  await api(boss, 'PUT', '/admin/ai/settings', { cap: 100 })
})

test('a request cut off by a restart keeps its held amount', async () => {
  const boss = await login('boss')
  const cal = await login('cal')
  const before = (await spendOf(boss, 'cal')).last30
  await api(cal, 'POST', '/ai/jobs', { prompt: 'THINK:5000 USAGE:10,10' })
  await sleep(300)
  await stop()
  await start()
  const after = (await spendOf(boss, 'cal')).last30
  assert.ok(after - before > 0.005, `kept ${after - before}`) // 12,000 output tokens held at $0.50/M
  assert.equal((await api(cal, 'GET', '/ai')).body.busy, false)
})
