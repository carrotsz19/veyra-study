/**
 * Veyra Study relay: a tiny Cloudflare Worker with two jobs.
 *
 * 1. Address book for the group server on the owner's phone. The phone's
 *    free Cloudflare quick tunnel gets a new trycloudflare.com address each
 *    time it starts; the phone publishes it here (PUT /server, needs the
 *    RELAY_SECRET), and apps read it (GET /server).
 *
 * 2. Identity. An app proves who its user is by sending their Veyra session
 *    cookie here; the relay asks the Veyra Worker (veyraHome) and returns a
 *    short-lived pass signed with SIGNING_KEY. The phone checks the pass with
 *    the same key. The Veyra session itself never reaches the phone.
 *
 * Bindings (wrangler.toml): KV namespace RELAY, service VEYRA (the veyra Worker).
 * Secrets: RELAY_SECRET, SIGNING_KEY.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
const PASS_SECONDS = 15 * 60
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
const enc = new TextEncoder()

const b64url = (bytes) => {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(key, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)))
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(body))
  return `${body}.${b64url(mac)}`
}

/** Constant-time string compare. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

/** Calls the Veyra Worker's /api, through the service binding when there is one. */
async function veyra(env, name, args, cookie) {
  const req = new Request(`https://veyra.internal/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: JSON.stringify(args)
  })
  const res = env.VEYRA ? await env.VEYRA.fetch(req) : await fetch(new Request(`${env.VEYRA_URL}/api/${name}`, req))
  const body = await res.json().catch(() => null)
  if (!body || !body.ok) throw new Error((body && body.e) || `Veyra answered ${res.status}`)
  return body.v
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // --- the group server's current address ---
    if (url.pathname === '/server') {
      if (request.method === 'GET') {
        const v = await env.RELAY.get('server', 'json')
        return v ? json(v) : json({ error: 'The group server hasn’t started yet.' }, 404)
      }
      if (request.method === 'PUT') {
        const auth = request.headers.get('Authorization') || ''
        if (!env.RELAY_SECRET || !same(auth, `Bearer ${env.RELAY_SECRET}`)) return json({ error: 'Not allowed.' }, 403)
        const body = await request.json().catch(() => null)
        const addr = body && typeof body.url === 'string' ? body.url.trim() : ''
        if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(addr)) return json({ error: 'That isn’t an https address.' }, 400)
        const value = { url: addr, updatedAt: Date.now() }
        await env.RELAY.put('server', JSON.stringify(value))
        return json(value)
      }
      return json({ error: 'Use GET or PUT.' }, 405)
    }

    // --- who is this? ---
    if (url.pathname === '/identify' && request.method === 'POST') {
      if (!env.SIGNING_KEY) return json({ error: 'The relay isn’t set up yet.' }, 503)
      const body = await request.json().catch(() => null)
      const handle = body && typeof body.handle === 'string' ? body.handle : ''
      const cookie = body && typeof body.cookie === 'string' ? body.cookie.slice(0, 4096) : ''
      if (!/^ck_[0-9a-f]{32}$/.test(handle) || !cookie) return json({ error: 'Sign in to Veyra first.' }, 400)
      let home
      try {
        home = await veyra(env, 'veyraHome', [handle], cookie)
      } catch (e) {
        return json({ error: 'Couldn’t check your Veyra account. Try again.' }, 502)
      }
      if (!home || !home.signedIn || !home.user) return json({ error: 'Your Veyra sign-in has ended. Sign in again.' }, 401)
      const u = home.user
      const now = Math.floor(Date.now() / 1000)
      const pass = await sign(env.SIGNING_KEY, {
        aud: 'veyra-group',
        u: String(u.username).toLowerCase(),
        n: String(u.displayName || u.username).slice(0, 80),
        p: typeof u.photoUrl === 'string' && /^https:\/\//.test(u.photoUrl) ? u.photoUrl.slice(0, 500) : '',
        v: !!u.emailVerified,
        iat: now,
        exp: now + PASS_SECONDS
      })
      return json({ pass, expiresIn: PASS_SECONDS })
    }

    if (url.pathname === '/') return json({ ok: true, service: 'veyra-study-relay' })
    return json({ error: 'Not found.' }, 404)
  }
}
