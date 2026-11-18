/**
 * Veyra AI: the owner's Claude API key, shared with the people the owner approves, within limits
 * set in US dollars. The key stays on this server (ANTHROPIC_API_KEY in .env); the apps send the
 * request here and read the answer back by long-polling (quick tunnels don't carry streams).
 *
 * Limits, per person, each counted from their first request in it (like Claude's plans):
 *   - 5 hours, a week (7 days) and a month (30 days). An empty limit means none for that window.
 *   - Nobody can use it until the owner approves them (the owner is never limited).
 * And for everyone together, a monthly total (calendar month, the server's time zone):
 *   - at `breaker` of it (85%): everyone is held to a fair share and the cheapest model;
 *   - at 100%: paused until the 1st (except for the owner).
 *
 * Scaling (can be turned off): when the month is spending slower than its pace, everyone's
 * limits grow (up to 2x, B = 1/sqrt(pace)); when faster, heavy users' limits shrink (down to
 * 0.5x, C = 1/pace; the 5-hour limit by C squared). Heavy = spent at least a fair share in the
 * last 7 days (total / approved people / 4.35 weeks). Both move at most 10% an hour, so bars
 * don't jump mid-session.
 *
 * Money is held before a request (its most it could cost) and settled to the real cost after,
 * so two requests at once, or many people at once, can't go over the monthly total. One request
 * at a time per person. A request that stops early is charged for what it used (estimated if
 * the stream was cut before Claude said); one lost to a server restart keeps its held amount.
 */
import { randomUUID } from 'node:crypto'

const HOUR = 3600_000
const DAY = 24 * HOUR
export const WINDOWS = { '5h': 5 * HOUR, week: 7 * DAY, month: 30 * DAY }

