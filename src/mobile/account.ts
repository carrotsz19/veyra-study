/**
 * Veyra account sign-in on Android, the same flow as the desktop (main/account.ts):
 * PBKDF2 password hashing (here with the phone's WebCrypto), the Worker's
 * veyraLogIn / launcherWhoAmI / logOut, and one database per account.
 *
 * Requests go through Android's networking (CapacitorHttp), not the web view:
 * the Worker refuses browser-origin requests. Like the desktop, the app keeps
 * the session cookie itself (a web page can't read Set-Cookie), together with
 * the "ck_" handle, in Keystore-backed secure storage, and sends it back on
 * each request and to the group relay.
 */
import { CapacitorCookies, CapacitorHttp } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { AccountState, AccountUser } from '@shared/types'
import * as idb from './idb'
import { ON_WEB } from '@shared/channel'


export const SERVER = 'https://veyra.igreenrobotz.workers.dev'
const SESSION = 'veyra.session'
const GUEST = 'veyra.mode'

interface Session {
  handle: string
  /** The Worker's session cookies (name → value). */
  cookies: Record<string, string>
  user: AccountUser
  folder: string
  /** Veyra said "not signed in": how many times in a row, and when first (see refresh). */
  misses?: number
  firstMissAt?: number
  /** Confirmed ended by Veyra: still this account here, but nothing goes to the server until you sign in again. */
  ended?: boolean
}
let session: Session | null = null
/** How sure to be before believing Veyra ended a sign-in (it says "not signed in" for passing trouble too). */
const MISSES_TO_END = 3
const MISS_SPAN_MS = 10 * 60_000
let recheck: ReturnType<typeof setTimeout> | null = null
let notice: string | undefined

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function pwHash(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: 310000 }, key, 256)
  return 'v2$' + b64(bits)
}
const pwSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)))

const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

/** Set-Cookie values (Android may join several with commas): name → value, or null when cleared. */
function parseSetCookie(raw: unknown): Record<string, string | null> {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/,\s*(?=[^;,\s=]+=)/) : []
  const set: Record<string, string | null> = {}
  for (const c of list) {
    const [pair, ...attrs] = c.split(';')
    const i = pair.indexOf('=')
    if (i < 0) continue
    const v = pair.slice(i + 1).trim()
    set[pair.slice(0, i).trim()] = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || !v ? null : v
  }
  return set
}
const applyCookies = (jar: Record<string, string>, set: Record<string, string | null>) => {
  const out = { ...jar }
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

/**
 * The website: the account service doesn't answer browsers, so the site's own Worker
 * (web/worker.js) makes the call and keeps the session cookies in an encrypted token,
 * held here as the one cookie "__web".
 */
async function webCall<T>(name: string, args: unknown[], jar: Record<string, string>): Promise<{ v: T; set: Record<string, string | null> }> {
  let res: Response
  try {
    res = await fetch(`/api/account/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args, jar: jar.__web ?? '' }),
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    throw new Error('Can’t reach Veyra. Check your connection and try again.')
  }
  const j: any = await res.json().catch(() => null)
  if (!j) throw new Error(`Veyra answered ${res.status}. Try again.`)
  if (!j.ok) throw new Error(j.e || 'Veyra refused that.')
  return { v: j.v as T, set: { __web: j.jar || null } }
}

async function call<T>(name: string, args: unknown[], jar: Record<string, string> = {}): Promise<{ v: T; set: Record<string, string | null> }> {
  if (ON_WEB) return webCall<T>(name, args, jar)
  let res
  try {
    res = await CapacitorHttp.request({
      url: `${SERVER}/api/${name}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) },
      data: args,
      connectTimeout: 20000,
      readTimeout: 20000
    })
  } catch {
    throw new Error('Can’t reach Veyra. Check your connection and try again.')
  }
  const headerKey = Object.keys(res.headers ?? {}).find((k) => k.toLowerCase() === 'set-cookie')
  const set = parseSetCookie(headerKey ? res.headers[headerKey] : undefined)
  const j: any = typeof res.data === 'string' ? (() => { try { return JSON.parse(res.data) } catch { return null } })() : res.data
  if (!j) throw new Error(`Veyra answered ${res.status}. Try again.`)
  if (!j.ok) throw new Error(j.e || 'Veyra refused that.')
  return { v: j.v as T, set }
}

const folderFor = (username: string) => username.toLowerCase().replace(/[^a-z0-9_.-]/g, '_')
const dbName = (s: Session | null) => (s ? `veyra-study-${s.folder}` : 'veyra-study')

