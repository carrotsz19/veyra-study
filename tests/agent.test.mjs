// Tests for the Veyra AI agent (server/agent.mjs) against a fake Anthropic API: no real requests.
// Run: node --test tests/agent.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8798
const MOCK = 8799
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- a fake Anthropic API that plays the agent's turns ----------
 * The scenario is the word in the student's first message; the turn is how many assistant
 * turns the request already holds. Subagent requests are told apart by their system prompt. */
const seen = []
let id = 0
const mock = createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw)
  seen.push(body)
  const sub = body.system.startsWith('You are a research assistant')
  // A model that refuses the web tools (like an API 400 for an unsupported tool).
  if (JSON.stringify(body.messages).includes('NOWEB') && body.tools?.some((t) => t.name === 'web_search')) {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'tool web_search_20250305 is not supported' } }))
  }
  // The student's latest message (the last plain-text one; tool results come after it).
  const text0 = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string')?.content ?? ''
  const scenario = sub ? 'SUB' : (/\b(PLAN|WRITE|SUBS|PAUSE|LOOP|NOAPP|SLOW|HISTORY)\b/.exec(text0) ?? [, 'PLAIN'])[1]
  const turn = body.messages.filter((m) => m.role === 'assistant').length
  const lastUser = body.messages.at(-1)
  const results = Array.isArray(lastUser.content) ? lastUser.content.filter((b) => b.type === 'tool_result') : []

  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let i = 0
  const send = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`)
  const text = (t, citations) => {
    send('content_block_start', { index: i, content_block: { type: 'text', text: '', ...(citations ? { citations: [] } : {}) } })
    for (const c of citations ?? []) send('content_block_delta', { index: i, delta: { type: 'citations_delta', citation: c } })
    send('content_block_delta', { index: i, delta: { type: 'text_delta', text: t } })
    send('content_block_stop', { index: i++ })
  }
  const tool = (name, input) => {
    send('content_block_start', { index: i, content_block: { type: 'tool_use', id: `toolu_${++id}`, name, input: {} } })
    send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    send('content_block_stop', { index: i++ })
  }
  const search = (query) => {
    const sid = `srvtoolu_${++id}`
    send('content_block_start', { index: i, content_block: { type: 'server_tool_use', id: sid, name: 'web_search', input: {} } })
    send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } })
    send('content_block_stop', { index: i++ })
    send('content_block_start', { index: i, content_block: { type: 'web_search_tool_result', tool_use_id: sid, content: [{ type: 'web_search_result', url: 'https://example.org/photo', title: 'Photosynthesis basics', encrypted_content: 'x', page_age: null }] } })
    send('content_block_stop', { index: i++ })
  }
  let stop = 'end_turn'
  let usage = { input_tokens: 2000, output_tokens: 300 }
  send('message_start', { message: { id: `msg_${++id}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })
  send('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } })
  send('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: 'sig' } })
  send('content_block_stop', { index: i++ })

  if (scenario === 'SUB') {
    search('sub research')
    text('Finding: chlorophyll absorbs light. Source: https://example.org/photo')
    usage.server_tool_use = { web_search_requests: 1 }
  } else if (scenario === 'PLAN') {
    if (turn === 0) {
      tool('update_plan', { items: [{ text: 'Read the note', status: 'in_progress' }, { text: 'Check the web', status: 'pending' }] })
      tool('search_notes', { query: 'photosynthesis' })
      stop = 'tool_use'
    } else {
      search('photosynthesis light reactions')
      text(`Here is the answer. Notes said: ${results.map((r) => r.content).join(' | ')}`, [{ type: 'web_search_result_location', url: 'https://example.org/photo', title: 'Photosynthesis basics', cited_text: 'light', encrypted_index: 'e' }])
      usage.server_tool_use = { web_search_requests: 1 }
    }
  } else if (scenario === 'WRITE') {
    if (turn === 0) {
      tool('create_note', { title: 'Summary', markdown: '# Summary\n- one' })
      stop = 'tool_use'
    } else text(results[0]?.is_error ? `DENIED: ${results[0].content}` : `MADE: ${results[0]?.content}`)
  } else if (scenario === 'SUBS') {
    if (turn === 0) {
      tool('run_subagents', { tasks: [{ title: 'Light reactions', instructions: 'Research the light reactions' }, { title: 'Calvin cycle', instructions: 'Research the Calvin cycle' }] })
      stop = 'tool_use'
    } else text(`Combined: ${results[0].content}`)
  } else if (scenario === 'PAUSE') {
    if (turn === 0) {
      search('long research')
      stop = 'pause_turn'
    } else text('Resumed and finished.')
  } else if (scenario === 'LOOP') {
    tool('update_plan', { items: [{ text: `step ${turn}`, status: 'in_progress' }] })
    stop = 'tool_use'
    usage = { input_tokens: 20000, output_tokens: 8000 } // haiku: $0.002 + $0.004 a turn
  } else if (scenario === 'NOAPP') {
    if (turn === 0) {
      tool('read_note', { id: 'current' })
      stop = 'tool_use'
    } else text(`After: ${results[0]?.content}`)
  } else if (scenario === 'SLOW') {
    await sleep(3000)
    text('slow answer')
  } else if (scenario === 'HISTORY') {
    text(`Saw ${body.messages.length} messages; roles ${body.messages.map((m) => m.role[0]).join('')}`)
  } else text('Plain answer.')
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens, ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}) } })
  send('message_stop', {})
  res.end()
})

