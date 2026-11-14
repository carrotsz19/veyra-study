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
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.7.0'
const STARTED = Date.now()
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
/** Who can open the Owner section (users, groups, moderation): Veyra usernames, comma-separated. */
const OWNERS = (process.env.OWNERS || 'carrotsz19').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean)
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
  -- People the owner has blocked from Group work and sync (the Owner section in the app).
  CREATE TABLE IF NOT EXISTS blocked (username TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
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
const isBlocked = (username) => !!q('SELECT 1 FROM blocked WHERE username = ?').get(username)
const isOwner = (username) => OWNERS.includes(String(username).toLowerCase())
function requireAdmin(username) {
  if (!isOwner(username)) throw new HttpError(403, 'Only the owner of Veyra Study can do that.')
}
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
    // Loosely per address (everyone on the website arrives from Cloudflare's), tightly per account once the pass checks out.
    limit(`session-ip:${ip}`, 300, 60_000)
    const p = verifyPass(body?.pass)
    limit(`session:${p.u}`, 20, 60_000)
    if (isBlocked(p.u)) throw new HttpError(403, 'This account can’t use Group work or sync. Contact the owner if you think that’s a mistake.')
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

route('GET', '/me', ({ me }) => ({ me: userCard(getUser(me)), owner: isOwner(me) }))

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

/* ---------- sharing a note, without a group ---------- */
/*
 * A share is a read-only copy of one of your notes, kept up to date by your app when you edit it.
 * Either a link (to_user is null: anyone with its unguessable id can read it on the website), or
 * for one person (they see it under Shared in their Notes). The owner can stop it any time;
 * the person it was sent to can remove it from their list.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, note_id TEXT NOT NULL, to_user TEXT,
    title TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner, note_id);
  CREATE INDEX IF NOT EXISTS shares_to ON shares(to_user);
`)
for (const col of ["role TEXT NOT NULL DEFAULT 'view'", 'signin INTEGER NOT NULL DEFAULT 1'])
  try {
    db.exec(`ALTER TABLE shares ADD COLUMN ${col}`)
  } catch {
    /* already there */
  }
const SHARE_MAX = 500_000
const role = (r) => (r === 'edit' ? 'edit' : 'view')
const shareView = (r) => ({ id: r.id, noteId: r.note_id, to: r.to_user ? userCard(getUser(r.to_user)) ?? { username: r.to_user, displayName: r.to_user } : null, role: role(r.role), signin: !!r.signin, docId: docFor(r.owner, r.note_id), updatedAt: r.updated_at })
function sharePayload(body) {
  const title = typeof body?.title === 'string' ? body.title.slice(0, 300) : ''
  const content = typeof body?.content === 'string' ? body.content : ''
  if (!content || content.length > SHARE_MAX) throw new HttpError(413, 'That note is too large to share.')
  return { title: title || 'Untitled', content }
}

route('GET', '/shares/mine', ({ me }) => ({ shares: q('SELECT * FROM shares WHERE owner = ? ORDER BY created_at').all(me).map(shareView) }))

route('GET', '/shares/inbox', ({ me }) => ({
  shares: q('SELECT * FROM shares WHERE to_user = ? AND dismissed = 0 ORDER BY updated_at DESC')
    .all(me)
    .map((r) => ({ id: r.id, title: r.title, from: userCard(getUser(r.owner)) ?? { username: r.owner, displayName: r.owner }, role: role(r.role), docId: docFor(r.owner, r.note_id), updatedAt: r.updated_at }))
}))

