/**
 * The Veyra Study website's Worker. It serves the site's files and, under /api,
 * passes requests on for the parts a browser can't do by itself:
 *
 *  /api/account/<name>  Sign-in. The Veyra account service only answers the apps
 *                       (it refuses other websites), and a web page can't read the
 *                       session cookie it sets. So this Worker makes the call from
 *                       Cloudflare's side and keeps the cookies for the browser, in
 *                       an encrypted token only this Worker can open (WEB_SESSION_KEY).
 *                       Passwords arrive already hashed (PBKDF2 in the page) and are
 *                       never stored or logged here.
 *  /api/relay/...       The group relay: its address book, and "who is this?" with the
 *                       real cookies put back in.
 *  /api/group/...       The group server on the owner's phone (its tunnel address changes;
 *                       this looks it up through the relay).
 *
 * Everything stays on the site's own address, so the browser needs no cross-site
 * cookies or CORS. Workers on the same account reach each other through service
 * bindings (VEYRA, RELAY): a Worker can't fetch another one's workers.dev address.
 */

const ACCOUNT_CALLS = new Set(['getLoginSalt', 'veyraLogIn', 'veyraSignUp', 'launcherWhoAmI', 'logOut'])
const ACCOUNT_URL = 'https://veyra.igreenrobotz.workers.dev'
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } })
const enc = new TextEncoder()
const dec = new TextDecoder()

/* ---------- the encrypted cookie jar ---------- */
const b64url = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
let keyCache = null
async function key(env) {
  if (!env.WEB_SESSION_KEY) throw new Error('not set up')
  keyCache ??= crypto.subtle.importKey('raw', unb64url(env.WEB_SESSION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return keyCache
}
async function seal(env, jar) {
  if (!Object.keys(jar).length) return ''
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(JSON.stringify(jar))))
  const out = new Uint8Array(iv.length + data.length)
  out.set(iv)
  out.set(data, iv.length)
  return b64url(out)
}
/** The cookies inside a token ({} if there's none, or it isn't ours). */
async function open(env, token) {
  if (!token || typeof token !== 'string' || token.length > 8192) return {}
  try {
    const raw = unb64url(token)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await key(env), raw.slice(12))
    const jar = JSON.parse(dec.decode(plain))
    return jar && typeof jar === 'object' ? jar : {}
  } catch {
    return {}
  }
}
const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
/** The browser's credential "cookie" is "__web=<token>" (src/mobile/account.ts). */
const tokenFrom = (cookie) => /(?:^|;\s*)__web=([^;]+)/.exec(String(cookie || ''))?.[1] ?? ''

function applySetCookies(jar, list) {
  const out = { ...jar }
  for (const c of list) {
    const [pair, ...attrs] = c.split(';')
    const i = pair.indexOf('=')
    if (i < 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=thu, 01 jan 1970/i.test(a))) delete out[name]
    else out[name] = value
  }
  return out
}

/* ---------- requests from other sites are refused ---------- */
function foreign(request, url) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) return true
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin' && site !== 'none') return true
  // POSTs from a page always carry Origin: require it.
  return request.method === 'POST' && !origin
}

