#!/usr/bin/env node
/**
 * Veyra Study group server. Runs on the owner's phone (Termux, Node 22.13+)
 * or any computer. One file, no npm packages: node:http + node:sqlite.
 *
 * - Sign-in: the app gets a 15-minute pass from the relay (which checked the
 *   person's Veyra account) and trades it here for a session. The pass is
 *   signed with SIGNING_KEY, shared only by the relay and this server.
 * - Groups with members, invite codes, and invites by @username that the
 *   other person must accept.
 * - Group items: tasks, chat messages, shared notes (with revisions, so a
 *   stale save is refused), and deadlines.
 * - Live updates by long-polling (Cloudflare quick tunnels don't carry
 *   server-sent events).
 * - Starts cloudflared, reads its trycloudflare.com address and publishes it
 *   to the relay; restarts it if it stops. Daily backups.
 *
 * Settings come from the environment or a .env file next to this one:
 *   SIGNING_KEY   (required) same value as the relay's SIGNING_KEY
 *   RELAY_URL     e.g. https://veyra-study-relay.you.workers.dev
 *   RELAY_SECRET  same value as the relay's RELAY_SECRET
 *   PORT          default 8790
 *   DATA_DIR      default ./veyra-group-data
 *   TUNNEL        "off" to skip cloudflared (e.g. testing on a PC)
 *   CLOUDFLARED   path to cloudflared, default "cloudflared"
 */
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.2.4'
const HERE = dirname(fileURLToPath(import.meta.url))

/* ---------- settings ---------- */
const envFile = join(HERE, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const SIGNING_KEY = process.env.SIGNING_KEY || ''
const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/$/, '')
const RELAY_SECRET = process.env.RELAY_SECRET || ''
const PORT = Number(process.env.PORT || 8790)
const DATA_DIR = process.env.DATA_DIR || join(HERE, 'veyra-group-data')
const TUNNEL = (process.env.TUNNEL || 'on').toLowerCase() !== 'off'
const CLOUDFLARED = process.env.CLOUDFLARED || 'cloudflared'
if (SIGNING_KEY.length < 32) {
  console.error('SIGNING_KEY is missing or too short (32+ characters). See the setup steps.')
  process.exit(1)
}

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a)