/** Loads the saved sign-in and opens that account's database. Runs before anything else. */
export async function start(): Promise<void> {
  // The website goes straight in, without an account (its data stays in this browser).
  if (ON_WEB) {
    try {
      if (!localStorage.getItem(GUEST)) localStorage.setItem(GUEST, 'guest')
    } catch {
      /* storage unavailable */
    }
  }
  try {
    const raw = await SecureStorage.getItem(SESSION)
    session = raw ? JSON.parse(raw) : null
  } catch {
    session = null
  }
  // No cookie kept (an early version, or one lost): stay in the account, and sign in again to sync.
  if (session && !Object.keys(session.cookies ?? {}).length) session.ended = true
  idb.useDatabase(dbName(session))
}

export function state(): AccountState {
  let guest = false
  try {
    guest = localStorage.getItem(GUEST) === 'guest'
  } catch {
    /* storage unavailable */
  }
  // The website, with a shared note waiting to be opened ("Open in Veyra Study"): sign in first.
  if (ON_WEB && !session && pendingShare()) return { mode: 'none', user: null, server: SERVER, notice: 'Sign in to open the shared note (or use Veyra Study without an account).' }
  return { mode: session ? 'account' : guest ? 'guest' : 'none', user: session?.user ?? null, server: SERVER, notice, ...(session?.ended ? { ended: true } : {}) }
}
const pendingShare = () => {
  try {
    return !!localStorage.getItem('veyra.openShare')
  } catch {
    return false
  }
}

/** The handle and Cookie header, for the group relay to confirm who this is. Never shown to the UI. */
export async function credentials(): Promise<{ handle: string; cookie: string } | null> {
  if (!session || session.ended) return null
  const cookie = cookieHeader(session.cookies)
  return cookie ? { handle: session.handle, cookie } : null
}
export const username = () => session?.user.username ?? null

async function adopt(home: any, set: Record<string, string | null>): Promise<AccountState> {
  if (!home?.signedIn || !home.token) throw new Error('Signing in didn’t finish. Try again.')
  const cookies = applyCookies({}, set)
  if (!Object.keys(cookies).length) throw new Error('Veyra didn’t start a session. Try again.')
  const user: AccountUser = {
    username: home.user.username,
    displayName: home.user.displayName || home.user.username,
    email: home.user.email || '',
    emailVerified: !!home.user.emailVerified,
    photoUrl: home.user.photoUrl || ''
  }
  const next: Session = { handle: home.token, cookies, user, folder: folderFor(user.username) }
  // The first account on this phone takes over what was made before signing in.
  await idb.adoptGuestInto(dbName(next))
  session = next
  await SecureStorage.setItem(SESSION, JSON.stringify(next))
  localStorage.removeItem(GUEST)
  notice = undefined
  return state()
}

export async function signIn(username: string, password: string): Promise<AccountState> {
  username = username.trim()
  if (!username || !password) throw new Error('Enter your username and password.')
  const { v: info } = await call<{ salt: string; scheme: string }>('getLoginSalt', [username])
  const payload =
    info?.scheme === 'v2' && info.salt
      ? { username, password: await pwHash(password, info.salt), upgradeMaterial: '', upgradeSalt: '' }
      : await (async () => {
          const salt = pwSalt()
          return { username, password, upgradeMaterial: await pwHash(password, salt), upgradeSalt: salt }
        })()
  const r = await call('veyraLogIn', [payload])
  return adopt(r.v, r.set)
}

export async function signUp(input: { username: string; email: string; password: string; acceptLegal: boolean }): Promise<AccountState> {
  const username = input.username.trim()
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw new Error('Username must be 3–30 characters: letters, numbers, . _ -')
  if (input.password.length < 8 || input.password.length > 200) throw new Error('Use a password of at least 8 characters.')
  if (input.acceptLegal !== true) throw new Error('Tick the box to agree to the Terms and Privacy Policy.')
  const salt = pwSalt()
  const r = await call('veyraSignUp', [{ username, email: input.email.trim(), password: await pwHash(input.password, salt), pbkdf2Salt: salt, acceptLegal: true }])
  return adopt(r.v, r.set)
}

/**
 * Checks the saved sign-in with Veyra. You're never signed out by this: offline or server trouble
 * keeps the sign-in, and Veyra answers "not signed in" for passing trouble too, so that only counts
 * once it's said 3 times, at least 10 minutes apart. Even then you stay in your account with your
 * data; syncing, Group work and Veyra AI wait until you sign in again.
 */
