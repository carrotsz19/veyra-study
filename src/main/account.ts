/**
 * Veyra account sign-in for the desktop app.
 *
 * Uses the same Worker endpoints as Veyra home (carrotsz19/veyra, live/code.gs
 * section 12): getLoginSalt, veyraLogIn, veyraSignUp, launcherWhoAmI, logOut.
 * The Worker keeps the real session token in an HttpOnly cookie and answers
 * with a "ck_" handle (worker/src/sessions.js). This process plays the
 * browser's part: it keeps that cookie and the handle, encrypted on disk with
 * the OS keychain (safeStorage), and never hands the cookie to the UI.
 *
 * Passwords are hashed here exactly as live/index.html pwHash/pwCurrent do:
 * PBKDF2-SHA256, 310,000 rounds, 32 bytes, "v2$" + base64.
 */
import { app, safeStorage } from 'electron'
import { pbkdf2, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

export const VEYRA_SERVER = (process.env['VEYRA_SERVER'] || 'https://veyra.igreenrobotz.workers.dev').replace(/\/$/, '')
// "Windows" lets the Worker name this sign-in in the account's device list
// (sessions.js deviceLabel).
const USER_AGENT = `VeyraStudy/${app.getVersion()} (Windows NT 10.0; Win64; x64)`

export interface AccountUser {
  username: string
  displayName: string
  email: string
  emailVerified: boolean
  photoUrl?: string
}

interface Session {
  handle: string
  /** Cookie name -> value, as the Worker set them. */
  cookies: Record<string, string>
  user: AccountUser
  /** Local data folder for this account (accounts/<folder>/). */
  folder: string
}

export interface AccountState {
  mode: 'account' | 'guest' | 'none'
  user: AccountUser | null
  server: string
  /** Set when the server ended the session (signed out elsewhere, expired). */
  notice?: string
}

/* ---------- PBKDF2, as the Veyra pages ---------- */
export async function pwHash(password: string, saltB64: string): Promise<string> {
  const bits = await pbkdf2Async(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), 310000, 32, 'sha256')
  return 'v2$' + bits.toString('base64')
}
const pwSalt = () => randomBytes(16).toString('base64')

/* ---------- HTTP ---------- */
export class ApiError extends Error {}