// Share a note: a link (no "to"), or with one person ("to": their username). Sharing again updates it.
route('POST', '/shares', ({ me, body }) => {
  limit(`share:${me}`, 60, 3600_000)
  const noteId = typeof body?.noteId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.noteId) ? body.noteId : null
  if (!noteId) throw new HttpError(400, 'Which note?')
  const { title, content } = sharePayload(body)
  let to = null
  if (body?.to) {
    to = String(body.to).trim().replace(/^@/, '').toLowerCase()
    if (to === me) throw new HttpError(400, 'That’s you. Pick someone else.')
    if (!getUser(to)) throw new HttpError(404, `No one called @${to} uses Veyra Study sharing yet. They need to open Group work once while signed in.`)
  }
  const t = now()
  const old = q(`SELECT * FROM shares WHERE owner = ? AND note_id = ? AND ${to ? 'to_user = ?' : 'to_user IS NULL'}`).get(...(to ? [me, noteId, to] : [me, noteId]))
  const r = role(body?.role)
  const signin = body?.signin === false ? 0 : 1
  if (old) q('UPDATE shares SET title = ?, content = ?, updated_at = ?, dismissed = 0, role = ?, signin = ? WHERE id = ?').run(title, content, t, r, signin, old.id)
  else q('INSERT INTO shares (id, owner, note_id, to_user, title, content, created_at, updated_at, role, signin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomBytes(16).toString('base64url'), me, noteId, to, title, content, t, t, r, signin)
  if (to) notify([to])
  const linked = q(
    `SELECT id FROM shares WHERE owner = ? AND note_id = ? AND ${to ? 'to_user = ?' : 'to_user IS NULL'}`
  ).get(...(to ? [me, noteId, to] : [me, noteId]))
  linkFiles(linked.id, me, content)
  const row = q(`SELECT * FROM shares WHERE owner = ? AND note_id = ? AND ${to ? 'to_user = ?' : 'to_user IS NULL'}`).get(...(to ? [me, noteId, to] : [me, noteId]))
  return { share: shareView(row) }
})

// Your app sends the note's newest text after you edit it: every share of it gets it.
route('POST', '/shares/update', ({ me, body }) => {
  limit(`share-update:${me}`, 240, 60_000)
  const noteId = typeof body?.noteId === 'string' ? body.noteId : ''
  const { title, content } = sharePayload(body)
  const rows = q('SELECT * FROM shares WHERE owner = ? AND note_id = ?').all(me, noteId)
  if (!rows.length) return { updated: 0 }
  q('UPDATE shares SET title = ?, content = ?, updated_at = ? WHERE owner = ? AND note_id = ?').run(title, content, now(), me, noteId)
  for (const r of rows) linkFiles(r.id, me, content)
  const people = rows.map((r) => r.to_user).filter(Boolean)
  if (people.length) notify(people)
  return { updated: rows.length }
})

// Read one: the owner, or the person it was sent to.
route('GET', '/shares/:id', ({ me, params }) => {
  const r = q('SELECT * FROM shares WHERE id = ?').get(params.id)
  if (!r || (r.owner !== me && r.to_user !== me && r.to_user !== null)) throw new HttpError(404, 'That shared note isn’t there any more.')
  return { title: r.title, content: r.content, from: userCard(getUser(r.owner)) ?? { username: r.owner, displayName: r.owner }, role: role(r.role), signin: !!r.signin, docId: docFor(r.owner, r.note_id), mine: r.owner === me, updatedAt: r.updated_at }
})

// The owner changes someone's role (or the link's), like Google Docs' Viewer / Editor.
route('PATCH', '/shares/:id', ({ me, params, body }) => {
  const r = q('SELECT * FROM shares WHERE id = ? AND owner = ?').get(params.id, me)
  if (!r) throw new HttpError(404, 'That share isn’t there any more.')
  q('UPDATE shares SET role = ?, signin = ? WHERE id = ?').run(body?.role ? role(body.role) : role(r.role), body?.signin === undefined ? r.signin : body.signin ? 1 : 0, r.id)
  if (r.to_user) notify([r.to_user])
  return { share: shareView(q('SELECT * FROM shares WHERE id = ?').get(r.id)) }
})

// The owner stops sharing; the person it was sent to takes it off their list.
route('DELETE', '/shares/:id', ({ me, params }) => {
  const r = q('SELECT * FROM shares WHERE id = ?').get(params.id)
  if (!r) return { ok: true }
  if (r.owner === me) {
    q('DELETE FROM shares WHERE id = ?').run(r.id)
    q('DELETE FROM share_files WHERE share_id = ?').run(r.id)
    if (r.to_user) notify([r.to_user])
  } else if (r.to_user === me) q('UPDATE shares SET dismissed = 1 WHERE id = ?').run(r.id)
  else throw new HttpError(404, 'That shared note isn’t there any more.')
  return { ok: true }
})