/** US dollars per million tokens. Prefills the owner's model list; the owner can edit them. */
const KNOWN_PRICES = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-fable-5-2': [8, 40],
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50]
}
const DEFAULT_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · fast' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · smarter' }
]
// agentRun: the most one agent task (with its subagents and web research) may cost; agentWeb: research allowed.
// aiTab: the apps' Veyra AI tab is open to everyone approved (off: the owner only, while it's tried out).
const DEFAULTS = { cap: 100, breaker: 0.85, scaling: true, downgrade: true, downgradeAt: 0.75, maxChars: 32_000, fiveHour: 0.4, week: 2.25, agentRun: 0.25, agentWeb: true, aiTab: false }
const MAX_SYSTEM = 4000
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function setupAi({ db, q, route, HttpError, isOwner, requireAdmin, getUser, userCard, metaGet, metaSet, log }) {
  const KEY = process.env.ANTHROPIC_API_KEY || ''
  // Tests move the clock forward instead of waiting hours.
  let offset = 0
  const clock = () => Date.now() + offset

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_models (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
      input REAL NOT NULL, output REAL NOT NULL, cache_write REAL NOT NULL, cache_read REAL NOT NULL,
      effort TEXT, max_tokens INTEGER NOT NULL DEFAULT 12000
    );
    -- Approved people. An empty limit means no limit for that window.
    CREATE TABLE IF NOT EXISTS ai_users (username TEXT PRIMARY KEY, five_hour REAL, week REAL, month REAL, approved_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_windows (username TEXT NOT NULL, kind TEXT NOT NULL, start_at INTEGER NOT NULL, PRIMARY KEY (username, kind));
    -- Every request: held (pending) until it finishes, then its real cost.
    CREATE TABLE IF NOT EXISTS ai_usage (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
      held REAL NOT NULL, cost REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage(username, at);
    CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at);
  `)
  try {
    db.exec('ALTER TABLE ai_usage ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0')
  } catch {} // already there
  if (!q('SELECT 1 FROM ai_models LIMIT 1').get()) DEFAULT_MODELS.forEach((m, i) => saveModel({ ...m, enabled: true, sort: i }))
  // Requests cut off by a restart keep what was held for them.
  q("UPDATE ai_usage SET status = 'lost', cost = held, finished_at = ? WHERE status = 'pending'").run(clock())

  /* ---------- settings ---------- */
  function settings() {
    let s = {}
    try {
      s = JSON.parse(metaGet('ai_settings') || '{}')
    } catch {}
    return { ...DEFAULTS, ...s }
  }
  const num = (v, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Use a number from ${min} to ${max}.`)
    return n
  }
  /** A dollar limit, or null for "no limit". */
  const limitOf = (v) => (v === null || v === '' || v === undefined ? null : Math.round(num(v, 0, 10_000) * 100) / 100)

  function saveModel(m) {
    const [pi, po] = KNOWN_PRICES[m.id] ?? [m.input, m.output]
    const input = m.input ?? pi
    const output = m.output ?? po
    if (!(input >= 0) || !(output >= 0)) throw new HttpError(400, `Set the prices for ${m.id}.`)
    q(`INSERT INTO ai_models (id, label, enabled, sort, input, output, cache_write, cache_read, effort, max_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, enabled = excluded.enabled, sort = excluded.sort, input = excluded.input, output = excluded.output,
         cache_write = excluded.cache_write, cache_read = excluded.cache_read, effort = excluded.effort, max_tokens = excluded.max_tokens`).run(
      m.id,
      String(m.label || m.id).slice(0, 60),
      m.enabled === false ? 0 : 1,
      m.sort ?? 0,
      input,
      output,
      m.cacheWrite ?? input * 1.25,
      m.cacheRead ?? input * 0.1,
      EFFORTS.includes(m.effort) ? m.effort : null,
      Math.round(m.maxTokens ?? 12000)
    )
  }
  const modelView = (r) => ({ id: r.id, label: r.label, enabled: !!r.enabled, input: r.input, output: r.output, cacheWrite: r.cache_write, cacheRead: r.cache_read, effort: r.effort, maxTokens: r.max_tokens })
  const models = () => q('SELECT * FROM ai_models ORDER BY sort, id').all()
  const enabledModels = () => models().filter((m) => m.enabled)
  /** The cheapest switched-on model (by output price): where people are moved near their limit. */
  const cheapest = () => enabledModels().sort((a, b) => a.output - b.output || a.input - b.input)[0] ?? null

  /* ---------- money ---------- */
  // A request in progress counts at what's held for it; a finished one at what it cost.
  const CHARGE = "CASE status WHEN 'pending' THEN held ELSE cost END"
  const spentBy = (u, since) => q(`SELECT coalesce(sum(${CHARGE}), 0) AS s FROM ai_usage WHERE username = ? AND at >= ?`).get(u, since).s
  const spentAll = (since) => q(`SELECT coalesce(sum(${CHARGE}), 0) AS s FROM ai_usage WHERE at >= ?`).get(since).s
  // Web searches are $10 per 1,000 on top of tokens (web fetch is only its tokens).
  const price = (m, u) => (u.input * m.input + u.output * m.output + u.cacheWrite * m.cache_write + u.cacheRead * m.cache_read) / 1e6 + (u.webSearches ?? 0) * 0.01

  function month() {
    const d = new Date(clock())
    const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    return { start, end, t: (clock() - start) / (end - start) }
  }

  /** How the whole month is going, and the boost / throttle that follows from it. */
  function pace() {
    const s = settings()
    const m = month()
    const spent = spentAll(m.start)
    const approved = q('SELECT count(*) AS n FROM ai_users').get().n
    // The first days count as 15% of the month, so early noise neither throttles nor boosts.
    const p = spent / Math.max(0.15 * s.cap, s.cap * m.t)
    const boostTarget = !s.scaling || p >= 0.85 ? 1 : Math.min(2, p > 0 ? 1 / Math.sqrt(p) : 2)
    const throttleTarget = !s.scaling || p <= 1.05 ? 1 : Math.max(0.5, 1 / p)
    // Move at most 10% an hour toward the target (bars don't jump mid-session).
    const saved = metaGet('ai_pace')
    let st = { b: 1, c: 1, at: clock() }
    try {
      st = { ...st, ...JSON.parse(saved || '{}') }
    } catch {}
    const step = Math.max(0, (clock() - st.at) / HOUR) * 0.1
    const toward = (v, target) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step))
    const b = toward(st.b, boostTarget)
    const c = toward(st.c, throttleTarget)
    if (!saved || b !== st.b || c !== st.c || clock() - st.at >= HOUR) metaSet('ai_pace', JSON.stringify({ b, c, at: clock() }))
    const fairShare = s.cap / Math.max(1, approved) / 4.35
    return { cap: s.cap, spent, pace: p, boost: b, throttle: c, fairShare, approved, breaker: spent >= s.breaker * s.cap, paused: spent >= s.cap, month: m }
  }

  /** A window of someone's: when it started (if it's running), what they've spent in it. */
  function windowOf(u, kind) {
    const row = q('SELECT start_at FROM ai_windows WHERE username = ? AND kind = ?').get(u, kind)
    const start = row && clock() < row.start_at + WINDOWS[kind] ? row.start_at : null
    return { start, resetsAt: start ? start + WINDOWS[kind] : null, spent: start ? spentBy(u, start) : 0 }
  }

  /** Someone's limits right now (after scaling and the 85% brake), and how much of each is used. */
  function standing(u) {
    const s = settings()
    const g = pace()
    const row = q('SELECT * FROM ai_users WHERE username = ?').get(u)
    const owner = isOwner(u)
    const heavy = spentBy(u, clock() - 7 * DAY) >= g.fairShare
    const scale = { '5h': g.boost * (heavy ? g.throttle ** 2 : 1), week: g.boost * (heavy ? g.throttle : 1), month: 1 }
    const base = { '5h': row?.five_hour ?? null, week: row?.week ?? null, month: row?.month ?? null }
    const windows = {}
    for (const kind of Object.keys(WINDOWS)) {
      let limit = owner || base[kind] === null ? null : base[kind] * scale[kind]
      if (g.breaker && !owner && limit !== null) {
        if (kind === 'week') limit = Math.min(limit, g.fairShare)
        if (kind === '5h') limit = Math.min(limit, base[kind] * 0.5)
      }
      const w = windowOf(u, kind)
      windows[kind] = { ...w, limit, used: limit === null ? null : limit > 0 ? w.spent / limit : 1 }
    }
    const fullest = Math.max(0, ...Object.values(windows).map((w) => w.used ?? 0))
    return { approved: owner || !!row, owner, heavy, windows, fullest, g, s }
  }

  /** Why this person can't send a request now, or null. */
  function blocked(st) {
    if (!KEY) return 'Veyra AI isn’t set up on the server yet.'
    if (!st.approved) return 'Veyra AI is by invitation. Ask the owner of Veyra Study to give you access.'
    if (st.owner) return null
    if (st.g.paused) return 'Veyra AI has reached this month’s total and is paused until the 1st.'
    for (const [kind, w] of Object.entries(st.windows)) {
      if (w.used !== null && w.used >= 1) return kind === 'month' ? 'You’ve used your monthly Veyra AI limit.' : kind === 'week' ? 'You’ve used your weekly Veyra AI limit.' : 'You’ve used your 5-hour Veyra AI limit.'
    }
    return null
  }

  /** What a person sees: how full each bar is, and when it resets (no dollar amounts). */
  function publicView(u) {
    const st = standing(u)
    const pick = st.g.breaker && !st.owner ? cheapest() : null
    return {
      configured: !!KEY,
      approved: st.approved,
      owner: st.owner,
      models: (pick ? [pick] : enabledModels()).map((m) => ({ id: m.id, label: m.label })),
      limits: Object.entries(st.windows)
        .filter(([, w]) => w.limit !== null)
        .map(([kind, w]) => ({ kind, used: Math.min(1, Math.round((w.used ?? 0) * 1000) / 1000), resetsAt: w.resetsAt })),
      boost: st.g.boost >= 1.15 && !st.g.breaker,
      saving: st.g.breaker,
      downgradeAt: st.s.downgrade ? st.s.downgradeAt : null,
      maxChars: st.s.maxChars,
      agentWeb: st.s.agentWeb,
      aiTab: !!st.s.aiTab,
      blocked: blocked(st),
      busy: running.has(u)
    }
  }

  /* ---------- running requests ---------- */
  let client = null
  async function anthropic() {
    if (!client) {
      // Loaded only when it's first needed: a missing key or package never stops the rest of the server.
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      client = new Anthropic({ apiKey: KEY, maxRetries: 2 })
    }
    return client
  }

  const jobs = new Map() // id -> { id, username, model, text, done, error, waiters, abort, ... }
  /** People with a request or an agent run going: one at a time each (agent.mjs claims too). */
  const running = new Set()
  function claim(u) {
    if (running.has(u)) throw new HttpError(409, 'Veyra AI is still working on your last request.')
    running.add(u)
    let done = false
    return () => {
      if (!done) running.delete(u)
      done = true
    }
  }
  const wake = (j) => {
    for (const w of [...j.waiters]) w()
  }
  setInterval(() => {
    for (const [id, j] of jobs) if (j.done && clock() - j.doneAt > 10 * 60_000) jobs.delete(id)
  }, 60_000).unref()

  async function runJob(j, m) {
    let usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    let stop = null
    let exact = false
    try {
      const api = await anthropic()
      const stream = api.messages.stream(
        {
          model: m.id,
          max_tokens: m.max_tokens,
          system: j.system,
          messages: [{ role: 'user', content: j.prompt }],
          ...(m.effort ? { output_config: { effort: m.effort } } : {})
        },
        { signal: j.abort.signal }
      )
      for await (const ev of stream) {
        if (ev.type === 'message_start') {
          j.started = true // Claude has the request: from here it's billed
          const u = ev.message.usage
          usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 }
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          j.text += ev.delta.text
          wake(j)
        } else if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens
          stop = ev.delta.stop_reason ?? stop
        }
      }
      const final = await stream.finalMessage()
      const u = final.usage
      usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 }
      stop = final.stop_reason
      exact = true
      if (stop === 'refusal') j.error = 'Claude declined to answer this. Try rewording it, or pick a different part of your notes.'
    } catch (e) {
      if (j.cancelled) j.error = null
      else {
        const status = e?.status
        j.error =
          status === 429 || status === 529
            ? 'Claude is busy right now. Try again in a minute.'
            : status === 401 || status === 403
              ? 'Veyra AI’s key isn’t working. The owner needs to check it.'
              : status === 400
                ? 'Claude couldn’t take this request.'
                : 'Couldn’t reach Claude. Try again.'
        log('ai error', j.username, m.id, status ?? '', String(e?.message ?? e).slice(0, 200))
      }
    }
    // Stopped before Claude said what it used: estimate it (its thinking isn't visible, so by time too).
    if (!exact) {
      const secs = (clock() - j.startedAt) / 1000
      usage.input ||= Math.ceil((j.system.length + j.prompt.length) / 3.5)
      usage.output = Math.min(m.max_tokens, Math.max(usage.output, Math.ceil(j.text.length / 3.5), Math.ceil(secs * 100)))
      // Claude never started on it (refused at the door, or cancelled first): nothing to charge.
      if (!j.started) usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    }
    const cost = price(m, usage)
    q('UPDATE ai_usage SET status = ?, cost = ?, input_tokens = ?, output_tokens = ?, cache_read = ?, cache_write = ?, finished_at = ? WHERE id = ?').run(
      j.cancelled ? 'cancelled' : j.error ? (stop === 'refusal' ? 'refused' : 'error') : 'done',
      cost,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      clock(),
      j.id
    )
    j.done = true
    j.doneAt = clock()
    j.stop = stop
    j.release?.()
    wake(j)
  }

  /** The model: the one asked for, unless near a limit (or the month is near its total), then the cheapest. */
  function pickModel(st, wanted) {
    let m = enabledModels().find((x) => x.id === wanted) ?? enabledModels()[0]
    if (!m) throw new HttpError(503, 'No Veyra AI models are switched on.')
    const low = cheapest()
    if (!st.owner && low && low.id !== m.id && (st.g.breaker || (st.s.downgrade && st.fullest >= st.s.downgradeAt))) return { m: low, downgraded: true }
    return { m, downgraded: false }
  }
  const modelById = (id) => q('SELECT * FROM ai_models WHERE id = ?').get(id)

  /**
   * One model call (for agent.mjs): checks the person's limits and the month's total, holds the
   * most it could cost (input from its estimate, output at max_tokens), and starts any windows.
   * Returns the usage id to settle. Throws HttpError with a message to show when it can't.
   */
  function admit(u, m, inputTokens, maxTokens, extraHold = 0) {
    const st = standing(u)
    const why = blocked(st)
    if (why) throw new HttpError(403, why)
    const held = price(m, { input: inputTokens, output: maxTokens, cacheWrite: 0, cacheRead: 0 }) + extraHold
    if (!st.owner && st.g.spent + held > st.g.cap) throw new HttpError(403, 'Veyra AI is close to this month’s total and is paused until the 1st.')
    const t = clock()
    for (const kind of Object.keys(WINDOWS)) {
      if (!st.windows[kind].start) q('INSERT INTO ai_windows (username, kind, start_at) VALUES (?, ?, ?) ON CONFLICT(username, kind) DO UPDATE SET start_at = excluded.start_at').run(u, kind, t)
    }
    const id = randomUUID()
    q("INSERT INTO ai_usage (id, username, model, status, held, at) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, u, m.id, held, t)
    return { id, held }
  }
  /** Settles a call to what it really cost; returns that cost. */
  function settle(id, m, usage, status) {
    const cost = price(m, usage)
    q('UPDATE ai_usage SET status = ?, cost = ?, input_tokens = ?, output_tokens = ?, cache_read = ?, cache_write = ?, web_searches = ?, finished_at = ? WHERE id = ?').run(
      status,
      cost,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.webSearches ?? 0,
      clock(),
      id
    )
    return cost
  }

  /* ---------- routes: everyone ---------- */
  route('GET', '/ai', ({ me }) => publicView(me))

  route('POST', '/ai/jobs', ({ me, body }) => {
    const st = standing(me)
    const why = blocked(st)
    if (why) throw new HttpError(403, why)
    const system = String(body?.system ?? '')
    const prompt = String(body?.prompt ?? '')
    if (!prompt.trim()) throw new HttpError(400, 'There’s nothing to send.')
    if (system.length > MAX_SYSTEM) throw new HttpError(400, 'That request is too long.')
    if (prompt.length > st.s.maxChars)
      throw new HttpError(413, `That’s too long for Veyra AI (${prompt.length.toLocaleString('en')} characters; the most is ${st.s.maxChars.toLocaleString('en')}). Select a part of the note and use the AI on that.`)

    const { m, downgraded } = pickModel(st, body?.model)

    // Hold the most it could cost; the month's total must allow it (limits per person can be
    // passed by one request, the total can't).
    const held = price(m, { input: Math.ceil((system.length + prompt.length) / 2.5), output: m.max_tokens, cacheWrite: 0, cacheRead: 0 })
    if (!st.owner && st.g.spent + held > st.g.cap) throw new HttpError(403, 'Veyra AI is close to this month’s total and is paused until the 1st.')
    const t = clock()
    for (const kind of Object.keys(WINDOWS)) {
      if (!st.windows[kind].start) q('INSERT INTO ai_windows (username, kind, start_at) VALUES (?, ?, ?) ON CONFLICT(username, kind) DO UPDATE SET start_at = excluded.start_at').run(me, kind, t)
    }
    const release = claim(me)
    const id = randomUUID()
    q("INSERT INTO ai_usage (id, username, model, status, held, at) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, me, m.id, held, t)
    const j = { release, id, username: me, model: m.id, system, prompt, text: '', done: false, error: null, waiters: new Set(), abort: new AbortController(), startedAt: t, started: false }
    jobs.set(id, j)
    void runJob(j, m)
    return { id, model: { id: m.id, label: m.label }, downgraded }
  })

  // The answer so far, from character `from` on. Waits up to 20 s for more.
  route('GET', '/ai/jobs/:id', async ({ me, params, url, req }) => {
    const j = jobs.get(params.id)
    if (!j || j.username !== me) throw new HttpError(404, 'That answer isn’t here any more.')
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0)
    if (!j.done && j.text.length <= from) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          j.waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, 20_000)
        j.waiters.add(done)
        req.on('close', done)
      })
    }
    return { text: j.text.slice(from), length: j.text.length, done: j.done, error: j.error, cut: j.stop === 'max_tokens' }
  })

  route('DELETE', '/ai/jobs/:id', ({ me, params }) => {
    const j = jobs.get(params.id)
    if (j && j.username === me && !j.done) {
      j.cancelled = true
      j.abort.abort()
    }
    return { ok: true }
  })

  /* ---------- routes: the owner ---------- */
  route('GET', '/admin/ai', async ({ me }) => {
    requireAdmin(me)
    const g = pace()
    let available = null
    let keyError = null
    if (KEY) {
      try {
        const api = await anthropic()
        available = []
        for await (const m of api.models.list({ limit: 100 })) available.push({ id: m.id, name: m.display_name, price: KNOWN_PRICES[m.id] ?? null })
      } catch (e) {
        keyError = e?.status === 401 ? 'The key was refused. Check it in the server’s .env file.' : 'Couldn’t reach Anthropic to list models.'
      }
    }
    const byModel = q(`SELECT model, count(*) AS n, coalesce(sum(${CHARGE}), 0) AS s FROM ai_usage WHERE at >= ? GROUP BY model`).all(g.month.start)
    return {
      keySet: !!KEY,
      keyError,
      settings: settings(),
      month: { spent: g.spent, cap: g.cap, pace: g.pace, boost: g.boost, throttle: g.throttle, fairShare: g.fairShare, approved: g.approved, breaker: g.breaker, paused: g.paused, resetsAt: g.month.end, byModel },
      models: models().map(modelView),
      available
    }
  })

  route('PUT', '/admin/ai/settings', ({ me, body }) => {
    requireAdmin(me)
    const s = settings()
    const next = {
      cap: body?.cap !== undefined ? num(body.cap, 0, 100_000) : s.cap,
      breaker: body?.breaker !== undefined ? num(body.breaker, 0.5, 1) : s.breaker,
      scaling: body?.scaling !== undefined ? !!body.scaling : s.scaling,
      downgrade: body?.downgrade !== undefined ? !!body.downgrade : s.downgrade,
      downgradeAt: body?.downgradeAt !== undefined ? num(body.downgradeAt, 0.3, 1) : s.downgradeAt,
      maxChars: body?.maxChars !== undefined ? Math.round(num(body.maxChars, 1000, 400_000)) : s.maxChars,
      fiveHour: body?.fiveHour !== undefined ? limitOf(body.fiveHour) : s.fiveHour,
      week: body?.week !== undefined ? limitOf(body.week) : s.week,
      agentRun: body?.agentRun !== undefined ? num(body.agentRun, 0.01, 50) : s.agentRun,
      agentWeb: body?.agentWeb !== undefined ? !!body.agentWeb : s.agentWeb,
      aiTab: body?.aiTab !== undefined ? !!body.aiTab : !!s.aiTab
    }
    metaSet('ai_settings', JSON.stringify(next))
    return { settings: next }
  })

  route('PUT', '/admin/ai/models', ({ me, body }) => {
    requireAdmin(me)
    const list = Array.isArray(body?.models) ? body.models : null
    if (!list || list.length > 30) throw new HttpError(400, 'Bad request.')
    const ids = new Set()
    db.exec('BEGIN')
    try {
      list.forEach((m, i) => {
        if (typeof m?.id !== 'string' || !/^[a-z0-9.-]{3,80}$/.test(m.id) || ids.has(m.id)) throw new HttpError(400, 'Bad model id.')
        ids.add(m.id)
        saveModel({
          id: m.id,
          label: m.label,
          enabled: m.enabled !== false,
          sort: i,
          input: m.input !== undefined ? num(m.input, 0, 1000) : undefined,
          output: m.output !== undefined ? num(m.output, 0, 1000) : undefined,
          cacheWrite: m.cacheWrite !== undefined ? num(m.cacheWrite, 0, 1000) : undefined,
          cacheRead: m.cacheRead !== undefined ? num(m.cacheRead, 0, 1000) : undefined,
          effort: m.effort,
          maxTokens: m.maxTokens !== undefined ? num(m.maxTokens, 256, 128_000) : undefined
        })
      })
      const keep = [...ids]
      q(`DELETE FROM ai_models WHERE id NOT IN (${keep.map(() => '?').join(',') || "''"})`).run(...keep)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { models: models().map(modelView) }
  })

  route('GET', '/admin/ai/users', ({ me }) => {
    requireAdmin(me)
    const t = clock()
    const rows = q('SELECT u.username, a.five_hour, a.week, a.month, a.approved_at FROM users u LEFT JOIN ai_users a ON a.username = u.username ORDER BY a.approved_at IS NULL, u.seen_at DESC').all()
    return {
      users: rows.map((r) => {
        const st = standing(r.username)
        return {
          ...userCard(getUser(r.username)),
          owner: st.owner,
          approved: !!r.approved_at,
          base: { fiveHour: r.five_hour, week: r.week, month: r.month },
          heavy: st.heavy,
          windows: Object.fromEntries(Object.entries(st.windows).map(([k, w]) => [k, { spent: w.spent, limit: w.limit, resetsAt: w.resetsAt }])),
          last30: spentBy(r.username, t - 30 * DAY),
          requests30: q('SELECT count(*) AS n FROM ai_usage WHERE username = ? AND at >= ?').get(r.username, t - 30 * DAY).n
        }
      })
    }
  })

  // Approve someone, or change their limits (dollars; empty = no limit for that window).
  route('PUT', '/admin/ai/users/:username', ({ me, params, body }) => {
    requireAdmin(me)
    if (!getUser(params.username)) throw new HttpError(404, 'That person hasn’t used Group work or sync yet.')
    const s = settings()
    const v = (k, d) => (body && k in body ? limitOf(body[k]) : d)
    const old = q('SELECT * FROM ai_users WHERE username = ?').get(params.username)
    const t = clock()
    q(`INSERT INTO ai_users (username, five_hour, week, month, approved_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET five_hour = excluded.five_hour, week = excluded.week, month = excluded.month, updated_at = excluded.updated_at`).run(
      params.username,
      v('fiveHour', old ? old.five_hour : s.fiveHour),
      v('week', old ? old.week : s.week),
      v('month', old ? old.month : null),
      old?.approved_at ?? t,
      t
    )
    return { ok: true }
  })

  route('DELETE', '/admin/ai/users/:username', ({ me, params }) => {
    requireAdmin(me)
    q('DELETE FROM ai_users WHERE username = ?').run(params.username)
    return { ok: true }
  })

  // Tests only (AI_TEST=1): move the clock forward.
  if (process.env.AI_TEST === '1') {
    route('POST', '/ai/test/clock', ({ body }) => {
      offset += Number(body?.ms) || 0
      return { now: clock() }
    })
  }

  log(KEY ? 'Veyra AI: on' : 'Veyra AI: off (no ANTHROPIC_API_KEY)')
  return { KEY, clock, anthropic, standing, blocked, pickModel, modelById, cheapest, enabledModels, settings, admit, settle, claim }
}