async function call<T>(name: string, args: unknown[], cookies: Record<string, string> = {}): Promise<{ v: T; set: Record<string, string | null> }> {
  let res: Response
  try {
    res = await fetch(`${VEYRA_SERVER}/api/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ')
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    throw new ApiError("Can't reach Veyra. Check your connection and try again.")
  }
  const set: Record<string, string | null> = {}
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(';')
    const i = pair.indexOf('=')
    if (i < 0) continue
    const k = pair.slice(0, i).trim()
    const v = pair.slice(i + 1).trim()
    const cleared = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || !v
    set[k] = cleared ? null : v
  }
  let body: { ok: boolean; v?: T; e?: string }
  try {
    body = await res.json()
  } catch {
    throw new ApiError(`Veyra answered unexpectedly (${res.status}). Try again in a moment.`)
  }
  if (!body.ok) throw new ApiError(body.e || 'That didn’t work. Try again.')
  return { v: body.v as T, set }
}

const applyCookies = (jar: Record<string, string>, set: Record<string, string | null>) => {
  const next = { ...jar }
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete next[k]
    else next[k] = v
  }
  return next
}

/* ---------- local files ---------- */
const dir = () => app.getPath('userData')
const sessionFile = () => join(dir(), 'session.bin')
const indexFile = () => join(dir(), 'accounts.json')
const guestFlag = () => join(dir(), 'guest-mode')
export const guestDbPath = () => join(dir(), 'veyra.db')
export const accountDir = (folder: string) => join(dir(), 'accounts', folder)

interface AccountIndex {
  /** lower-cased username -> folder id */
  folders: Record<string, string>
}
function readIndex(): AccountIndex {
  try {
    return JSON.parse(readFileSync(indexFile(), 'utf8'))
  } catch {
    return { folders: {} }
  }
}
const writeIndex = (ix: AccountIndex) => writeFileSync(indexFile(), JSON.stringify(ix, null, 2))

function folderFor(username: string): { folder: string; isNew: boolean } {
  const ix = readIndex()
  const key = username.toLowerCase()
  if (ix.folders[key]) return { folder: ix.folders[key], isNew: false }
  const folder = randomUUID()
  const isFirst = Object.keys(ix.folders).length === 0
  ix.folders[key] = folder
  writeIndex(ix)
  mkdirSync(accountDir(folder), { recursive: true })
  return { folder, isNew: isFirst }
}

function readSession(): Session | null {
  try {
    if (!existsSync(sessionFile()) || !safeStorage.isEncryptionAvailable()) return null
    return JSON.parse(safeStorage.decryptString(readFileSync(sessionFile())))
  } catch {
    return null
  }
}
function writeSession(s: Session | null): void {
  if (!s) {
    rmSync(sessionFile(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new ApiError('This computer can’t store your sign-in securely, so Veyra can’t keep you signed in.')
  writeFileSync(sessionFile(), safeStorage.encryptString(JSON.stringify(s)))
}

/* ---------- the account service ---------- */
export class Accounts {
  private session: Session | null = readSession()
  private notice: string | undefined

  constructor(private onSwitch: (dbPath: string, info: { moved: boolean }) => void) {}

  /** Database path for whoever is using the app now. */
  currentDbPath(): string {
    return this.session ? join(accountDir(this.session.folder), 'veyra.db') : guestDbPath()
  }

  state(): AccountState {
    const mode = this.session ? 'account' : existsSync(guestFlag()) ? 'guest' : 'none'
    return { mode, user: this.session?.user ?? null, server: VEYRA_SERVER, notice: this.notice }
  }

  continueAsGuest(): AccountState {
    writeFileSync(guestFlag(), '1')
    this.notice = undefined
    return this.state()
  }

  async legalUrls(): Promise<{ legal: string; terms: string; privacy: string; terms2: string; privacy2: string }> {
    try {
      const { v } = await call<any>('getLegalUrls', [])
      return { legal: v.legal || `${VEYRA_SERVER}/?page=legal`, terms: v.ironlog.terms, privacy: v.ironlog.privacy, terms2: v.cashline.terms, privacy2: v.cashline.privacy }
    } catch {
      const b = VEYRA_SERVER + '/'
      return { legal: `${b}?page=legal`, terms: `${b}?page=terms&app=ironlog`, privacy: `${b}?page=privacy&app=ironlog`, terms2: `${b}?page=terms&app=cashline`, privacy2: `${b}?page=privacy&app=cashline` }
    }
  }

  async signIn(username: string, password: string): Promise<AccountState> {
    username = username.trim()
    if (!username || !password) throw new ApiError('Enter your username and password.')
    // As pwCurrent: accounts still on the old scheme send the password once,
    // with new material so the server can upgrade them.
    const { v: info } = await call<{ salt: string; scheme: string }>('getLoginSalt', [username])
    let payload: Record<string, string>
    if (info && info.scheme === 'v2' && info.salt) {
      payload = { username, password: await pwHash(password, info.salt), upgradeMaterial: '', upgradeSalt: '' }
    } else {
      const salt = pwSalt()
      payload = { username, password, upgradeMaterial: await pwHash(password, salt), upgradeSalt: salt }
    }
    const { v, set } = await call<any>('veyraLogIn', [payload])
    return this.adopt(v, set)
  }

  async signUp(input: { username: string; email: string; password: string; acceptLegal: boolean }): Promise<AccountState> {
    const username = input.username.trim()
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw new ApiError('Username must be 3–30 characters: letters, numbers, . _ -')
    if (input.password.length < 8 || input.password.length > 200) throw new ApiError('Use a password of at least 8 characters.')
    // Only ever true when the person ticked the box in the sign-up form.
    if (input.acceptLegal !== true) throw new ApiError('Tick the box to agree to the Terms and Privacy Policy.')
    const salt = pwSalt()
    const { v, set } = await call<any>('veyraSignUp', [
      { username, email: input.email.trim(), password: await pwHash(input.password, salt), pbkdf2Salt: salt, acceptLegal: true }
    ])
    return this.adopt(v, set)
  }

  private adopt(home: any, set: Record<string, string | null>): AccountState {
    if (!home || !home.signedIn || !home.token) throw new ApiError('Signing in didn’t finish. Try again.')
    const cookies = applyCookies({}, set)
    if (!Object.keys(cookies).length) throw new ApiError('Veyra didn’t start a session. Try again.')
    const user: AccountUser = {
      username: home.user.username,
      displayName: home.user.displayName || home.user.username,
      email: home.user.email || '',
      emailVerified: !!home.user.emailVerified,
      photoUrl: home.user.photoUrl || ''
    }
    const { folder, isNew } = folderFor(user.username)
    // The first account signed in on this computer takes over the data made
    // before accounts existed, so nothing is left behind.
    let moved = false
    const target = join(accountDir(folder), 'veyra.db')
    this.onSwitch('', { moved: false }) // close the current database first
    if (isNew && existsSync(guestDbPath()) && !existsSync(target)) {
      for (const ext of ['', '-wal', '-shm']) {
        if (existsSync(guestDbPath() + ext)) renameSync(guestDbPath() + ext, target + ext)
      }
      const g = join(dir(), 'google-local.bin')
      if (existsSync(g)) renameSync(g, join(accountDir(folder), 'google.bin'))
      const files = join(dir(), 'attachments')
      if (existsSync(files) && !existsSync(join(accountDir(folder), 'attachments'))) renameSync(files, join(accountDir(folder), 'attachments'))
      moved = true
    }
    this.session = { handle: home.token, cookies, user, folder }
    writeSession(this.session)
    rmSync(guestFlag(), { force: true })
    this.notice = undefined
    this.onSwitch(target, { moved })
    return { ...this.state(), ...(moved ? { notice: 'moved' } : {}) }
  }

  /** Checks the saved session with the server. Offline keeps you signed in. */
  async refresh(): Promise<AccountState> {
    const s = this.session
    if (!s) return this.state()
    try {
      const { v, set } = await call<any>('launcherWhoAmI', [s.handle], s.cookies)
      if (!v || !v.signedIn) {
        this.dropSession('You were signed out of your Veyra account. Sign in again to keep using your data.')
        return this.state()
      }
      s.cookies = applyCookies(s.cookies, set)
      s.user = { ...s.user, username: v.username, displayName: v.displayName || v.username, email: v.email || '', emailVerified: !!v.emailVerified }
      // A renamed account keeps its folder.
      const ix = readIndex()
      if (!ix.folders[v.username.toLowerCase()]) {
        ix.folders[v.username.toLowerCase()] = s.folder
        writeIndex(ix)
      }
      writeSession(s)
    } catch {
      /* offline or server trouble: keep the session */
    }
    return this.state()
  }

  private dropSession(notice?: string) {
    this.onSwitch('', { moved: false })
    this.session = null
    writeSession(null)
    this.notice = notice
    this.onSwitch(guestDbPath(), { moved: false })
  }

  async signOut(): Promise<AccountState> {
    const s = this.session
    if (s) {
      try {
        await call('logOut', [s.handle], s.cookies)
      } catch {
        /* signing out locally still happens */
      }
    }
    this.dropSession()
    return this.state()
  }

  /**
   * Main process only (never sent to the UI): the handle and the Cookie
   * header, so the group relay can confirm who this is with Veyra.
   */
  credentials(): { handle: string; cookie: string } | null {
    const s = this.session
    if (!s) return null
    return { handle: s.handle, cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join('; ') }
  }

  /** For other services that are per account (Google Calendar). */
  folder(): string | null {
    return this.session?.folder ?? null
  }
}