export async function refresh(): Promise<AccountState> {
  if (!session || !Object.keys(session.cookies ?? {}).length) return state()
  try {
    const { v, set } = await call<any>('launcherWhoAmI', [session.handle], session.cookies)
    if (!v?.signedIn) {
      // Keep the cookies as they are: one cleared by a passing error would end the sign-in for good.
      session.misses = (session.misses ?? 0) + 1
      session.firstMissAt ??= Date.now()
      if (session.misses >= MISSES_TO_END && Date.now() - session.firstMissAt >= MISS_SPAN_MS) session.ended = true
      await SecureStorage.setItem(SESSION, JSON.stringify(session))
      if (!session.ended && !recheck)
        recheck = setTimeout(() => {
          recheck = null
          void refresh()
        }, session.misses === 1 ? 30_000 : 5 * 60_000)
      return state()
    }
    session.misses = 0
    session.firstMissAt = undefined
    session.ended = false
    session.cookies = applyCookies(session.cookies, set)
    session.user = { ...session.user, username: v.username, displayName: v.displayName || v.username, email: v.email || '', emailVerified: !!v.emailVerified }
    await SecureStorage.setItem(SESSION, JSON.stringify(session))
  } catch {
    /* offline or server trouble: keep the session */
  }
  return state()
}

/* ---------- password and email (Veyra's own checks and emails, as on its pages) ---------- */
export async function requestReset(id: string): Promise<{ sentTo: string }> {
  id = id.trim()
  if (!id) throw new Error('Enter your username or email.')
  const { v } = await call<{ sentTo?: string }>('requestPasswordReset', [id])
  return { sentTo: v?.sentTo || '' }
}

export async function resetPassword(id: string, code: string, password: string): Promise<void> {
  if (!code.trim()) throw new Error('Enter the code from your email.')
  if (password.length < 8 || password.length > 200) throw new Error('Use a password of at least 8 characters.')
  const salt = pwSalt()
  await call('resetPasswordWithCode', [id.trim(), code.trim(), await pwHash(password, salt), salt])
}

/** A call as the signed-in person (their handle first, with the session cookies). */
async function authed<T>(name: string, args: unknown[]): Promise<T> {
  const s = session
  if (!s || s.ended) throw new Error('Sign in again first.')
  const { v, set } = await call<T>(name, [s.handle, ...args], s.cookies)
  s.cookies = applyCookies(s.cookies, set)
  await SecureStorage.setItem(SESSION, JSON.stringify(s))
  return v
}
async function markUser(change: Partial<AccountUser>): Promise<void> {
  if (!session) return
  session.user = { ...session.user, ...change }
  await SecureStorage.setItem(SESSION, JSON.stringify(session))
}

export async function verifyEmail(code: string): Promise<AccountState> {
  if (!code.trim()) throw new Error('Enter the code from your email.')
  await authed('verifyEmail', [code.trim()])
  await markUser({ emailVerified: true })
  return state()
}

export async function resendVerification(): Promise<{ sentTo: string; alreadyVerified: boolean }> {
  const v = await authed<{ sentTo?: string; alreadyVerified?: boolean }>('resendVerificationEmail', [])
  if (v?.alreadyVerified) await markUser({ emailVerified: true })
  return { sentTo: v?.sentTo || '', alreadyVerified: !!v?.alreadyVerified }
}

export async function setEmail(email: string): Promise<AccountState> {
  email = email.trim()
  if (!email) throw new Error('Enter your email address.')
  const v = await authed<{ email?: string }>('linkEmail', [email])
  await markUser({ email: v?.email || email, emailVerified: false })
  return state()
}

export async function changePassword(current: string, next: string): Promise<void> {
  if (!session || session.ended) throw new Error('Sign in again first.')
  if (!current) throw new Error('Enter your current password.')
  if (next.length < 8 || next.length > 200) throw new Error('Use a new password of at least 8 characters.')
  const { v: info } = await call<{ salt: string; scheme: string }>('getLoginSalt', [session.user.username])
  const material = info?.scheme === 'v2' && info.salt ? await pwHash(current, info.salt) : current
  const salt = pwSalt()
  await authed('changePassword', [material, await pwHash(next, salt), salt])
}

async function drop(why?: string) {
  session = null
  notice = why
  await SecureStorage.removeItem(SESSION)
  await CapacitorCookies.clearCookies({ url: SERVER }).catch(() => {})
}

export async function signOut(): Promise<AccountState> {
  if (session) await call('logOut', [session.handle], session.cookies).catch(() => {})
  await drop()
  return state()
}

export function continueAsGuest(): AccountState {
  localStorage.setItem(GUEST, 'guest')
  // No account: the link page is where the note is (it's in Notes → Shared in this browser too).
  localStorage.removeItem('veyra.openShare')
  notice = undefined
  return state()
}
