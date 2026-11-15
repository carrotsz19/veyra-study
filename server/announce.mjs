/**
 * Announcements from the owner (Settings → Owner → Announcements): a short message shown in the
 * app as a card until each person dismisses it. To everyone, to chosen people, or to everyone
 * with Veyra AI (approved in ai_users, as ai.mjs keeps it). Can expire.
 *
 * Reaches people who've used Group work or sync (the server only knows them).
 */
import { randomUUID } from 'node:crypto'

const AUDIENCES = ['all', 'users', 'ai']

export function setupAnnouncements({ db, q, route, HttpError, requireAdmin, isOwner, getUser, userCard }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL,
      usernames TEXT NOT NULL DEFAULT '[]', link TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS announcement_reads (id TEXT NOT NULL, username TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (id, username));
  `)
  const hasAi = (u) => isOwner(u) || !!q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_users'").get() && !!q('SELECT 1 FROM ai_users WHERE username = ?').get(u)
  const forMe = (a, me) => a.audience === 'all' || (a.audience === 'users' && JSON.parse(a.usernames).includes(me)) || (a.audience === 'ai' && hasAi(me))
  const view = (a) => ({ id: a.id, title: a.title, body: a.body, link: a.link || null, createdAt: a.created_at, from: userCard(getUser(a.created_by)) ?? { username: a.created_by, displayName: a.created_by } })

  // Yours, not yet dismissed, newest first.
  route('GET', '/announcements', ({ me }) => {
    const t = Date.now()
    const rows = q('SELECT a.* FROM announcements a WHERE (a.expires_at IS NULL OR a.expires_at > ?) AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.id = a.id AND r.username = ?) ORDER BY a.created_at DESC LIMIT 50').all(t, me)
    return { announcements: rows.filter((a) => forMe(a, me)).slice(0, 10).map(view) }
  })

  route('POST', '/announcements/:id/read', ({ me, params }) => {
    if (q('SELECT 1 FROM announcements WHERE id = ?').get(params.id)) q('INSERT OR IGNORE INTO announcement_reads (id, username, at) VALUES (?, ?, ?)').run(params.id, me, Date.now())
    return { ok: true }
  })

  /* ---------- the owner ---------- */
  route('GET', '/admin/announcements', ({ me }) => {
    requireAdmin(me)
    const rows = q('SELECT a.*, (SELECT count(*) FROM announcement_reads r WHERE r.id = a.id) AS seen FROM announcements a ORDER BY a.created_at DESC LIMIT 100').all()
    const people = q('SELECT username FROM users').all().map((r) => r.username)
    return {
      announcements: rows.map((a) => ({
        ...view(a),
        audience: a.audience,
        usernames: JSON.parse(a.usernames),
        expiresAt: a.expires_at,
        seen: a.seen,
        // How many it's for (people the server knows).
        reach: a.audience === 'all' ? people.length : a.audience === 'users' ? JSON.parse(a.usernames).length : people.filter(hasAi).length
      }))
    }
  })

  route('POST', '/admin/announcements', ({ me, body }) => {
    requireAdmin(me)
    const title = String(body?.title ?? '').trim()
    const text = String(body?.body ?? '').trim()
    const audience = AUDIENCES.includes(body?.audience) ? body.audience : null
    if (!title || title.length > 120) throw new HttpError(400, 'Give it a title (up to 120 characters).')
    if (!text || text.length > 2000) throw new HttpError(400, 'Write the message (up to 2,000 characters).')
    if (!audience) throw new HttpError(400, 'Choose who it’s for.')
    let usernames = []
    if (audience === 'users') {
      usernames = [...new Set((Array.isArray(body?.usernames) ? body.usernames : []).map((u) => String(u).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
      if (!usernames.length) throw new HttpError(400, 'Choose at least one person.')
      const unknown = usernames.filter((u) => !getUser(u))
      if (unknown.length) throw new HttpError(400, `Not found: ${unknown.map((u) => '@' + u).join(', ')}. People show up once they’ve used Group work or sync.`)
    }
    const link = String(body?.link ?? '').trim()
    if (link && (!/^https:\/\/[^\s]+$/.test(link) || link.length > 500)) throw new HttpError(400, 'The link must start with https://')
    const expiresAt = body?.expiresAt == null ? null : Number(body.expiresAt)
    if (expiresAt !== null && !(expiresAt > Date.now())) throw new HttpError(400, 'The end date has to be in the future.')
    const id = randomUUID()
    q('INSERT INTO announcements (id, title, body, audience, usernames, link, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, text, audience, JSON.stringify(usernames), link, me, Date.now(), expiresAt)
    return { id }
  })

  route('DELETE', '/admin/announcements/:id', ({ me, params }) => {
    requireAdmin(me)
    q('DELETE FROM announcement_reads WHERE id = ?').run(params.id)
    q('DELETE FROM announcements WHERE id = ?').run(params.id)
    return { ok: true }
  })
}
