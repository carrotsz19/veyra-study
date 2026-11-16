/**
 * Voice rooms (one per group), like a voice channel. The sound goes straight between
 * the apps (WebRTC); the server only says who's in a room and passes the setup
 * messages (offers and answers) between them. Everything here is in memory: a
 * restart empties the rooms and the apps rejoin by themselves.
 *
 * - POST /groups/:id/voice/join      → { sid, people, version, iceServers }
 *   (joining one room leaves any other; a second device replaces the first)
 * - POST /groups/:id/voice/leave
 * - PATCH /groups/:id/voice/state    { muted, deafened }
 * - GET  /voice/rooms                → who's in voice in each of your groups
 * - POST /voice/signal               { to, sid, data } to someone in your room
 * - GET  /poll/voice?sid=            long-poll for your messages (also the heartbeat)
 *
 * Someone whose app stops asking for messages for 35 s is taken out of the room.
 * ICE servers come from VOICE_ICE (JSON array of RTCIceServer) or a public STUN server,
 * so TURN can be added later in .env without an app update.
 */
import { randomBytes } from 'node:crypto'

const MAX_PEOPLE = 8
const GONE_AFTER = 35_000
const WAIT = 25_000
const MAX_SIGNAL = 64_000
const MAX_QUEUE = 200

