/**
 * Paid plans (Stripe). Locked like the Veyra AI tab: only the owner sees plans until the owner
 * opens them to everyone (Settings → Owner → Plans).
 *
 * - The Stripe key lives only in this server's .env (STRIPE_SECRET_KEY, ideally a restricted key):
 *   never in the repo or the apps. The apps only ever get Stripe's hosted pages (Checkout, and
 *   the customer portal for changing or cancelling), opened in the browser.
 * - No webhooks: this server sits behind a quick tunnel whose address changes, so Stripe couldn't
 *   reach it reliably. Instead it asks Stripe: right after checkout (the app calls /billing/refresh
 *   when the person comes back), whenever someone opens billing, and every hour for everyone.
 * - A plan can carry Veyra AI limits: while the plan is active they replace the person's limits,
 *   and when it ends their earlier limits come back (Veyra AI's own table, ai_users).
 *
 * STRIPE_API (tests only) points at a stand-in for api.stripe.com.
 */
const API = (process.env.STRIPE_API || 'https://api.stripe.com').replace(/\/$/, '')
const HOUR = 3600_000
/** Statuses that count as having the plan (past_due: Stripe is still retrying the payment). */
const ACTIVE = new Set(['active', 'trialing', 'past_due'])
const DEFAULTS = { open: false, plans: [], returnUrl: '' }