// A link: anyone with it can read it (no account needed). Only links, never notes sent to a person.
route(
  'GET',
  '/shares/public/:id',
  ({ params, ip }) => {
    limit(`share-public:${ip}`, 300, 60_000)
    const r = q('SELECT * FROM shares WHERE id = ? AND to_user IS NULL').get(params.id)
    if (!r) throw new HttpError(404, 'This link doesn’t work any more. The person who shared it may have stopped sharing.')
    const u = getUser(r.owner)
    return { title: r.title, content: r.content, from: u ? u.display_name || u.username : r.owner, role: role(r.role), signin: !!r.signin, docId: docFor(r.owner, r.note_id), updatedAt: r.updated_at }
  },
  false
)

/* ---------- editing a shared note together (Yjs updates, relayed) ---------- */
/*
 * Each shared note has one document. The apps edit it with Yjs and send each change as a
 * small update; this server only stores them in order and hands them on (it never reads
 * them). New updates wake anyone waiting (long poll). An app sends a snapshot now and then,
 * and older updates are dropped. Who may read or write is worked out from the note's shares.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, note_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner, note_id));
  CREATE TABLE IF NOT EXISTS doc_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc_id, seq);
  CREATE TABLE IF NOT EXISTS doc_snapshots (doc_id TEXT PRIMARY KEY, data TEXT NOT NULL, upto INTEGER NOT NULL);
`)
function docFor(owner, noteId) {
  const d = q('SELECT id FROM docs WHERE owner = ? AND note_id = ?').get(owner, noteId)
  if (d) return d.id
  const id = 'dc_' + randomBytes(16).toString('base64url')
  q('INSERT INTO docs (id, owner, note_id, created_at) VALUES (?, ?, ?, ?)').run(id, owner, noteId, now())
  return id
}
/** What someone may do with a document: 'edit', 'view' or nothing (null). */
function docAccess(docId, me, shareId) {
  const d = q('SELECT * FROM docs WHERE id = ?').get(docId)
  if (!d) return null
  if (me && me === d.owner) return 'edit'
  let best = null
  if (me) for (const r of q('SELECT role FROM shares WHERE owner = ? AND note_id = ? AND to_user = ?').all(d.owner, d.note_id, me)) best = best === 'edit' ? 'edit' : role(r.role)
  if (shareId) {
    const r = q('SELECT role, signin FROM shares WHERE id = ? AND owner = ? AND note_id = ? AND to_user IS NULL').get(shareId, d.owner, d.note_id)
    // A link that lets people edit may ask them to sign in first: without that, they can only read.
    if (r) best = best === 'edit' ? 'edit' : role(r.role) === 'edit' && (!r.signin || me) ? 'edit' : 'view'
  }
  return best
}
const signedIn = (req) => {
  try {
    return sessionUser(req).me
  } catch {
    return null
  }
}
const docWaiters = new Map()
const wakeDoc = (id) => {
  for (const w of docWaiters.get(id) ?? []) w()
  docWaiters.delete(id)
}
function docSince(id, since) {
  const snap = q('SELECT data, upto FROM doc_snapshots WHERE doc_id = ?').get(id)
  const from = snap && since < snap.upto ? snap.upto : since
  const updates = q('SELECT seq, data FROM doc_updates WHERE doc_id = ? AND seq > ? ORDER BY seq LIMIT 500').all(id, from)
  const last = q('SELECT MAX(seq) AS s FROM doc_updates WHERE doc_id = ?').get(id).s ?? snap?.upto ?? 0
  return { snapshot: snap && since < snap.upto ? snap.data : null, updates: updates.map((u) => u.data), seq: updates.length ? updates[updates.length - 1].seq : Math.max(since, snap?.upto ?? 0, from), last }
}

// Changes since a point (waits up to 15 s when there are none, so it's live without polling hard).
route(
  'GET',
  '/docs/:id',
  async ({ params, url, req, ip }) => {
    limit(`doc-read:${ip}`, 900, 60_000)
    const me = signedIn(req)
    const can = docAccess(params.id, me, url.searchParams.get('share') || '')
    if (!can) throw new HttpError(404, 'That shared note isn’t there any more.')
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
    let out = docSince(params.id, since)
    if (!out.snapshot && !out.updates.length && url.searchParams.get('wait') === '1') {
      await new Promise((resolve) => {
        const list = docWaiters.get(params.id) ?? new Set()
        const done = () => (clearTimeout(t), list.delete(done), resolve())
        const t = setTimeout(done, 15_000)
        list.add(done)
        docWaiters.set(params.id, list)
      })
      out = docSince(params.id, since)
    }
    return { ...out, can }
  },
  false
)