export function setupCalls({ route, HttpError, requireMember, membersOf, getUser, userCard, notify, limit, log }) {
  /** groupId → { people: Map<username, { sid, joinedAt, beat, muted, deafened }> } */
  const rooms = new Map()
  /** username → { sid, queue: [], wake: fn | null } (only people in a room have one) */
  const boxes = new Map()
  let version = 0

  const iceServers = (() => {
    try {
      const v = JSON.parse(process.env.VOICE_ICE || '')
      if (Array.isArray(v) && v.length) return v
    } catch {
      /* not set */
    }
    return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  })()

  const roomOf = (username) => {
    for (const [groupId, r] of rooms) if (r.people.has(username)) return groupId
    return null
  }
  const peopleView = (groupId) => {
    const r = rooms.get(groupId)
    if (!r) return []
    return [...r.people].map(([username, p]) => ({ ...userCard(getUser(username)), sid: p.sid, joinedAt: p.joinedAt, muted: p.muted, deafened: p.deafened }))
  }
  const send = (username, msg) => {
    const b = boxes.get(username)
    if (!b) return
    b.queue.push(msg)
    if (b.queue.length > MAX_QUEUE) b.queue.splice(0, b.queue.length - MAX_QUEUE)
    b.wake?.()
  }
  /** Tells the room what changed, and wakes the group's other members (their app shows who's in voice). */
  const changed = (groupId) => {
    version += 1
    const people = peopleView(groupId)
    for (const p of people) send(p.username, { type: 'room', groupId, people, version })
    try {
      notify(membersOf(groupId))
    } catch {
      /* group gone */
    }
  }
  const leave = (username, groupId = roomOf(username)) => {
    if (!groupId) return
    const r = rooms.get(groupId)
    r?.people.delete(username)
    if (r && !r.people.size) rooms.delete(groupId)
    const b = boxes.get(username)
    if (b) {
      boxes.delete(username)
      b.queue.push({ type: 'ended' })
      b.wake?.()
    }
    changed(groupId)
  }

  // Take out anyone whose app went quiet (closed, asleep, lost its connection).
  setInterval(() => {
    const t = Date.now()
    for (const [groupId, r] of rooms)
      for (const [username, p] of r.people)
        if (t - p.beat > GONE_AFTER) {
          log('voice: dropped', username, 'from', groupId)
          leave(username, groupId)
        }
  }, 5000).unref()

  /** For /poll: changes whenever anyone joins, leaves or mutes anywhere. */
  const voiceVersion = () => version

  route('GET', '/voice/rooms', ({ me }) => {
    const out = {}
    for (const groupId of rooms.keys()) {
      try {
        requireMember(groupId, me)
      } catch {
        continue
      }
      out[groupId] = peopleView(groupId)
    }
    return { rooms: out, version, mine: roomOf(me) }
  })

  route('POST', '/groups/:id/voice/join', ({ me, params }) => {
    requireMember(params.id, me)
    limit(`voice:${me}`, 30, 60_000)
    const r = rooms.get(params.id) ?? { people: new Map() }
    if (!r.people.has(me) && r.people.size >= MAX_PEOPLE) throw new HttpError(409, `This voice room is full (${MAX_PEOPLE} people).`)
    const before = roomOf(me)
    if (before && before !== params.id) leave(me, before)
    // Joining again (another device, or after a dropout) starts a fresh connection.
    const old = boxes.get(me)
    if (old) {
      old.queue.push({ type: 'ended', reason: 'elsewhere' })
      old.wake?.()
    }
    const sid = randomBytes(9).toString('base64url')
    const t = Date.now()
    const prev = r.people.get(me)
    r.people.set(me, { sid, joinedAt: prev?.joinedAt ?? t, beat: t, muted: false, deafened: false })
    rooms.set(params.id, r)
    boxes.set(me, { sid, queue: [], wake: null })
    changed(params.id)
    return { sid, people: peopleView(params.id), version, iceServers, max: MAX_PEOPLE }
  })

  route('POST', '/groups/:id/voice/leave', ({ me, params, body }) => {
    requireMember(params.id, me)
    const p = rooms.get(params.id)?.people.get(me)
    // An old device leaving doesn't end the call on the new one.
    if (p && (!body?.sid || body.sid === p.sid)) leave(me, params.id)
    return { ok: true }
  })

  route('PATCH', '/groups/:id/voice/state', ({ me, params, body }) => {
    requireMember(params.id, me)
    limit(`voice-state:${me}`, 120, 60_000)
    const p = rooms.get(params.id)?.people.get(me)
    if (!p) throw new HttpError(409, 'You’re not in this voice room.')
    if (typeof body?.muted === 'boolean') p.muted = body.muted
    if (typeof body?.deafened === 'boolean') p.deafened = body.deafened
    p.beat = Date.now()
    changed(params.id)
    return { ok: true }
  })

  route('POST', '/voice/signal', ({ me, body }) => {
    limit(`voice-signal:${me}`, 600, 60_000)
    const groupId = roomOf(me)
    const to = String(body?.to || '')
    const r = groupId && rooms.get(groupId)
    const mine = r?.people.get(me)
    const them = r?.people.get(to)
    if (!mine || mine.sid !== body?.sid) throw new HttpError(409, 'You’re not in a voice room.')
    if (!them || them.sid !== body?.toSid) throw new HttpError(410, 'They’ve left the voice room.')
    const data = body?.data
    if (!data || typeof data !== 'object' || JSON.stringify(data).length > MAX_SIGNAL) throw new HttpError(400, 'Bad request.')
    mine.beat = Date.now()
    send(to, { type: 'signal', from: me, fromSid: mine.sid, data })
    return { ok: true }
  })

  route('GET', '/poll/voice', async ({ me, url, req }) => {
    const sid = url.searchParams.get('sid') || ''
    const box = boxes.get(me)
    if (!box || box.sid !== sid) return { messages: [{ type: 'ended' }] }
    const groupId = roomOf(me)
    // Removed from the group (or it was deleted) while in its voice room.
    if (groupId)
      try {
        requireMember(groupId, me)
      } catch {
        leave(me, groupId)
        return { messages: [{ type: 'ended', reason: 'removed' }] }
      }
    const p = groupId && rooms.get(groupId)?.people.get(me)
    if (p) p.beat = Date.now()
    if (!box.queue.length) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          if (box.wake === done) box.wake = null
          resolve()
        }
        const timer = setTimeout(done, WAIT)
        box.wake?.() // only one waiting request per person
        box.wake = done
        req.on('close', done)
      })
    }
    const still = groupId && rooms.get(groupId)?.people.get(me)
    if (still && still.sid === sid) still.beat = Date.now()
    // The app gave up on this request (or sent a newer one): keep the messages for the next.
    if (req.destroyed) return { messages: [] }
    return { messages: box.queue.splice(0) }
  })

  return { voiceVersion, leaveAll: (username) => leave(username) }
}