export function setupBilling({ db, q, route, HttpError, Html, isOwner, requireAdmin, getUser, metaGet, metaSet, log, publicUrl = () => '' }) {
  const KEY = process.env.STRIPE_SECRET_KEY || ''
  const mode = !KEY ? 'off' : /^(sk|rk)_test_/.test(KEY) ? 'test' : 'live'

  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_customers (username TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_subs (
      username TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, price_id TEXT NOT NULL, plan_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, period_end INTEGER, cancel_at_end INTEGER NOT NULL DEFAULT 0,
      applied_plan TEXT NOT NULL DEFAULT '', prev_ai TEXT, updated_at INTEGER NOT NULL
    );
  `)

  /* ---------- settings: open to everyone or not, the plans, and where Stripe sends people back ---------- */
  function settings() {
    let s = {}
    try {
      s = JSON.parse(metaGet('billing_settings') || '{}')
    } catch {}
    const plans = Array.isArray(s.plans) ? s.plans.map((p) => ({ ...p, available: p?.available !== false, visible: p?.visible !== false })) : []
    return { ...DEFAULTS, ...s, plans }
  }
  const money = (v) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.round(Number(v) * 100) / 100))
  function cleanPlan(p) {
    const id = String(p?.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30)
    const priceId = String(p?.priceId ?? '').trim()
    if (!id) throw new HttpError(400, 'Each plan needs a short id (letters and numbers).')
    if (!/^price_[A-Za-z0-9]+$/.test(priceId)) throw new HttpError(400, `Plan “${id}”: the Stripe price id starts with price_.`)
    const ai = p?.ai && typeof p.ai === 'object' ? { fiveHour: money(p.ai.fiveHour), week: money(p.ai.week), month: money(p.ai.month) } : null
    return {
      id,
      name: String(p?.name ?? id).trim().slice(0, 40) || id,
      blurb: String(p?.blurb ?? '').trim().slice(0, 300),
      price: String(p?.price ?? '').trim().slice(0, 40), // how it reads in the app, e.g. "$4 a month"
      priceId,
      ai: ai && (ai.fiveHour !== null || ai.week !== null || ai.month !== null) ? ai : null,
      available: p?.available !== false,
      visible: p?.visible !== false
    }
  }
  const planByPrice = (priceId) => settings().plans.find((p) => p.priceId === priceId) ?? null
  const isOpen = (u) => isOwner(u) || settings().open

  /* ---------- talking to Stripe ---------- */
  /** Stripe's form encoding, nested keys included: line_items[0][price]=… */
  function form(obj, prefix = '', out = []) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === undefined || v === null) continue
      const key = prefix ? `${prefix}[${k}]` : k
      if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)))
      else if (typeof v === 'object') form(v, key, out)
      else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
    }
    return out
  }
  async function stripe(method, path, params, idempotencyKey) {
    if (!KEY) throw new HttpError(503, 'Plans aren’t set up on the server yet.')
    const body = method === 'GET' ? undefined : form(params).join('&')
    const url = API + path + (method === 'GET' && params ? `?${form(params).join('&')}` : '')
    let res
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${KEY}`,
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
        },
        body,
        signal: AbortSignal.timeout(20_000)
      })
    } catch (e) {
      log('stripe unreachable', method, path, e?.message ?? e)
      throw new HttpError(502, 'Couldn’t reach Stripe. Try again in a moment.')
    }
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Stripe's own message stays in the server log; people get a plain one.
      log('stripe error', method, path, res.status, j?.error?.type ?? '', j?.error?.code ?? '', String(j?.error?.message ?? '').slice(0, 200))
      throw new HttpError(502, 'Stripe didn’t accept that. Try again, or contact the owner.')
    }
    return j
  }

  async function customerFor(u) {
    const row = q('SELECT customer_id FROM billing_customers WHERE username = ?').get(u)
    if (row) return row.customer_id
    const user = getUser(u)
    const c = await stripe('POST', '/v1/customers', { name: user?.display_name || u, metadata: { veyra_username: u } }, `veyra-customer-${u}`)
    q('INSERT INTO billing_customers (username, customer_id, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING').run(u, c.id, Date.now())
    return q('SELECT customer_id FROM billing_customers WHERE username = ?').get(u).customer_id
  }

  /* ---------- a plan's Veyra AI limits: on while it's active, the earlier ones back after ---------- */
  function applyAi(u, row, plan) {
    if (isOwner(u)) return // the owner has no limits anyway
    const want = plan && ACTIVE.has(row.status) && plan.ai ? plan.id : ''
    if (want === row.applied_plan) return
    const t = Date.now()
    if (want) {
      // Going onto a plan's limits: remember what they had first (only the first time).
      const prev = row.applied_plan ? row.prev_ai : JSON.stringify(q('SELECT five_hour, week, month, approved_at FROM ai_users WHERE username = ?').get(u) ?? null)
      q(`INSERT INTO ai_users (username, five_hour, week, month, approved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET five_hour = excluded.five_hour, week = excluded.week, month = excluded.month, updated_at = excluded.updated_at`).run(u, plan.ai.fiveHour, plan.ai.week, plan.ai.month, t, t)
      q('UPDATE billing_subs SET applied_plan = ?, prev_ai = ? WHERE username = ?').run(want, prev, u)
      log('billing: plan limits on', u, want)
    } else {
      // Off the plan: back to what they had (or not approved, if they weren't before).
      let prev = null
      try {
        prev = JSON.parse(row.prev_ai || 'null')
      } catch {}
      if (prev) q('UPDATE ai_users SET five_hour = ?, week = ?, month = ?, updated_at = ? WHERE username = ?').run(prev.five_hour, prev.week, prev.month, t, u)
      else q('DELETE FROM ai_users WHERE username = ?').run(u)
      q("UPDATE billing_subs SET applied_plan = '', prev_ai = NULL WHERE username = ?").run(u)
      log('billing: plan limits off', u)
    }
  }

  /** Asks Stripe for this person's subscription and saves it. */
  async function sync(u) {
    const c = q('SELECT customer_id FROM billing_customers WHERE username = ?').get(u)
    if (!c) return null
    const list = await stripe('GET', '/v1/subscriptions', { customer: c.customer_id, status: 'all', limit: 10 })
    const subs = Array.isArray(list?.data) ? list.data : []
    // The one that matters: an active one first, then the newest.
    const pick = subs.find((s) => ACTIVE.has(s.status)) ?? subs.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0]
    if (!pick) return null
    const item = pick.items?.data?.[0]
    const priceId = item?.price?.id ?? ''
    const plan = planByPrice(priceId)
    // Newer Stripe API versions keep the period on the item.
    const periodEnd = (pick.current_period_end ?? item?.current_period_end ?? null) * 1000 || null
    q(`INSERT INTO billing_subs (username, subscription_id, price_id, plan_id, status, period_end, cancel_at_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET subscription_id = excluded.subscription_id, price_id = excluded.price_id, plan_id = excluded.plan_id,
       status = excluded.status, period_end = excluded.period_end, cancel_at_end = excluded.cancel_at_end, updated_at = excluded.updated_at`).run(
      u,
      pick.id,
      priceId,
      plan?.id ?? '',
      String(pick.status),
      periodEnd,
      pick.cancel_at_period_end ? 1 : 0,
      Date.now()
    )
    const row = q('SELECT * FROM billing_subs WHERE username = ?').get(u)
    applyAi(u, row, plan)
    return row
  }

  const subView = (row) => {
    if (!row) return null
    const plan = settings().plans.find((p) => p.id === row.plan_id)
    return { planId: row.plan_id, planName: plan?.name ?? 'Unknown plan', status: row.status, active: ACTIVE.has(row.status), periodEnd: row.period_end, cancelAtEnd: !!row.cancel_at_end }
  }
  const publicPlan = (p) => ({ id: p.id, name: p.name, blurb: p.blurb, price: p.price, hasAi: !!p.ai, available: p.available !== false })
  // Where Stripe sends people back to: the owner's choice, else this server's own "back to Veyra" page
  // (its address changes with each tunnel, but it's current at the moment someone checks out).
  const returnUrl = () => settings().returnUrl || (publicUrl() ? `${publicUrl().replace(/\/$/, '')}/billing/return` : 'https://veyra-study-web.igreenrobotz.workers.dev/')

  /* ---------- the page Stripe sends people back to ---------- */
  route(
    'GET',
    '/billing/return',
    ({ url }) => {
      const how = url.searchParams.get('billing')
      const [title, text] =
        how === 'done'
          ? ['Payment done', 'Thank you! Go back to Veyra Study: your plan shows up there in a moment.']
          : how === 'cancelled'
            ? ['Payment cancelled', 'Nothing was charged. You can go back to Veyra Study.']
            : ['All set', 'You can close this tab and go back to Veyra Study.']
      return new Html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Veyra Study</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--ink:#1d1c19;--dim:#6b6860;--card:#fff;--accent:#d9653b}
@media (prefers-color-scheme:dark){:root{--bg:#15140f;--ink:#f0eee8;--dim:#a29f96;--card:#211f1a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{background:var(--card);border-radius:20px;padding:36px 32px;max-width:380px;margin:16px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.12)}
.mark{width:52px;height:52px;border-radius:15px;background:var(--accent);color:#fff;display:grid;place-items:center;margin:0 auto 16px;font-size:26px;font-weight:800}
h1{font-size:22px;margin:0 0 8px}p{margin:0;color:var(--dim)}</style></head>
<body><main><div class="mark">${how === 'done' ? '✓' : 'V'}</div><h1>${title}</h1><p>${text}</p><p style="margin-top:14px;font-size:13px">You can close this tab.</p></main></body></html>`)
    },
    false
  )

  /* ---------- for everyone (once open) ---------- */
  route('GET', '/billing', ({ me }) => {
    const open = isOpen(me)
    const row = q('SELECT * FROM billing_subs WHERE username = ?').get(me)
    return { open, owner: isOwner(me), configured: !!KEY, mode: isOwner(me) ? mode : undefined, plans: open ? settings().plans.filter((p) => p.visible !== false).map(publicPlan) : [], current: subView(row) }
  })

  route('POST', '/billing/checkout', async ({ me, body }) => {
    if (!isOpen(me)) throw new HttpError(403, 'Plans aren’t open yet.')
    const plan = settings().plans.find((p) => p.id === String(body?.planId ?? ''))
    if (!plan) throw new HttpError(404, 'That plan isn’t available.')
    if (plan.visible === false || plan.available === false) throw new HttpError(409, 'This plan isn’t available right now.')
    const now = q('SELECT * FROM billing_subs WHERE username = ?').get(me)
    if (now && ACTIVE.has(now.status)) throw new HttpError(409, 'You already have a plan. Use Manage billing to change it.')
    const customer = await customerFor(me)
    const back = returnUrl()
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: me,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: `${back}${back.includes('?') ? '&' : '?'}billing=done`,
      cancel_url: `${back}${back.includes('?') ? '&' : '?'}billing=cancelled`,
      allow_promotion_codes: 'true',
      metadata: { veyra_username: me, veyra_plan: plan.id },
      subscription_data: { metadata: { veyra_username: me, veyra_plan: plan.id } }
    })
    log('billing: checkout started', me, plan.id)
    return { url: session.url }
  })

  route('POST', '/billing/portal', async ({ me }) => {
    if (!isOpen(me)) throw new HttpError(403, 'Plans aren’t open yet.')
    const c = q('SELECT customer_id FROM billing_customers WHERE username = ?').get(me)
    if (!c) throw new HttpError(404, 'You haven’t had a plan yet.')
    const s = await stripe('POST', '/v1/billing_portal/sessions', { customer: c.customer_id, return_url: returnUrl() })
    return { url: s.url }
  })

  // Back from Stripe (or opening billing): ask Stripe now, at most every 10 s per person.
  route('POST', '/billing/refresh', async ({ me }) => {
    const row = q('SELECT updated_at FROM billing_subs WHERE username = ?').get(me)
    if (!row || Date.now() - row.updated_at > 10_000) await sync(me)
    return { current: subView(q('SELECT * FROM billing_subs WHERE username = ?').get(me)) }
  })

  /* ---------- the owner ---------- */
  route('GET', '/admin/billing', ({ me }) => {
    requireAdmin(me)
    const subs = q('SELECT b.*, c.customer_id FROM billing_subs b LEFT JOIN billing_customers c ON c.username = b.username ORDER BY b.updated_at DESC').all()
    return {
      mode,
      configured: !!KEY,
      settings: settings(),
      subscribers: subs.map((r) => ({ username: r.username, ...subView(r), customerId: r.customer_id, updatedAt: r.updated_at })),
      customers: q('SELECT count(*) AS n FROM billing_customers').get().n
    }
  })

  route('PUT', '/admin/billing', ({ me, body }) => {
    requireAdmin(me)
    const s = settings()
    const plans = Array.isArray(body?.plans) ? body.plans.map(cleanPlan) : s.plans
    if (new Set(plans.map((p) => p.id)).size !== plans.length) throw new HttpError(400, 'Two plans have the same id.')
    let back = body?.returnUrl !== undefined ? String(body.returnUrl).trim() : s.returnUrl
    if (back && !/^https:\/\/[^\s]+$/.test(back)) throw new HttpError(400, 'The return address must start with https://.')
    const next = { open: body?.open !== undefined ? !!body.open : s.open, plans, returnUrl: back }
    if (next.open && !next.plans.length) throw new HttpError(400, 'Add a plan before opening plans to everyone.')
    metaSet('billing_settings', JSON.stringify(next))
    log('billing: settings saved', `open=${next.open}`, `${next.plans.length} plans`)
    return { settings: next }
  })

  route('POST', '/admin/billing/sync', async ({ me }) => {
    requireAdmin(me)
    const n = await syncAll()
    return { synced: n }
  })

  async function syncAll() {
    if (!KEY) return 0
    let n = 0
    for (const { username } of q('SELECT username FROM billing_customers').all()) {
      try {
        await sync(username)
        n++
      } catch {
        /* logged by stripe(); the next round tries again */
      }
    }
    return n
  }
  setInterval(() => void syncAll(), HOUR).unref()

  log(KEY ? `Plans: Stripe ${mode} mode${settings().open ? ', open to everyone' : ', owner only'}` : 'Plans: off (no STRIPE_SECRET_KEY)')
  return { settings, sync, syncAll }
}