/* ---------- database ---------- */
mkdirSync(DATA_DIR, { recursive: true })
const db = new DatabaseSync(join(DATA_DIR, 'group.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, display_name TEXT NOT NULL, photo_url TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups_ (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, owner TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS members (
    group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE, username TEXT NOT NULL,
    role TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (group_id, username)
  );
  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
    username TEXT NOT NULL, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (group_id, username)
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, data TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_group_seq ON items(group_id, seq);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Personal sync: each person's own records (tasks, notes, subjects, study time), never shared.
  CREATE TABLE IF NOT EXISTS personal (
    username TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    device_id TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (username, id)
  );
  CREATE INDEX IF NOT EXISTS personal_seq ON personal(username, seq);
`)
const q = (sql) => db.prepare(sql)
const metaGet = (k) => q('SELECT value FROM meta WHERE key = ?').get(k)?.value
const metaSet = (k, v) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v))

/** One counter for everything that changes, so clients can ask "what changed since N?". */
let seq = Number(metaGet('seq') || 0)
const nextSeq = () => {
  seq += 1
  metaSet('seq', seq)
  return seq
}

/* ---------- long-poll: wake waiting clients when something changes ---------- */
const waiters = new Set() // { username, resolve }
function notify(usernames) {
  const who = new Set(usernames)
  for (const w of [...waiters]) if (who.has(w.username)) w.resolve()
}
const membersOf = (groupId) => q('SELECT username FROM members WHERE group_id = ?').all(groupId).map((r) => r.username)

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const now = () => Date.now()
const COLORS = ['#b3492b', '#3f6b4a', '#2f5f8a', '#7a4f9a', '#a86f1d', '#2f7d7a', '#9a3f63', '#5b5a55']

function verifyPass(pass) {
  const [body, mac] = String(pass || '').split('.')
  if (!body || !mac) throw new HttpError(401, 'Sign-in pass is missing.')
  const expect = createHmac('sha256', SIGNING_KEY).update(body).digest()
  const got = b64urlDecode(mac)
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw new HttpError(401, 'Sign-in pass isn’t valid.')
  let p
  try {
    p = JSON.parse(b64urlDecode(body).toString('utf8'))
  } catch {
    throw new HttpError(401, 'Sign-in pass isn’t valid.')
  }
  if (p.aud !== 'veyra-group') throw new HttpError(401, 'Sign-in pass is for something else.')
  if (!(p.exp > Date.now() / 1000)) throw new HttpError(401, 'Sign-in pass has expired.')
  if (typeof p.u !== 'string' || !/^[a-z0-9_.-]{3,30}$/.test(p.u)) throw new HttpError(401, 'Sign-in pass isn’t valid.')
  return p
}

const userCard = (u) => (u ? { username: u.username, displayName: u.display_name, photoUrl: u.photo_url, verified: !!u.verified } : null)
const getUser = (username) => q('SELECT * FROM users WHERE username = ?').get(username)
const membership = (groupId, username) => q('SELECT role FROM members WHERE group_id = ? AND username = ?').get(groupId, username)

/** The one gate for every group route: 404 (not 403) so group ids can't be probed. */
function requireMember(groupId, username) {
  const m = membership(groupId, username)
  if (!m) throw new HttpError(404, 'That group doesn’t exist, or you’re not in it.')
  return m.role
}
function requireOwner(groupId, username) {
  if (requireMember(groupId, username) !== 'owner') throw new HttpError(403, 'Only the group’s owner can do that.')
}

function groupView(g, username) {
  const members = q(`SELECT m.username, m.role, m.joined_at, u.display_name, u.photo_url, u.verified FROM members m JOIN users u ON u.username = m.username WHERE m.group_id = ? ORDER BY m.role = 'owner' DESC, m.joined_at`)
    .all(g.id)
    .map((m) => ({ ...userCard(m), role: m.role, joinedAt: m.joined_at }))
  const role = members.find((m) => m.username === username)?.role
  return {
    id: g.id,
    name: g.name,
    color: g.color,
    owner: g.owner,
    role,
    inviteCode: role === 'owner' ? g.invite_code : undefined,
    members,
    createdAt: g.created_at
  }
}

const newCode = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
  for (;;) {
    const bytes = randomBytes(6)
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
    if (!q('SELECT 1 FROM groups_ WHERE invite_code = ?').get(code)) return code
  }
}

/* ---------- validating group content ---------- */
const KINDS = { task: 20_000, message: 4_000, note: 400_000, event: 4_000 }
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const isTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)

/** Removes links that aren't http(s) or mailto from a note's rich text. */
function safeDoc(doc, depth = 0) {
  if (!doc || typeof doc !== 'object' || depth > 60) return null
  const out = { type: str(doc.type, 40) }
  if (doc.attrs && typeof doc.attrs === 'object') out.attrs = doc.attrs
  if (typeof doc.text === 'string') out.text = doc.text.slice(0, 50_000)
  if (Array.isArray(doc.marks)) {
    out.marks = doc.marks
      .filter((m) => m && typeof m.type === 'string')
      .filter((m) => m.type !== 'link' || /^(https?:|mailto:)/i.test(String(m.attrs?.href || '')))
      .map((m) => ({ type: m.type, ...(m.attrs ? { attrs: m.attrs } : {}) }))
  }
  if (Array.isArray(doc.content)) out.content = doc.content.slice(0, 5000).map((c) => safeDoc(c, depth + 1)).filter(Boolean)
  return out
}

function cleanItem(kind, data, groupId) {
  if (!KINDS[kind]) throw new HttpError(400, 'Unknown item type.')
  if (!data || typeof data !== 'object') throw new HttpError(400, 'Missing item data.')
  const assignee = (u) => (typeof u === 'string' && u && membership(groupId, u) ? u : null)
  let clean
  if (kind === 'task')
    clean = {
      title: str(data.title, 300).trim(),
      details: str(data.details, 4000),
      assignee: assignee(data.assignee),
      due: isDate(data.due) ? data.due : null,
      done: !!data.done,
      doneBy: data.done ? str(data.doneBy, 30) || null : null,
      doneAt: data.done ? Number(data.doneAt) || null : null,
      priority: ['low', 'normal', 'high'].includes(data.priority) ? data.priority : 'normal'
    }
  else if (kind === 'message') clean = { text: str(data.text, 4000).trim() }
  else if (kind === 'event')
    clean = { title: str(data.title, 200).trim(), date: isDate(data.date) ? data.date : null, time: isTime(data.time) ? data.time : null, details: str(data.details, 2000) }
  else clean = { title: str(data.title, 200), icon: str(data.icon, 8), content: safeDoc(data.content), excerpt: str(data.excerpt, 300) }
  if ((kind === 'task' || kind === 'event') && !clean.title) throw new HttpError(400, 'Give it a title.')
  if (kind === 'event' && !clean.date) throw new HttpError(400, 'Pick a date.')
  if (kind === 'message' && !clean.text) throw new HttpError(400, 'Write a message.')
  const json = JSON.stringify(clean)
  if (json.length > KINDS[kind]) throw new HttpError(413, 'That’s too large.')
  return json
}

const itemView = (r) => ({
  id: r.id,
  kind: r.kind,
  data: JSON.parse(r.data),
  rev: r.rev,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  deleted: !!r.deleted,
  seq: r.seq
})

function touchGroup(groupId) {
  const s = nextSeq()
  q('UPDATE groups_ SET seq = ? WHERE id = ?').run(s, groupId)
  notify(membersOf(groupId))
  return s
}

/* ---------- rate limits (in memory) ---------- */
const buckets = new Map()
function limit(key, max, perMs) {
  const t = now()
  const b = buckets.get(key) ?? { n: 0, reset: t + perMs }
  if (t > b.reset) {
    b.n = 0
    b.reset = t + perMs
  }
  b.n += 1
  buckets.set(key, b)
  if (b.n > max) throw new HttpError(429, 'Too many requests. Slow down a little.')
}
setInterval(() => {
  const t = now()
  for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k)
}, 60_000).unref()

/* ---------- routes ---------- */
const routes = []
const route = (method, pattern, handler, auth = true) => {
  const keys = []
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$')
  routes.push({ method, re, keys, handler, auth })
}

route('GET', '/health', () => ({ ok: true, service: 'veyra-group', version: VERSION }), false)

// Trade a relay pass for a session.
route(
  'POST',
  '/session',
  ({ body, ip }) => {
    limit(`session:${ip}`, 20, 60_000)
    const p = verifyPass(body?.pass)
    const t = now()
    const existing = getUser(p.u)
    if (existing) q('UPDATE users SET display_name = ?, photo_url = ?, verified = ?, seen_at = ? WHERE username = ?').run(p.n, p.p, p.v ? 1 : 0, t, p.u)
    else q('INSERT INTO users (username, display_name, photo_url, verified, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(p.u, p.n, p.p, p.v ? 1 : 0, t, t)
    const token = randomBytes(32).toString('hex')
    q('INSERT INTO sessions (hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), p.u, t, t + 30 * 86400_000)
    q('DELETE FROM sessions WHERE expires_at < ?').run(t)
    return { session: token, me: userCard(getUser(p.u)), expiresAt: t + 30 * 86400_000 }
  },
  false
)

route('DELETE', '/session', ({ token }) => {
  q('DELETE FROM sessions WHERE hash = ?').run(sha(token))
  return { ok: true }
})

route('GET', '/me', ({ me }) => ({ me: userCard(getUser(me)) }))

// Find people (only those who've opened Group work at least once).
route('GET', '/users/search', ({ me, url }) => {
  limit(`search:${me}`, 60, 60_000)
  const term = String(url.searchParams.get('q') || '').trim().toLowerCase().replace(/^@/, '')
  if (term.length < 2) return { users: [] }
  const like = `${term.replace(/[%_]/g, '')}%`
  const rows = q('SELECT * FROM users WHERE (username LIKE ? OR lower(display_name) LIKE ?) AND username != ? ORDER BY username = ? DESC, username LIMIT 10').all(like, like, me, term)
  return { users: rows.map(userCard) }
})

// Groups
route('GET', '/groups', ({ me }) => ({
  groups: q('SELECT g.* FROM groups_ g JOIN members m ON m.group_id = g.id WHERE m.username = ? ORDER BY g.created_at').all(me).map((g) => groupView(g, me))
}))

route('POST', '/groups', ({ me, body }) => {
  limit(`create:${me}`, 20, 3600_000)
  const name = str(body?.name, 60).trim()
  if (!name) throw new HttpError(400, 'Give the group a name.')
  const color = COLORS.includes(body?.color) ? body.color : COLORS[Math.floor(Math.random() * COLORS.length)]
  const id = randomUUID()
  const t = now()
  q('INSERT INTO groups_ (id, name, color, owner, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, color, me, newCode(), t)
  q('INSERT INTO members (group_id, username, role, joined_at) VALUES (?, ?, ?, ?)').run(id, me, 'owner', t)
  touchGroup(id)
  return { group: groupView(q('SELECT * FROM groups_ WHERE id = ?').get(id), me) }
})

route('GET', '/groups/:id', ({ me, params }) => {
  requireMember(params.id, me)
  return { group: groupView(q('SELECT * FROM groups_ WHERE id = ?').get(params.id), me) }
})

route('PATCH', '/groups/:id', ({ me, params, body }) => {
  requireOwner(params.id, me)
  const g = q('SELECT * FROM groups_ WHERE id = ?').get(params.id)
  const name = body?.name !== undefined ? str(body.name, 60).trim() || g.name : g.name
  const color = COLORS.includes(body?.color) ? body.color : g.color
  q('UPDATE groups_ SET name = ?, color = ? WHERE id = ?').run(name, color, params.id)
  touchGroup(params.id)
  return { group: groupView(q('SELECT * FROM groups_ WHERE id = ?').get(params.id), me) }
})

route('DELETE', '/groups/:id', ({ me, params }) => {
  requireOwner(params.id, me)
  const who = membersOf(params.id)
  q('DELETE FROM groups_ WHERE id = ?').run(params.id)
  nextSeq()
  notify(who)
  return { ok: true }
})

route('POST', '/groups/:id/code', ({ me, params }) => {
  requireOwner(params.id, me)
  q('UPDATE groups_ SET invite_code = ? WHERE id = ?').run(newCode(), params.id)
  touchGroup(params.id)
  return { group: groupView(q('SELECT * FROM groups_ WHERE id = ?').get(params.id), me) }
})

route('POST', '/groups/:id/leave', ({ me, params }) => {
  const role = requireMember(params.id, me)
  if (role === 'owner') {
    // Hand the group to the longest-standing member, or delete it if nobody's left.
    const next = q('SELECT username FROM members WHERE group_id = ? AND username != ? ORDER BY joined_at LIMIT 1').get(params.id, me)
    if (!next) {
      q('DELETE FROM groups_ WHERE id = ?').run(params.id)
      nextSeq()
      notify([me])
      return { ok: true, deleted: true }
    }
    q('UPDATE members SET role = ? WHERE group_id = ? AND username = ?').run('owner', params.id, next.username)
    q('UPDATE groups_ SET owner = ? WHERE id = ?').run(next.username, params.id)
  }
  q('DELETE FROM members WHERE group_id = ? AND username = ?').run(params.id, me)
  touchGroup(params.id)
  notify([me])
  return { ok: true }
})

route('DELETE', '/groups/:id/members/:username', ({ me, params }) => {
  requireOwner(params.id, me)
  if (params.username === me) throw new HttpError(400, 'Use Leave group instead.')
  q('DELETE FROM members WHERE group_id = ? AND username = ?').run(params.id, params.username)
  touchGroup(params.id)
  notify([params.username])
  return { ok: true }
})

// Joining by code: look first, then join.
route('GET', '/join/:code', ({ me, params }) => {
  limit(`join:${me}`, 30, 600_000)
  const g = q('SELECT * FROM groups_ WHERE invite_code = ?').get(String(params.code).toUpperCase())
  if (!g) throw new HttpError(404, 'No group has that code. Check it with whoever sent it.')
  const owner = userCard(getUser(g.owner))
  const count = q('SELECT count(*) AS n FROM members WHERE group_id = ?').get(g.id).n
  return { preview: { id: g.id, name: g.name, color: g.color, owner, memberCount: count, alreadyIn: !!membership(g.id, me) } }
})

route('POST', '/join/:code', ({ me, params }) => {
  limit(`join:${me}`, 30, 600_000)
  const g = q('SELECT * FROM groups_ WHERE invite_code = ?').get(String(params.code).toUpperCase())
  if (!g) throw new HttpError(404, 'No group has that code.')
  if (!membership(g.id, me)) q('INSERT INTO members (group_id, username, role, joined_at) VALUES (?, ?, ?, ?)').run(g.id, me, 'member', now())
  q('DELETE FROM invites WHERE group_id = ? AND username = ?').run(g.id, me)
  touchGroup(g.id)
  return { group: groupView(g, me) }
})

// Invites by @username: the other person must accept.
route('POST', '/groups/:id/invites', ({ me, params, body }) => {
  requireMember(params.id, me)
  limit(`invite:${me}`, 60, 3600_000)
  const username = str(body?.username, 30).toLowerCase().replace(/^@/, '')
  const u = getUser(username)
  if (!u) throw new HttpError(404, `Nobody called @${username} has used group work yet. Ask them to open Group work once, or send them the join code.`)
  if (membership(params.id, username)) throw new HttpError(409, `@${username} is already in this group.`)
  q('INSERT INTO invites (id, group_id, username, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(group_id, username) DO NOTHING').run(randomUUID(), params.id, username, me, now())
  nextSeq()
  notify([username])
  return { ok: true, invited: userCard(u) }
})

route('GET', '/invites', ({ me }) => ({
  invites: q(
    'SELECT i.id, i.created_at, g.id AS gid, g.name, g.color, i.invited_by FROM invites i JOIN groups_ g ON g.id = i.group_id WHERE i.username = ? ORDER BY i.created_at DESC'
  )
    .all(me)
    .map((r) => ({ id: r.id, createdAt: r.created_at, group: { id: r.gid, name: r.name, color: r.color }, invitedBy: userCard(getUser(r.invited_by)) }))
}))

route('POST', '/invites/:id/:answer', ({ me, params }) => {
  const inv = q('SELECT * FROM invites WHERE id = ? AND username = ?').get(params.id, me)
  if (!inv) throw new HttpError(404, 'That invite is gone.')
  q('DELETE FROM invites WHERE id = ?').run(inv.id)
  if (params.answer === 'accept') {
    if (!membership(inv.group_id, me)) q('INSERT INTO members (group_id, username, role, joined_at) VALUES (?, ?, ?, ?)').run(inv.group_id, me, 'member', now())
    touchGroup(inv.group_id)
    return { group: groupView(q('SELECT * FROM groups_ WHERE id = ?').get(inv.group_id), me) }
  }
  nextSeq()
  notify([me])
  return { ok: true }
})

// Group items
route('GET', '/groups/:id/items', ({ me, params, url }) => {
  requireMember(params.id, me)
  const since = Number(url.searchParams.get('since') || 0)
  let rows = q('SELECT * FROM items WHERE group_id = ? AND seq > ? ORDER BY seq').all(params.id, since)
  if (!since) {
    // First load: everything except old chat, which is capped to the latest 300.
    const msgs = rows.filter((r) => r.kind === 'message')
    if (msgs.length > 300) {
      const keep = new Set(msgs.slice(-300).map((r) => r.id))
      rows = rows.filter((r) => r.kind !== 'message' || keep.has(r.id))
    }
    rows = rows.filter((r) => !r.deleted)
  }
  const g = q('SELECT seq FROM groups_ WHERE id = ?').get(params.id)
  return { items: rows.map(itemView), seq: Math.max(g?.seq ?? 0, ...rows.map((r) => r.seq)) }
})

route('POST', '/groups/:id/items', ({ me, params, body }) => {
  requireMember(params.id, me)
  limit(`write:${me}`, 300, 60_000)
  const kind = String(body?.kind || '')
  const data = cleanItem(kind, body?.data, params.id)
  const t = now()
  const id = randomUUID()
  const s = touchGroup(params.id)
  q('INSERT INTO items (id, group_id, kind, data, rev, created_by, created_at, updated_by, updated_at, deleted, seq) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?)').run(id, params.id, kind, data, me, t, me, t, s)
  return { item: itemView(q('SELECT * FROM items WHERE id = ?').get(id)) }
})

route('PUT', '/groups/:id/items/:item', ({ me, params, body }) => {
  requireMember(params.id, me)
  limit(`write:${me}`, 300, 60_000)
  const row = q('SELECT * FROM items WHERE id = ? AND group_id = ? AND deleted = 0').get(params.item, params.id)
  if (!row) throw new HttpError(404, 'That was deleted.')
  if (row.kind === 'message' && row.created_by !== me) throw new HttpError(403, 'You can only edit your own messages.')
  // Notes refuse a save made from an out-of-date copy, so nobody's edits are silently lost.
  if (row.kind === 'note' && Number(body?.rev) !== row.rev) {
    throw Object.assign(new HttpError(409, `@${row.updated_by} changed this note while you were editing.`), { extra: { current: itemView(row) } })
  }
  const data = cleanItem(row.kind, body?.data, params.id)
  const s = touchGroup(params.id)
  q('UPDATE items SET data = ?, rev = rev + 1, updated_by = ?, updated_at = ?, seq = ? WHERE id = ?').run(data, me, now(), s, row.id)
  return { item: itemView(q('SELECT * FROM items WHERE id = ?').get(row.id)) }
})

route('DELETE', '/groups/:id/items/:item', ({ me, params }) => {
  const role = requireMember(params.id, me)
  const row = q('SELECT * FROM items WHERE id = ? AND group_id = ? AND deleted = 0').get(params.item, params.id)
  if (!row) return { ok: true }
  if (row.kind === 'message' && row.created_by !== me && role !== 'owner') throw new HttpError(403, 'Only the sender or the group’s owner can delete a message.')
  const s = touchGroup(params.id)
  q('UPDATE items SET deleted = 1, data = ?, updated_by = ?, updated_at = ?, seq = ? WHERE id = ?').run('{}', me, now(), s, row.id)
  return { ok: true }
})

/* ---------- personal sync (only ever your own records) ---------- */
const SYNC_KINDS = new Set(['subject', 'task', 'note', 'session'])
const SYNC_MAX_RECORD = 1_500_000
const SYNC_MAX_ROWS = 100_000

// Your devices send what they changed. The newest edit of each record wins
// (ties go to the higher device id, so every device agrees).
route('POST', '/sync/push', ({ me, body }) => {
  limit(`sync:${me}`, 240, 60_000)
  const list = Array.isArray(body?.records) ? body.records.slice(0, 2000) : null
  if (!list) throw new HttpError(400, 'Nothing to sync.')
  const count = q('SELECT count(*) AS n FROM personal WHERE username = ?').get(me).n
  let accepted = 0
  let skipped = 0
  db.exec('BEGIN')
  try {
    for (const r of list) {
      const ok =
        r && typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) && SYNC_KINDS.has(r.kind) && r.data && typeof r.data === 'object' &&
        Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt) && (r.deletedAt === null || Number.isFinite(r.deletedAt)) &&
        typeof r.deviceId === 'string' && r.deviceId.length <= 64
      const json = ok ? JSON.stringify(r.data) : ''
      if (!ok || json.length > SYNC_MAX_RECORD) {
        skipped++
        continue
      }
      const old = q('SELECT updated_at, device_id, kind FROM personal WHERE username = ? AND id = ?').get(me, r.id)
      if (old && (old.updated_at > r.updatedAt || (old.updated_at === r.updatedAt && old.device_id >= r.deviceId))) continue
      if (old && old.kind !== r.kind) {
        skipped++
        continue
      }
      if (!old && count + accepted >= SYNC_MAX_ROWS) throw new HttpError(413, 'Your synced data is over the limit (100,000 items).')
      q(
        `INSERT INTO personal (username, id, kind, data, created_at, updated_at, deleted_at, device_id, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, device_id = excluded.device_id, seq = excluded.seq`
      ).run(me, r.id, r.kind, json, r.createdAt, r.updatedAt, r.deletedAt ?? null, r.deviceId, nextSeq())
      accepted++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (accepted) notify([me])
  return { accepted, skipped, seq }
})

// …and fetch what your other devices changed.
route('GET', '/sync/pull', ({ me, url }) => {
  limit(`sync:${me}`, 240, 60_000)
  const since = Number(url.searchParams.get('since') || 0)
  const max = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 500)))
  const rows = q('SELECT * FROM personal WHERE username = ? AND seq > ? ORDER BY seq LIMIT ?').all(me, since, max + 1)
  const more = rows.length > max
  const page = rows.slice(0, max)
  return {
    records: page.map((r) => ({ id: r.id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, deviceId: r.device_id })),
    seq: page.length ? page[page.length - 1].seq : Math.max(since, 0),
    more
  }
})

// Long-poll: answers as soon as anything in your groups or invites changes, or after ~25 s.
route('GET', '/poll', async ({ me, url, req }) => {
  const since = Number(url.searchParams.get('since') || 0)
  if (seq > since) return { seq }
  await new Promise((resolve) => {
    const w = { username: me, resolve }
    const done = () => {
      clearTimeout(timer)
      waiters.delete(w)
      resolve()
    }
    w.resolve = done
    const timer = setTimeout(done, 25_000)
    waiters.add(w)
    req.on('close', done)
  })
  return { seq }
})

/* ---------- HTTP plumbing ---------- */
const MAX_BODY = 600_000
const MAX_SYNC_BODY = 4_000_000

async function readBody(req, max = MAX_BODY) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > max) throw new HttpError(413, 'That’s too large.')
    chunks.push(c)
  }
  if (!n) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Bad request.')
  }
}

function sessionUser(req) {
  const m = (req.headers.authorization || '').match(/^Bearer ([0-9a-f]{64})$/)
  if (!m) throw new HttpError(401, 'Sign in first.')
  const s = q('SELECT username, expires_at FROM sessions WHERE hash = ?').get(sha(m[1]))
  if (!s || s.expires_at < now()) throw new HttpError(401, 'Your group session has ended. Reconnecting…')
  q('UPDATE users SET seen_at = ? WHERE username = ?').run(now(), s.username)
  return { me: s.username, token: m[1] }
}

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '')
    for (const r of routes) {
      if (r.method !== req.method) continue
      const m = url.pathname.match(r.re)
      if (!m) continue
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))
      limit(`all:${ip}`, 1200, 60_000)
      const auth = r.auth ? sessionUser(req) : {}
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req, url.pathname === '/sync/push' ? MAX_SYNC_BODY : MAX_BODY)
      const out = await r.handler({ ...auth, params, body, url, req, ip })
      return send(200, out)
    }
    send(404, { error: 'Not found.' })
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) })
    log('error', e)
    send(500, { error: 'Something went wrong on the group server.' })
  }
})
server.requestTimeout = 60_000
server.headersTimeout = 30_000
server.listen(PORT, '127.0.0.1', () => log(`Veyra group server ${VERSION} on http://127.0.0.1:${PORT} (data in ${DATA_DIR})`))

/* ---------- daily backups: compressed; the last 7 days plus one a week for 4 weeks before that ---------- */
const BACKUP_RE = /^group-(\d{4}-\d{2}-\d{2})\.db(\.gz)?$/
async function gzipFile(from, to) {
  const tmp = to + '.part'
  await pipeline(createReadStream(from), createGzip({ level: 9 }), createWriteStream(tmp))
  renameSync(tmp, to)
  rmSync(from, { force: true })
}
let backingUp = false
async function backup() {
  if (backingUp) return
  backingUp = true
  const dir = join(DATA_DIR, 'backups')
  try {
    mkdirSync(dir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const gz = join(dir, `group-${day}.db.gz`)
    if (!existsSync(gz)) {
      const raw = join(dir, `.snapshot-${day}.db`)
      rmSync(raw, { force: true })
      db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`)
      await gzipFile(raw, gz)
      log('backup saved', gz)
    }
    // Older uncompressed backups (before 1.2.4) are compressed too.
    for (const name of readdirSync(dir).filter((n) => BACKUP_RE.test(n) && n.endsWith('.db'))) {
      if (!existsSync(join(dir, name + '.gz'))) await gzipFile(join(dir, name), join(dir, name + '.gz'))
      else rmSync(join(dir, name), { force: true })
    }
    // Keep the newest 7, then the newest of each of the 4 weeks before them.
    const files = readdirSync(dir).filter((n) => BACKUP_RE.test(n)).sort().reverse()
    const keep = new Set(files.slice(0, 7))
    const weeks = new Set()
    for (const name of files.slice(7)) {
      const week = Math.floor(Date.parse(name.match(BACKUP_RE)[1]) / (7 * 86_400_000))
      if (weeks.size < 4 && !weeks.has(week)) {
        weeks.add(week)
        keep.add(name)
      }
    }
    for (const name of files) if (!keep.has(name)) rmSync(join(dir, name), { force: true })
  } catch (e) {
    log('backup failed', e.message)
  } finally {
    backingUp = false
  }
}

/* ---------- deleted group items: their empty rows go after 30 days ---------- */
// Clients load a group from scratch each time it opens, so nobody needs a delete that old.
function sweepDeleted() {
  try {
    const r = q('DELETE FROM items WHERE deleted = 1 AND updated_at < ?').run(now() - 30 * 86_400_000)
    if (r.changes) log(`cleared ${r.changes} deleted group items`)
  } catch (e) {
    log('sweep failed', e.message)
  }
}
void backup().then(sweepDeleted)
setInterval(sweepDeleted, 24 * 3600_000).unref()
setInterval(backup, 3600_000).unref()

/* ---------- the tunnel: start cloudflared, publish its address ---------- */
let tunnelUrl = ''
let tunnelChild = null
async function publish(addr) {
  if (!RELAY_URL || !RELAY_SECRET) return log('RELAY_URL or RELAY_SECRET not set: the address was not published.')
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${RELAY_URL}/server`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}` },
        body: JSON.stringify({ url: addr })
      })
      if (r.ok) return log(addr ? `published ${addr}` : 'marked offline until the tunnel is back')
      log('relay refused the address:', r.status, await r.text())
      return
    } catch (e) {
      log('could not reach the relay, retrying:', e.message)
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)))
    }
  }
}

function startTunnel(attempt = 0) {
  const child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  tunnelChild = child
  let limited = false
  const onData = (buf) => {
    const text = String(buf)
    for (const line of text.split('\n')) if (/\bERR\b|failed/i.test(line)) log('cloudflared:', line.replace(/^\S+\s+/, '').slice(0, 300))
    if (/status 429/.test(text)) limited = true
    // cloudflared's own errors mention api.trycloudflare.com: that's not a tunnel address.
    const m = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)
    if (m && m[0] !== tunnelUrl) {
      tunnelUrl = m[0]
      attempt = 0
      publish(tunnelUrl)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('error', (e) => log('could not start cloudflared:', e.message, '(install it with: pkg install cloudflared)'))
  child.on('exit', (code) => {
    // Cloudflare limits how often a quick tunnel can be requested (429), and quick retries keep
    // the limit in place, so back off hard: 10 s, 20 s, 40 s … up to 15 minutes.
    const wait = limited ? 5 * 60_000 : Math.min(15 * 60_000, 10_000 * 2 ** attempt)
    limited = false
    log(`tunnel stopped (code ${code}); restarting in ${wait / 1000}s`)
    // Tell the relay the old address is gone, so apps say "offline" instead of trying it.
    if (tunnelUrl) publish('')
    tunnelUrl = ''
    if (tunnelChild === child) tunnelChild = null
    setTimeout(() => startTunnel(attempt + 1), wait)
  })
}
if (TUNNEL) {
  publish('') // until the tunnel is up, the old address (if any) is gone
  startTunnel()
  watchTunnel()
} else log('TUNNEL=off: no public address (local testing).')

/*
 * Quick tunnels can die quietly (the phone sleeps, Wi-Fi changes) while
 * cloudflared keeps running, which leaves a dead address with the relay.
 * Check the public address every 2 minutes; after 3 misses in a row, restart
 * cloudflared so it gets (and publishes) a fresh address.
 */
function watchTunnel() {
  let misses = 0
  setInterval(async () => {
    if (!tunnelUrl || !tunnelChild) return
    try {
      const r = await fetch(`${tunnelUrl}/health`, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`status ${r.status}`)
      misses = 0
    } catch (e) {
      misses++
      log(`tunnel check failed (${misses}/3):`, e.message)
      if (misses >= 3) {
        misses = 0
        log('tunnel looks dead; restarting cloudflared for a new address')
        tunnelChild.kill()
      }
    }
  }, 120_000).unref()
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