/* ---------- /api/account/<name> ---------- */
async function account(request, env, name) {
  if (request.method !== 'POST') return json({ ok: false, e: 'Use POST.' }, 405)
  if (!ACCOUNT_CALLS.has(name)) return json({ ok: false, e: 'Unknown request.' }, 404)
  const body = await request.json().catch(() => null)
  if (!body || !Array.isArray(body.args)) return json({ ok: false, e: 'Bad request.' }, 400)
  let jar
  try {
    jar = await open(env, body.jar)
  } catch {
    return json({ ok: false, e: 'Signing in on the website isn’t set up yet.' }, 503)
  }
  // A fresh request: only what the account service needs (never the browser's Origin).
  const upstream = new Request(`${ACCOUNT_URL}/api/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': (request.headers.get('User-Agent') || 'Veyra Study website').slice(0, 512),
      ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {})
    },
    body: JSON.stringify(body.args)
  })
  let res
  try {
    res = env.VEYRA ? await env.VEYRA.fetch(upstream) : await fetch(upstream)
  } catch {
    return json({ ok: false, e: 'Can’t reach Veyra. Try again.' }, 502)
  }
  const j = await res.json().catch(() => null)
  if (!j) return json({ ok: false, e: `Veyra answered ${res.status}. Try again.` }, 502)
  const next = applySetCookies(jar, res.headers.getSetCookie ? res.headers.getSetCookie() : [])
  return json({ ok: !!j.ok, v: j.v, e: j.e, jar: await seal(env, next) })
}

/* ---------- /api/relay/... ---------- */
async function relay(request, env, url, rest) {
  const call = (path, init) => {
    const req = new Request(`https://veyra-study-relay.igreenrobotz.workers.dev${path}`, init)
    return env.RELAY ? env.RELAY.fetch(req) : fetch(req)
  }
  if (rest === '/server' && request.method === 'GET') {
    const res = await call('/server', { method: 'GET' }).catch(() => null)
    if (!res) return json({ error: 'Can’t reach the group relay.' }, 502)
    const j = await res.json().catch(() => ({}))
    // Online: the browser talks to the server through this site.
    if (res.ok && j.url) return json({ url: `${url.origin}/api/group`, updatedAt: j.updatedAt })
    return json(j, res.status)
  }
  if (rest === '/identify' && request.method === 'POST') {
    const body = await request.json().catch(() => null)
    const jar = await open(env, tokenFrom(body?.cookie)).catch(() => ({}))
    if (!body || typeof body.handle !== 'string' || !Object.keys(jar).length) return json({ error: 'Your Veyra sign-in has ended. Sign in again.' }, 401)
    const res = await call('/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: body.handle, cookie: cookieHeader(jar) })
    }).catch(() => null)
    if (!res) return json({ error: 'Can’t reach the group relay.' }, 502)
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } })
  }
  return json({ error: 'Not found.' }, 404)
}

/* ---------- /api/group/... ---------- */
let tunnel = { url: '', at: 0 }
async function tunnelUrl(env, fresh) {
  if (!fresh && tunnel.url && Date.now() - tunnel.at < 60_000) return tunnel.url
  const req = new Request('https://veyra-study-relay.igreenrobotz.workers.dev/server')
  const res = await (env.RELAY ? env.RELAY.fetch(req) : fetch(req)).catch(() => null)
  const j = res ? await res.json().catch(() => ({})) : {}
  tunnel = { url: res?.ok && typeof j.url === 'string' ? j.url : '', at: Date.now() }
  return tunnel.url
}
async function group(request, env, url, rest) {
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' }
  const auth = request.headers.get('Authorization')
  if (auth) headers.Authorization = auth
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await tunnelUrl(env, attempt > 0)
    if (!base) return json({ error: 'The group server is offline right now. It reconnects by itself; try again in a few minutes.' }, 503)
    let res
    try {
      res = await fetch(base + rest + url.search, { method: request.method, headers, body })
    } catch {
      continue
    }
    // A tunnel address that stopped working: look it up again, once.
    if (res.status >= 520 && attempt === 0) continue
    const out = new Headers({ 'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8', ...NO_STORE })
    return new Response(res.body, { status: res.status, headers: out })
  }
  return json({ error: 'The group server isn’t answering right now. It reconnects by itself; try again in a few minutes.' }, 502)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (foreign(request, url)) return json({ ok: false, error: 'Not allowed.', e: 'Not allowed.' }, 403)
    const [, , area, ...more] = url.pathname.split('/')
    const rest = '/' + more.join('/')
    try {
      if (area === 'account' && more.length === 1) return await account(request, env, more[0])
      if (area === 'relay') return await relay(request, env, url, rest)
      if (area === 'group') return await group(request, env, url, rest)
    } catch {
      return json({ ok: false, error: 'Something went wrong on the website’s server.', e: 'Something went wrong. Try again.' }, 500)
    }
    return json({ error: 'Not found.' }, 404)
  }
}