// One change (a Yjs update, base64), from someone who may edit.
route(
  'POST',
  '/docs/:id',
  ({ params, url, req, body, ip }) => {
    const me = signedIn(req)
    limit(`doc-write:${me || ip}`, 1200, 60_000)
    if (docAccess(params.id, me, url.searchParams.get('share') || '') !== 'edit') throw new HttpError(403, 'You can only read this note.')
    const list = Array.isArray(body?.updates) ? body.updates : [body?.update]
    let seq = 0
    for (const u of list) {
      if (typeof u !== 'string' || !u || u.length > 1_000_000) continue
      seq = Number(q('INSERT INTO doc_updates (doc_id, data, at) VALUES (?, ?, ?)').run(params.id, u, now()).lastInsertRowid)
    }
    if (seq) wakeDoc(params.id)
    return { seq }
  },
  false
)

// A snapshot of the whole document up to a point; older changes are dropped.
route(
  'POST',
  '/docs/:id/snapshot',
  ({ params, url, req, body }) => {
    const me = signedIn(req)
    if (docAccess(params.id, me, url.searchParams.get('share') || '') !== 'edit') throw new HttpError(403, 'You can only read this note.')
    const upto = Number(body?.upto)
    if (typeof body?.data !== 'string' || !body.data || body.data.length > 6_000_000 || !Number.isFinite(upto)) throw new HttpError(400, 'Bad snapshot.')
    q('INSERT INTO doc_snapshots (doc_id, data, upto) VALUES (?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET data = excluded.data, upto = excluded.upto WHERE excluded.upto > doc_snapshots.upto').run(params.id, body.data, upto)
    q('DELETE FROM doc_updates WHERE doc_id = ? AND seq <= ?').run(params.id, upto)
    return { ok: true }
  },
  false
)

// The note's text as plain JSON (for people reading it, and anyone on an older app), from an editor.
route(
  'POST',
  '/docs/:id/text',
  ({ params, url, req, body }) => {
    const me = signedIn(req)
    if (docAccess(params.id, me, url.searchParams.get('share') || '') !== 'edit') throw new HttpError(403, 'You can only read this note.')
    const d = q('SELECT * FROM docs WHERE id = ?').get(params.id)
    const content = typeof body?.content === 'string' ? body.content : ''
    if (!content || content.length > SHARE_MAX) throw new HttpError(413, 'That note is too large to share.')
    const rows = q('SELECT * FROM shares WHERE owner = ? AND note_id = ?').all(d.owner, d.note_id)
    q('UPDATE shares SET content = ?, updated_at = ? WHERE owner = ? AND note_id = ?').run(content, now(), d.owner, d.note_id)
    for (const r of rows) linkFiles(r.id, d.owner, content)
    return { ok: true }
  },
  false
)

/* ---------- pictures and files in shared notes ---------- */
/*
 * When you share a note, your app uploads its pictures, attachments and picture cover here
 * (once each), and the shared copy points at them by id ("sf_..."). A file can be read by
 * its owner, by someone a note with it was shared with, or by anyone holding that note's link.
 * Files no shared note mentions any more are deleted after a day.
 */
const FILE_DIR = join(DATA_DIR, 'files')
mkdirSync(FILE_DIR, { recursive: true })
const FILE_MAX = 15 * 1024 * 1024
const FILE_TOTAL = 300 * 1024 * 1024
const MAX_FILE_BODY = Math.ceil((FILE_MAX * 4) / 3) + 8192
const FILE_ID = /^sf_[A-Za-z0-9_-]{22}$/
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, sha TEXT NOT NULL, name TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_owner ON files(owner, sha);
  CREATE TABLE IF NOT EXISTS share_files (share_id TEXT NOT NULL, file_id TEXT NOT NULL, PRIMARY KEY (share_id, file_id));
