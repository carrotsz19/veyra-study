// Paid plans (server/billing.mjs) against a stand-in for Stripe. Run: node --test tests/billing.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEY = 'test-signing-key-0123456789abcdef0123456789'
const PORT = 8791
const STRIPE_PORT = 8792
const BASE = `http://127.0.0.1:${PORT}`
let server
let stripeMock
let dataDir

/* ---------- a tiny Stripe: customers, checkout sessions, subscriptions, the portal ---------- */
const fake = { customers: 0, subs: new Map(), checkouts: [], auth: [] }
function readForm(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(new URLSearchParams(b)))
  })
}
const setSub = (customer, sub) => fake.subs.set(customer, [sub])

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function pass(username) {
  const nowS = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ aud: 'veyra-group', u: username, n: username.toUpperCase(), p: '', v: true, iat: nowS, exp: nowS + 900 }))
  return `${body}.${b64url(createHmac('sha256', KEY).update(body).digest())}`
}
async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}
const sessions = new Map()
const login = async (u) => {
  if (!sessions.has(u)) sessions.set(u, (await api(null, 'POST', '/session', { pass: pass(u) })).body.session)
  return sessions.get(u)
}

before(async () => {
  stripeMock = createServer(async (req, res) => {
    fake.auth.push(req.headers.authorization)
    const url = new URL(req.url, 'http://x')
    const send = (j) => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(j)))
    if (req.method === 'POST' && url.pathname === '/v1/customers') {
      await readForm(req)
      return send({ id: `cus_${++fake.customers}` })
    }
    if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      const f = await readForm(req)
      fake.checkouts.push(Object.fromEntries(f))
      return send({ id: 'cs_1', url: 'https://checkout.stripe.test/pay/cs_1' })
    }
    if (req.method === 'GET' && url.pathname === '/v1/subscriptions') return send({ data: fake.subs.get(url.searchParams.get('customer')) ?? [] })
    if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
      await readForm(req)
      return send({ url: 'https://billing.stripe.test/p/1' })
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no such route' } }))
  })
  await new Promise((r) => stripeMock.listen(STRIPE_PORT, '127.0.0.1', r))

  dataDir = mkdtempSync(join(tmpdir(), 'veyra-billing-test-'))
  server = spawn(process.execPath, ['server/group-server.mjs'], {
    env: { ...process.env, SIGNING_KEY: KEY, PORT: String(PORT), DATA_DIR: dataDir, TUNNEL: 'off', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_API: `http://127.0.0.1:${STRIPE_PORT}` },
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
  await new Promise((r) => {
    server.once('exit', r)
    server.kill()
  })
  stripeMock.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const PLUS = { id: 'plus', name: 'Plus', price: '$4 a month', blurb: 'More Veyra AI', priceId: 'price_plus1', ai: { fiveHour: 1, week: 5, month: 15 } }

test('plans stay locked to the owner until opened', async () => {
  const boss = await login('carrotsz19')
  const ana = await login('ana')
  await api(boss, 'PUT', '/admin/billing', { plans: [PLUS] })
  const mine = (await api(boss, 'GET', '/billing')).body
  assert.equal(mine.open, true)
  assert.equal(mine.mode, 'test')
  assert.equal(mine.plans[0].name, 'Plus')
  // Not even the price id goes to the apps.
  assert.equal(mine.plans[0].priceId, undefined)

  const hers = (await api(ana, 'GET', '/billing')).body
  assert.equal(hers.open, false)
  assert.deepEqual(hers.plans, [])
  assert.equal(hers.mode, undefined)
  assert.equal((await api(ana, 'POST', '/billing/checkout', { planId: 'plus' })).status, 403)
  // Only the owner changes settings.
  assert.equal((await api(ana, 'GET', '/admin/billing')).status, 403)
  assert.equal((await api(ana, 'PUT', '/admin/billing', { open: true })).status, 403)
})

test('bad plan settings are refused', async () => {
  const boss = await login('carrotsz19')
  assert.equal((await api(boss, 'PUT', '/admin/billing', { plans: [{ id: 'x', priceId: 'nope' }] })).status, 400)
  assert.equal((await api(boss, 'PUT', '/admin/billing', { plans: [PLUS, PLUS] })).status, 400)
  assert.equal((await api(boss, 'PUT', '/admin/billing', { returnUrl: 'http://insecure.test' })).status, 400)
  assert.equal((await api(boss, 'PUT', '/admin/billing', { open: true, plans: [] })).status, 400)
})

test('checkout, then the plan and its Veyra AI limits; cancelling brings the old limits back', async () => {
  const boss = await login('carrotsz19')
  const leo = await login('leo')
  await api(boss, 'PUT', '/admin/billing', { open: true, plans: [PLUS], returnUrl: 'https://example.test/' })
  // Leo had his own Veyra AI limits before.
  await api(boss, 'PUT', '/admin/ai/users/leo', { fiveHour: 0.2, week: 1, month: null })

  const co = await api(leo, 'POST', '/billing/checkout', { planId: 'plus' })
  assert.equal(co.status, 200)
  assert.equal(co.body.url, 'https://checkout.stripe.test/pay/cs_1')
  const sent = fake.checkouts.at(-1)
  assert.equal(sent.mode, 'subscription')
  assert.equal(sent['line_items[0][price]'], 'price_plus1')
  assert.equal(sent.client_reference_id, 'leo')
  assert.equal(sent.success_url, 'https://example.test/?billing=done')
  assert.ok(fake.auth.every((a) => a === 'Bearer sk_test_fake'))

  // Stripe now has his subscription (newer API: the period is on the item).
  setSub(sent.customer, { id: 'sub_1', status: 'active', created: 1, cancel_at_period_end: false, items: { data: [{ price: { id: 'price_plus1' }, current_period_end: 2_000_000_000 }] } })
  const r = (await api(leo, 'POST', '/billing/refresh')).body.current
  assert.equal(r.planId, 'plus')
  assert.equal(r.active, true)
  assert.equal(r.periodEnd, 2_000_000_000_000)
  let users = (await api(boss, 'GET', '/admin/ai/users')).body.users
  let me = users.find((u) => u.username === 'leo')
  assert.equal(me.base.week, 5)

  // Already on a plan: no second checkout.
  assert.equal((await api(leo, 'POST', '/billing/checkout', { planId: 'plus' })).status, 409)
  assert.equal((await api(leo, 'POST', '/billing/portal')).body.url, 'https://billing.stripe.test/p/1')

  // He cancels; the owner's sync notices.
  setSub(sent.customer, { id: 'sub_1', status: 'canceled', created: 1, items: { data: [{ price: { id: 'price_plus1' } }] } })
  assert.equal((await api(boss, 'POST', '/admin/billing/sync')).body.synced >= 1, true)
  assert.equal((await api(leo, 'GET', '/billing')).body.current.active, false)
  users = (await api(boss, 'GET', '/admin/ai/users')).body.users
  me = users.find((u) => u.username === 'leo')
  assert.equal(me.base.week, 1)

  const admin = (await api(boss, 'GET', '/admin/billing')).body
  assert.equal(admin.mode, 'test')
  assert.equal(admin.subscribers.find((x) => x.username === 'leo').status, 'canceled')
})

test('the page Stripe sends people back to is a small, locked-down web page', async () => {
  const res = await fetch(`${BASE}/billing/return?billing=done`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(await res.text(), /Payment done/)
  assert.match(await (await fetch(`${BASE}/billing/return?billing=cancelled`)).text(), /Nothing was charged/)
  // Whatever is in the address, nothing of it lands in the page.
  assert.doesNotMatch(await (await fetch(`${BASE}/billing/return?billing=<script>x</script>`)).text(), /<script>/)
})

test('plans can be shown as unavailable or hidden, and checkout refuses both', async () => {
  const boss = await login('carrotsz19')
  const mia = await login('mia')
  const proOff = { id: 'pro', name: 'Pro', price: 'S$13.90', blurb: 'More', priceId: 'price_pro1', ai: { fiveHour: 0.75, week: 2.25, month: 6 }, available: false, visible: true }
  const secret = { id: 'secret', name: 'Secret', price: 'S$99', blurb: 'Hidden', priceId: 'price_sec1', ai: null, available: true, visible: false }
  const saved = await api(boss, 'PUT', '/admin/billing', { open: true, plans: [PLUS, proOff, secret] })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.plans[0].available, true)
  assert.equal(saved.body.settings.plans[0].visible, true)

  const seen = (await api(mia, 'GET', '/billing')).body.plans
  assert.deepEqual(seen.map((p) => [p.id, p.available]), [['plus', true], ['pro', false]])

  assert.equal((await api(mia, 'POST', '/billing/checkout', { planId: 'pro' })).status, 409)
  assert.equal((await api(mia, 'POST', '/billing/checkout', { planId: 'secret' })).status, 409)
})