/* ---------- the group server ---------- */
let server
let dataDir
const start = () =>
  new Promise((resolve, reject) => {
    server = spawn(process.execPath, [process.env.SERVER_FILE || 'server/group-server.mjs'], {
      env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off', OWNERS: 'boss', ANTHROPIC_API_KEY: 'sk-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}`, AGENT_CALL_WAIT_MS: '1500' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    server.stderr.on('data', (d) => process.stderr.write(d))
    ;(async () => {
      for (let n = 0; n < 80; n++) {
        try {
          if ((await fetch(BASE + '/health')).ok) return resolve()
        } catch {}
        await sleep(100)
      }
      reject(new Error('server did not start'))
    })()
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
const spendOf = async (boss, u) => (await api(boss, 'GET', '/admin/ai/users')).body.users.find((x) => x.username === u)

/** Runs a task like the app does: reads events, answers app tool calls with `answer(ev)`. */
async function agent(token, message, { answer, note, history } = {}) {
  const r = await api(token, 'POST', '/ai/agent/runs', { message, note, history })
  if (r.status !== 200) return { status: r.status, error: r.body.error }
  const events = []
  let from = 0
  for (;;) {
    const p = await api(token, 'GET', `/ai/agent/runs/${r.body.id}?from=${from}`)
    from = p.body.next
    for (const ev of p.body.events) {
      events.push(ev)
      if (ev.t === 'call' && answer) {
        const a = await answer(ev)
        if (a !== undefined) await api(token, 'POST', `/ai/agent/runs/${r.body.id}/calls/${ev.id}`, a)
      }
    }
    if (p.body.done) break
  }
  const text = (a = 'lead') => events.filter((e) => e.t === 'text' && e.a === a).map((e) => e.s).join('')
  return { status: 200, id: r.body.id, events, text, end: events.at(-1) }
}

before(async () => {
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r))
  dataDir = mkdtempSync(join(tmpdir(), 'veyra-agent-test-'))
  await start()
  const boss = await login('boss')
  for (const u of ['ann', 'bob', 'cat', 'dan']) {
    await login(u)
    await api(boss, 'PUT', `/admin/ai/users/${u}`, { fiveHour: null, week: null, month: null })
  }
  await api(boss, 'PUT', '/admin/ai/settings', { scaling: false })
})
after(async () => {
  await new Promise((r) => {
    server.once('exit', r)
    server.kill()
  })
  mock.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('a plan, a note search done by the app, a web search with its source, and the cost charged', async () => {
  const boss = await login('boss')
  const ann = await login('ann')
  const before = (await spendOf(boss, 'ann')).last30
  const r = await agent(ann, 'PLAN explain photosynthesis', {
    note: { title: 'Bio', markdown: 'Plants make food.' },
    answer: (ev) => {
      assert.equal(ev.name, 'search_notes')
      assert.equal(ev.write, false)
      return { result: 'Bio note: plants make food' }
    }
  })
  assert.equal(r.status, 200)
  const plan = r.events.find((e) => e.t === 'plan')
  assert.deepEqual(plan.items.map((x) => x.status), ['in_progress', 'pending'])
  assert.match(r.text(), /Notes said: Plan shown to the student\. \| Bio note: plants make food/)
  assert.ok(r.events.some((e) => e.t === 'tool' && e.label === 'Searching the web'))
  assert.deepEqual(r.events.find((e) => e.t === 'sources').items, [{ url: 'https://example.org/photo', title: 'Photosynthesis basics' }])
  assert.equal(r.end.t, 'end')
  assert.equal(r.end.error, undefined)
  // The open note went in with the first message; the lead got the web tools (Haiku: the basic search).
  const first = seen.find((b) => typeof b.messages[0].content === 'string' && b.messages[0].content.includes('PLAN explain'))
  assert.match(first.messages[0].content, /<note>\nPlants make food\.\n<\/note>/)
  assert.ok(first.tools.some((t) => t.type === 'web_search_20250305'))
  assert.ok(first.tools.every((t) => t.name !== 'delete_note'))
  // 2 calls x (2000 in at $0.10/M + 300 out at $0.50/M) + 1 web search at $0.01
  const charged = (await spendOf(boss, 'ann')).last30 - before
  assert.ok(Math.abs(charged - (2 * 0.00035 + 0.01)) < 1e-9, `charged ${charged}`)
})

test('changes go through the app: a declined one comes back to the model as declined', async () => {
  const bob = await login('bob')
  const no = await agent(bob, 'WRITE a summary note', { answer: (ev) => (assert.equal(ev.write, true), { denied: true }) })
  assert.match(no.text(), /^DENIED: The student declined/)
  const yes = await agent(bob, 'WRITE a summary note', { answer: () => ({ result: 'Made note n1' }) })
  assert.equal(yes.text(), 'MADE: Made note n1')
})

test('subagents run in parallel, report back, and are charged (with their searches)', async () => {
  const boss = await login('boss')
  const cat = await login('cat')
  const before = (await spendOf(boss, 'cat')).last30
  const r = await agent(cat, 'SUBS research photosynthesis')
  const subs = r.events.filter((e) => e.t === 'sub')
  assert.deepEqual(subs.filter((e) => e.state === 'running').map((e) => e.title).sort(), ['Calvin cycle', 'Light reactions'])
  assert.equal(subs.filter((e) => e.state === 'done').length, 2)
  assert.match(r.text(), /## Light reactions\nFinding: chlorophyll/)
  assert.match(r.text(), /## Calvin cycle\nFinding: chlorophyll/)
  assert.ok(r.text('s1').includes('Finding'))
  // Subagents only get read tools, never the write ones or more subagents.
  const subReq = seen.find((b) => b.system.startsWith('You are a research assistant'))
  assert.deepEqual(subReq.tools.map((t) => t.name).sort(), ['read_note', 'search_notes', 'web_search'])
  // lead 2 calls + 2 subagent calls, each $0.00035, + 2 searches
  const charged = (await spendOf(boss, 'cat')).last30 - before
  assert.ok(Math.abs(charged - (4 * 0.00035 + 0.02)) < 1e-9, `charged ${charged}`)
})

test('a paused server-tool turn is resumed', async () => {
  const r = await agent(await login('dan'), 'PAUSE dig deep')
  assert.equal(r.text(), 'Resumed and finished.')
  const req = seen.filter((b) => typeof b.messages[0].content === 'string' && b.messages[0].content.includes('PAUSE'))
  assert.equal(req.length, 2)
  assert.equal(req[1].messages.at(-1).role, 'assistant') // re-sent as is, no extra message
})

test('if the app never answers, the call times out and the task still ends', async () => {
  const r = await agent(await login('dan'), 'NOAPP read my note', { answer: () => undefined })
  assert.match(r.text(), /After: The app didn’t answer/)
  assert.equal(r.end.t, 'end')
})

test('a task stops at its own spending cap, with what it did so far', async () => {
  const boss = await login('boss')
  await api(boss, 'PUT', '/admin/ai/settings', { agentRun: 0.01 })
  const r = await agent(await login('ann'), 'LOOP forever')
  assert.match(r.end.error, /most one task can use/)
  assert.ok(r.events.filter((e) => e.t === 'plan').length >= 1)
  await api(boss, 'PUT', '/admin/ai/settings', { agentRun: 0.25 })
})

test('a person’s limit stops a task partway', async () => {
  const boss = await login('boss')
  await api(boss, 'PUT', '/admin/ai/users/bob', { fiveHour: 0.012, week: null, month: null })
  const r = await agent(await login('bob'), 'LOOP forever')
  assert.match(r.end.error, /5-hour/)
  await api(boss, 'PUT', '/admin/ai/users/bob', { fiveHour: null, week: null, month: null })
})

test('one thing at a time: a task blocks a plain request and another task, until it ends', async () => {
  const cat = await login('cat')
  const run = await api(cat, 'POST', '/ai/agent/runs', { message: 'SLOW think' })
  assert.equal(run.status, 200)
  assert.equal((await api(cat, 'POST', '/ai/jobs', { prompt: 'hi' })).status, 409)
  assert.equal((await api(cat, 'POST', '/ai/agent/runs', { message: 'hi' })).status, 409)
  assert.equal((await api(cat, 'GET', '/ai')).body.busy, true)
  await api(cat, 'DELETE', `/ai/agent/runs/${run.body.id}`)
  assert.equal((await api(cat, 'GET', '/ai')).body.busy, false)
  const ev = (await api(cat, 'GET', `/ai/agent/runs/${run.body.id}?from=0`)).body
  assert.equal(ev.done, true)
  assert.equal(ev.events.at(-1).error, 'Stopped.')
})

test('earlier turns go in as plain text, alternating and starting with the student', async () => {
  const r = await agent(await login('dan'), 'HISTORY again', {
    history: [
      { role: 'assistant', text: 'stray' },
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'never answered' }
    ]
  })
  assert.equal(r.text(), 'Saw 3 messages; roles uau')
})

test('only the person who started a task can see, answer or stop it; unapproved people can’t start one', async () => {
  const ann = await login('ann')
  const eve = await login('eve')
  assert.equal((await api(eve, 'POST', '/ai/agent/runs', { message: 'hi' })).status, 403)
  const run = await api(ann, 'POST', '/ai/agent/runs', { message: 'SLOW' })
  assert.equal((await api(eve, 'GET', `/ai/agent/runs/${run.body.id}`)).status, 404)
  assert.equal((await api(eve, 'POST', `/ai/agent/runs/${run.body.id}/calls/x`, { result: 'x' })).status, 404)
  await api(eve, 'DELETE', `/ai/agent/runs/${run.body.id}`)
  assert.equal((await api(ann, 'GET', `/ai/agent/runs/${run.body.id}?from=0`)).body.done, false)
  await api(ann, 'DELETE', `/ai/agent/runs/${run.body.id}`)
})

test('a model that refuses the web tools still runs, without them', async () => {
  const r = await agent(await login('dan'), 'NOWEB please answer')
  assert.equal(r.text(), 'Plain answer.')
  assert.equal(r.end.error, undefined)
  const last = seen.at(-1)
  assert.ok(last.tools.every((t) => t.name !== 'web_search'))
  assert.match(last.system, /can’t use the web/)
})