`)
function linkFiles(shareId, owner, content) {
  const ids = [...new Set(String(content).match(/sf_[A-Za-z0-9_-]{22}/g) ?? [])]
  q('DELETE FROM share_files WHERE share_id = ?').run(shareId)
  for (const id of ids)
    if (q('SELECT 1 FROM files WHERE id = ?').get(id)) q('INSERT OR IGNORE INTO share_files (share_id, file_id) VALUES (?, ?)').run(shareId, id)
}

// Already uploaded? (by the file's SHA-256), so edits don't upload the same pictures again.
route('POST', '/files/have', ({ me, body }) => {
  const sha = typeof body?.sha === 'string' && /^[0-9a-f]{64}$/.test(body.sha) ? body.sha : ''
  return { id: (sha && q('SELECT id FROM files WHERE owner = ? AND sha = ?').get(me, sha)?.id) || null }
})

route('POST', '/files', ({ me, body }) => {
  limit(`file:${me}`, 200, 3600_000)
  const data = typeof body?.data === 'string' ? Buffer.from(body.data, 'base64') : null
  if (!data?.length) throw new HttpError(400, 'Nothing to upload.')
  if (data.length > FILE_MAX) throw new HttpError(413, 'That file is over 15 MB, too big to share.')
  const hash = createHash('sha256').update(data).digest('hex')
  const old = q('SELECT id FROM files WHERE owner = ? AND sha = ?').get(me, hash)
  if (old) return { id: old.id }
  const used = q('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner = ?').get(me).n
  if (used + data.length > FILE_TOTAL) throw new HttpError(413, 'Your shared pictures and files are over 300 MB. Stop sharing some notes with big files first.')
  const id = 'sf_' + randomBytes(16).toString('base64url')
  writeFileSync(join(FILE_DIR, id), data)
  const name = String(body.name || 'File').replace(/[\u0000-\u001f]/g, '').slice(0, 160) || 'File'
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(body.mime || '')) ? String(body.mime) : 'application/octet-stream'
  q('INSERT INTO files (id, owner, sha, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, me, hash, name, mime, data.length, now())
  return { id }
})

route(
  'GET',
  '/files/:id',
  ({ params, url, req, ip }) => {
    limit(`file-read:${ip}`, 600, 60_000)
    const f = FILE_ID.test(params.id) ? q('SELECT * FROM files WHERE id = ?').get(params.id) : null
    if (!f) throw new HttpError(404, 'That file isn’t there any more.')
    let me = null
    try {
      me = sessionUser(req).me
    } catch {
      /* not signed in: only a link can open it */
    }
    const share = url.searchParams.get('share') || ''
    const allowed =
      (me && me === f.owner) ||
      q(
        `SELECT 1 FROM share_files sf JOIN shares s ON s.id = sf.share_id WHERE sf.file_id = ? AND (${me ? 's.to_user = ? OR ' : ''}(s.id = ? AND s.to_user IS NULL))`
      ).get(...(me ? [f.id, me, share] : [f.id, share]))
    if (!allowed) throw new HttpError(404, 'That file isn’t shared with you.')
    return { name: f.name, mime: f.mime, data: readFileSync(join(FILE_DIR, f.id)).toString('base64') }
  },
  false
)

function clearUnsharedFiles() {
  const old = q('SELECT id FROM files WHERE created_at < ? AND id NOT IN (SELECT file_id FROM share_files)').all(now() - 86400_000)
  for (const { id } of old) {
    rmSync(join(FILE_DIR, id), { force: true })
    q('DELETE FROM files WHERE id = ?').run(id)
  }
  if (old.length) log(`deleted ${old.length} files no shared note uses`)
}
setInterval(clearUnsharedFiles, 6 * 3600_000).unref()

/* ---------- the owner's view: users, groups and moderation (Settings → Owner in the app) ---------- */
// /me also says whether you're an owner, so the app knows to show the Owner section.
route('GET', '/admin/overview', ({ me }) => {
  requireAdmin(me)
  const week = now() - 7 * 86400_000
  const kinds = Object.fromEntries(q('SELECT kind, count(*) AS n FROM items WHERE deleted = 0 GROUP BY kind').all().map((r) => [r.kind, r.n]))
  const personal = q('SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes FROM personal WHERE deleted_at IS NULL').get()
  let dbBytes = 0
  try {
    dbBytes = statSync(join(DATA_DIR, 'group.db')).size
  } catch {}
  return {
    version: VERSION,
    startedAt: STARTED,
    users: q('SELECT count(*) AS n FROM users').get().n,
    activeWeek: q('SELECT count(*) AS n FROM users WHERE seen_at > ?').get(week).n,
    newWeek: q('SELECT count(*) AS n FROM users WHERE created_at > ?').get(week).n,
    blocked: q('SELECT count(*) AS n FROM blocked').get().n,
    groups: q('SELECT count(*) AS n FROM groups_').get().n,
    items: { tasks: kinds.task ?? 0, messages: kinds.message ?? 0, notes: kinds.note ?? 0, deadlines: kinds.event ?? 0 },
    synced: { records: personal.n, bytes: personal.bytes },
    dbBytes
  }
})

route('GET', '/admin/users', ({ me }) => {
  requireAdmin(me)
  const rows = q(`
    SELECT u.*,
      (SELECT count(*) FROM members m WHERE m.username = u.username) AS groups,
      (SELECT count(*) FROM personal p WHERE p.username = u.username AND p.deleted_at IS NULL) AS records,
      (SELECT coalesce(sum(length(p.data)), 0) FROM personal p WHERE p.username = u.username AND p.deleted_at IS NULL) AS bytes,
      (SELECT count(DISTINCT p.device_id) FROM personal p WHERE p.username = u.username) AS devices,
      b.at AS blocked_at, b.reason AS blocked_reason
    FROM users u LEFT JOIN blocked b ON b.username = u.username
    ORDER BY u.seen_at DESC`).all()
  return {
    users: rows.map((u) => ({
      ...userCard(u),
      createdAt: u.created_at,
      seenAt: u.seen_at,
      groups: u.groups,
      records: u.records,
      bytes: u.bytes,
      devices: u.devices,
      owner: isOwner(u.username),
      blocked: u.blocked_at ? { at: u.blocked_at, reason: u.blocked_reason } : null
    }))
  }
})

route('GET', '/admin/groups', ({ me }) => {
  requireAdmin(me)
  const rows = q(`
    SELECT g.*,
      (SELECT count(*) FROM members m WHERE m.group_id = g.id) AS members,
      (SELECT count(*) FROM items i WHERE i.group_id = g.id AND i.deleted = 0 AND i.kind = 'task') AS tasks,
      (SELECT count(*) FROM items i WHERE i.group_id = g.id AND i.deleted = 0 AND i.kind = 'message') AS messages,
      (SELECT count(*) FROM items i WHERE i.group_id = g.id AND i.deleted = 0 AND i.kind = 'note') AS notes,
      (SELECT count(*) FROM items i WHERE i.group_id = g.id AND i.deleted = 0 AND i.kind = 'event') AS deadlines,
      (SELECT max(updated_at) FROM items i WHERE i.group_id = g.id) AS last_active
    FROM groups_ g ORDER BY coalesce(last_active, g.created_at) DESC`).all()
  return {
    groups: rows.map((g) => ({
      id: g.id, name: g.name, color: g.color, owner: g.owner, createdAt: g.created_at, members: g.members,
      tasks: g.tasks, messages: g.messages, notes: g.notes, deadlines: g.deadlines, lastActive: g.last_active ?? g.created_at
    }))
  }
})

/** One line to show for an item in the Owner view. */
function itemSummary(r) {
  let d = {}
  try {
    d = JSON.parse(r.data)
  } catch {}
  if (r.kind === 'message') return d.text ?? ''
  if (r.kind === 'note') return d.title || 'Untitled note'
  if (r.kind === 'event') return `${d.title ?? ''} (${d.date ?? ''}${d.time ? ' ' + d.time : ''})`
  return d.title ?? ''
}
route('GET', '/admin/groups/:id', ({ me, params }) => {
  requireAdmin(me)
  const g = q('SELECT * FROM groups_ WHERE id = ?').get(params.id)
  if (!g) throw new HttpError(404, 'That group no longer exists.')
  const members = q('SELECT m.*, u.display_name, u.photo_url, u.verified FROM members m LEFT JOIN users u ON u.username = m.username WHERE m.group_id = ? ORDER BY m.joined_at').all(params.id)
  // Everything but chat, plus the latest 300 messages.
  const items = [
    ...q("SELECT * FROM items WHERE group_id = ? AND deleted = 0 AND kind != 'message' ORDER BY updated_at DESC").all(params.id),
    ...q("SELECT * FROM items WHERE group_id = ? AND deleted = 0 AND kind = 'message' ORDER BY created_at DESC LIMIT 300").all(params.id)
  ]
  return {
    group: { id: g.id, name: g.name, color: g.color, owner: g.owner, createdAt: g.created_at },
    members: members.map((m) => ({ username: m.username, displayName: m.display_name ?? m.username, photoUrl: m.photo_url ?? '', role: m.role, joinedAt: m.joined_at })),
    items: items.map((r) => ({ id: r.id, kind: r.kind, text: itemSummary(r), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at }))
  }
})

route('DELETE', '/admin/groups/:id/items/:item', ({ me, params }) => {
  requireAdmin(me)
  const row = q('SELECT * FROM items WHERE id = ? AND group_id = ? AND deleted = 0').get(params.item, params.id)
  if (!row) return { ok: true }
  const s = touchGroup(params.id)
  q('UPDATE items SET deleted = 1, data = ?, updated_by = ?, updated_at = ?, seq = ? WHERE id = ?').run('{}', me, now(), s, row.id)
  log(`owner ${me} deleted a ${row.kind} by ${row.created_by} in group ${params.id}`)
  return { ok: true }
})

route('DELETE', '/admin/groups/:id/members/:username', ({ me, params }) => {
  requireAdmin(me)
  const g = q('SELECT * FROM groups_ WHERE id = ?').get(params.id)
  if (!g) return { ok: true }
  if (g.owner === params.username) {
    // Removing the group's owner: the longest-standing member takes over, or the group goes.
    const next = q('SELECT username FROM members WHERE group_id = ? AND username != ? ORDER BY joined_at LIMIT 1').get(params.id, params.username)
    if (!next) {
      q('DELETE FROM groups_ WHERE id = ?').run(params.id)
      nextSeq()
      notify([params.username])
      log(`owner ${me} removed ${params.username} and so deleted group ${params.id}`)
      return { ok: true, deleted: true }
    }
    q('UPDATE members SET role = ? WHERE group_id = ? AND username = ?').run('owner', params.id, next.username)
    q('UPDATE groups_ SET owner = ? WHERE id = ?').run(next.username, params.id)
  }
  q('DELETE FROM members WHERE group_id = ? AND username = ?').run(params.id, params.username)
  touchGroup(params.id)
  notify([params.username])
  log(`owner ${me} removed ${params.username} from group ${params.id}`)
  return { ok: true }
})

route('DELETE', '/admin/groups/:id', ({ me, params }) => {
  requireAdmin(me)
  const who = membersOf(params.id)
  q('DELETE FROM groups_ WHERE id = ?').run(params.id)
  nextSeq()
  notify(who)
  log(`owner ${me} deleted group ${params.id}`)
  return { ok: true }
})

route('POST', '/admin/users/:username/block', ({ me, params, body }) => {
  requireAdmin(me)
  const u = String(params.username).toLowerCase()
  if (isOwner(u)) throw new HttpError(400, 'You can’t block an owner.')
  if (!getUser(u)) throw new HttpError(404, 'No one by that name has used Group work or sync.')
  q('INSERT INTO blocked (username, at, by, reason) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET at = excluded.at, by = excluded.by, reason = excluded.reason').run(u, now(), me, str(body?.reason, 300))
  // Signed out of Group work and sync on every device straight away.
  q('DELETE FROM sessions WHERE username = ?').run(u)
  notify([u])
  log(`owner ${me} blocked ${u}`)
  return { ok: true }
})

route('DELETE', '/admin/users/:username/block', ({ me, params }) => {
  requireAdmin(me)
  q('DELETE FROM blocked WHERE username = ?').run(String(params.username).toLowerCase())
  log(`owner ${me} unblocked ${params.username}`)
  return { ok: true }
})

/* ---------- personal sync (only ever your own records) ---------- */
const SYNC_KINDS = new Set(['subject', 'task', 'note', 'session', 'folder', 'noteVersion'])
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
  if (isBlocked(s.username)) throw new HttpError(403, 'This account can’t use Group work or sync. Contact the owner if you think that’s a mistake.')
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
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req, url.pathname === '/sync/push' ? MAX_SYNC_BODY : url.pathname === '/files' || url.pathname.endsWith('/snapshot') ? MAX_FILE_BODY : MAX_BODY)
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

/*
 * Note history thins itself out (the app deletes old versions), and each delete stays here as a
 * marker so other devices hear about it. Markers for versions are cleared after 60 days, so they
 * don't build up toward the 100,000-item limit. (A device away longer than that just keeps an old
 * version until its own tidy-up removes it.)
 */
function clearOldVersionMarkers() {
  const r = q("DELETE FROM personal WHERE kind = 'noteVersion' AND deleted_at IS NOT NULL AND deleted_at < ?").run(Date.now() - 60 * 86400_000)
  if (r.changes) log(`cleared ${r.changes} old note-history markers`)
}
clearOldVersionMarkers()
setInterval(clearOldVersionMarkers, 6 * 3600_000).unref()

/* ---------- the tunnel: start cloudflared, publish its address ---------- */
let tunnelUrl = ''
let tunnelChild = null
let publishSeq = 0
async function publish(addr) {
  if (!RELAY_URL || !RELAY_SECRET) return log('RELAY_URL or RELAY_SECRET not set: the address was not published.')
  const seq = ++publishSeq
  // Keep trying until the relay has it (the network may be down for a while), unless a newer address came along.
  for (let i = 0; seq === publishSeq; i++) {
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
      if (i < 3 || i % 30 === 0) log('could not reach the relay, retrying:', e.message)
      await new Promise((r) => setTimeout(r, Math.min(60_000, 5000 * (i + 1))))
    }
  }
}

let tunnelAttempt = 0
let restartTimer = null
function scheduleTunnel(wait) {
  if (restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    startTunnel(tunnelAttempt + 1)
  }, wait)
}
function startTunnel(attempt = 0) {
  tunnelAttempt = attempt
  let child
  try {
    child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    log('could not start cloudflared:', e.message)
    return scheduleTunnel(Math.min(15 * 60_000, 10_000 * 2 ** attempt))
  }
  tunnelChild = child
  let limited = false
  // The phone itself is offline (no DNS, no route): Cloudflare never saw the request.
  let offline = false
  const onData = (buf) => {
    const text = String(buf)
    for (const line of text.split('\n')) if (/\bERR\b|failed/i.test(line)) log('cloudflared:', line.replace(/^\S+\s+/, '').slice(0, 300))
    if (/status 429/.test(text)) limited = true
    if (/no such host|network is unreachable|connection refused/i.test(text)) offline = true
    // cloudflared's own errors mention api.trycloudflare.com: that's not a tunnel address.
    const m = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)
    if (m && m[0] !== tunnelUrl) {
      tunnelUrl = m[0]
      attempt = 0
      tunnelAttempt = 0
      publish(tunnelUrl)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  let ended = false
  child.on('error', (e) => {
    log('cloudflared error:', e.message, '(if it is missing: pkg install cloudflared)')
    // A failed start never sends 'exit': clean up and try again here.
    if (child.pid === undefined) end(null)
  })
  child.on('exit', (code) => end(code))
  function end(code) {
    if (ended) return
    ended = true
    // Cloudflare limits how often a quick tunnel can be requested (429), and quick retries keep
    // the limit in place, so back off hard: 10 s, 20 s, 40 s … up to 15 minutes.
    // While the phone is offline, try every 30 s, so it's back soon after the internet is.
    const wait = limited ? 5 * 60_000 : offline && !tunnelUrl ? 30_000 : Math.min(15 * 60_000, 10_000 * 2 ** attempt)
    if (offline && !limited && !tunnelUrl) tunnelAttempt = Math.min(tunnelAttempt, 2)
    limited = false
    offline = false
    log(`tunnel stopped (code ${code}); restarting in ${wait / 1000}s`)
    // Tell the relay the old address is gone, so apps say "offline" instead of trying it.
    if (tunnelUrl) publish('')
    tunnelUrl = ''
    if (tunnelChild === child) tunnelChild = null
    scheduleTunnel(wait)
  }
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
    if (!tunnelChild && !restartTimer) {
      log('no tunnel running and none on the way; starting one')
      return startTunnel(tunnelAttempt + 1)
    }
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
