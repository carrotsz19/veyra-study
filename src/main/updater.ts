/**
 * Updates at start-up. Before the app opens, a small window checks GitHub
 * (carrotsz19/veyra-study releases) for a newer version: none, and the app
 * opens; one, and it shows "Downloading update…" with real progress, then
 * installs it quietly and opens the new version by itself.
 *
 * Only in the installed app. Being offline (or GitHub being slow) never
 * holds the app up for more than a few seconds.
 *
 * Settings → Software update can also check, download and install at any
 * time (and turn the start-up check off).
 *
 * Dev checks: VEYRA_UPDATE_URL points at a stand-in update server (latest.yml
 * plus the installer); VEYRA_UPDATE_DRYRUN downloads but doesn't install.
 */
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import type { DevBuild, UpdateState } from '../shared/types'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { autoUpdater } from 'electron-updater'
import { APP_NAME, DEV_FEED_TOKEN, DEV_REPO, IS_DEV } from '../shared/channel'
import { devBuildRunning } from './dev-builder'
import { compareVeyraVersions, parseDevRelease, stripDevMetaComment, type DevReleaseLike } from '../shared/dev-builds'
import splashPath from '../../resources/splash.html?asset'
import { diag } from './diaglog'

const CHECK_TIMEOUT = 8000

export type StartResult = 'open' | 'installing'

/** Updates work in the installed app (or against a test feed). */
export const canUpdate = () => (app.isPackaged || !!process.env['VEYRA_UPDATE_URL']) && !process.env['VEYRA_NO_UPDATE']

/*
 * Never stuck on a broken update: before installing, Veyra notes which version
 * it's installing from and to. Starting up again still on the old version
 * means that install failed, so it isn't tried again by itself (not at start,
 * not on close, not on quit) and Veyra simply opens. Settings → Software
 * update says so and can try again.
 */
const ATTEMPT = () => join(app.getPath('userData'), 'update-attempt.json')
function lastAttempt(): { from: string; to: string; at: number } | null {
  try {
    const a = JSON.parse(readFileSync(ATTEMPT(), 'utf8'))
    // On a newer version now: that install worked.
    if (a.from !== app.getVersion()) {
      unlinkSync(ATTEMPT())
      return null
    }
    return a
  } catch {
    return null
  }
}
/** True if installing this version was already tried and didn't work. */
export const failedBefore = (version?: string): boolean => !!version && lastAttempt()?.to === version
function install(version: string | undefined) {
  try {
    writeFileSync(ATTEMPT(), JSON.stringify({ from: app.getVersion(), to: version ?? '', at: Date.now() }))
  } catch {
    /* installs anyway */
  }
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}
/*
 * Why a check failed, in words. A release that's still being published (its latest.yml isn't
 * up yet) is normal for a few minutes and isn't the same as GitHub being down (issue #2).
 */
const PUBLISHING = 'A new version is being published right now. Check again in a few minutes.'
const checkError = (e: unknown): string => {
  const s = String((e as { code?: string })?.code ?? '') + ' ' + String(e)
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|latest\.yml/i.test(s)) return PUBLISHING
  if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|net::/i.test(s)) return 'Can’t reach GitHub. Check your connection.'
  return 'Couldn’t check for updates. Try again later.'
}
const FAILED = (v: string) => `Veyra Study ${v} didn’t install last time, so Veyra opened as it was. Try again here, or download it from GitHub.`

const DEV_PIN = () => join(app.getPath('userData'), 'dev-pin.json')
function readDevPin(): { tag: string; version: string } | null {
  if (!IS_DEV) return null
  try {
    const p = JSON.parse(readFileSync(DEV_PIN(), 'utf8'))
    return typeof p?.tag === 'string' && p.tag ? { tag: p.tag, version: String(p.version ?? '') } : null
  } catch {
    return null
  }
}
function writeDevPin(tag: string, version: string) {
  if (!IS_DEV) return
  try {
    writeFileSync(DEV_PIN(), JSON.stringify({ tag, version, at: Date.now() }))
  } catch {
    /* non-fatal */
  }
}
function clearDevPin() {
  if (!IS_DEV) return
  try {
    unlinkSync(DEV_PIN())
  } catch {
    /* already absent */
  }
}

let configured = false
function applyDefaultFeed() {
  const testFeed = process.env['VEYRA_UPDATE_URL']
  autoUpdater.allowDowngrade = false
  // Veyra Study Dev: the newest release in the private test-build repo (latest.yml there).
  if (IS_DEV && !testFeed) {
    autoUpdater.allowPrerelease = false
    autoUpdater.setFeedURL({ provider: 'github', owner: DEV_REPO.owner, repo: DEV_REPO.repo, private: true, token: DEV_FEED_TOKEN })
  }
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
  }
}
function configure() {
  if (configured) return
  configured = true
  autoUpdater.autoDownload = false
  // Installing when Veyra quits, unless that already failed for the waiting version.
  autoUpdater.autoInstallOnAppQuit = !lastAttempt()
  autoUpdater.logger = null
  applyDefaultFeed()
}

export async function updateAtStart(checkAtStart = true): Promise<StartResult> {
  if (!canUpdate()) return 'open'
  configure()
  // Dev build pinned to a specific commit/release: don't overwrite it on start-up.
  const pin = readDevPin()
  if (pin) {
    publish({ pinnedTag: pin.tag })
    return 'open'
  }
  // Turned off in Settings: just remember what's out there, for Settings → Software update.
  if (!checkAtStart) {
    void checkNow().catch(() => {})
    return 'open'
  }

  // Started with Windows (quietly, into the tray): no window; fetch any update now, install it when Veyra quits.
  // (Also after an update installed while the window was closed.)
  if (process.argv.includes('--hidden') || existsSync(HIDDEN_FLAG())) {
    void lookForUpdate(true).catch(() => {})
    return 'open'
  }

  const splash = new BrowserWindow({
    width: 440,
    height: 260,
    resizable: false,
    maximizable: false,
    minimizable: true,
    frame: false,
    show: false,
    center: true,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15140f' : '#f3f1ec',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  const set = (s: Record<string, unknown>) => {
    if (!splash.isDestroyed()) void splash.webContents.executeJavaScript(`window.set(${JSON.stringify(s)})`).catch(() => {})
  }
  try {
    await splash.loadFile(splashPath)
  } catch {
    splash.destroy()
    return 'open'
  }
  set({ dark: nativeTheme.shouldUseDarkColors, version: app.getVersion(), step: 'checking' })
  splash.show()
  const close = () => !splash.isDestroyed() && splash.destroy()

  try {
    const found = await Promise.race([autoUpdater.checkForUpdates(), new Promise<null>((r) => setTimeout(() => r(null), CHECK_TIMEOUT))])
    const info = found?.updateInfo
    if (found) remember(found.updateInfo, found.isUpdateAvailable)
    if (!found || !info || !found.isUpdateAvailable) {
      set({ step: 'starting', note: 'Up to date. Opening Veyra Study…' })
      await new Promise((r) => setTimeout(r, 350))
      close()
      return 'open'
    }
    // This version already failed to install: open as it is (Settings → Software update can retry).
    if (failedBefore(info.version)) {
      publish({ error: FAILED(info.version) })
      set({ step: 'starting', note: 'Opening Veyra Study…' })
      await new Promise((r) => setTimeout(r, 300))
      close()
      return 'open'
    }

    // Downloading update…
    set({ step: 'downloading', next: info.version, done: 0, total: 0 })
    autoUpdater.on('download-progress', (p) => set({ step: 'downloading', next: info.version, done: p.transferred, total: p.total, speed: p.bytesPerSecond }))
    await autoUpdater.downloadUpdate()

    // Installing update…
    set({ step: 'installing', next: info.version })
    if (process.env['VEYRA_UPDATE_DRYRUN']) {
      await new Promise((r) => setTimeout(r, 2500))
      close()
      return 'open'
    }
    await new Promise((r) => setTimeout(r, 900))
    // Quietly, then open the new version.
    install(info.version)
    return 'installing'
  } catch (e) {
    // Offline, GitHub trouble, a release still being published, a download that broke: open the app as it is; the next start tries again.
    diag('start-up update failed', { error: e })
    set({ step: 'starting', note: checkError(e) === PUBLISHING ? 'An update is on its way. Opening Veyra Study…' : 'Couldn’t check for updates. Opening Veyra Study…' })
    await new Promise((r) => setTimeout(r, 700))
    close()
    return 'open'
  }
}

/* ---------- Settings → Software update ---------- */
let state: UpdateState = { supported: false, current: '', status: 'idle' }
const watchers = new Set<WebContents>()
const notes = (n: unknown): string =>
  stripDevMetaComment(
    (Array.isArray(n) ? n.map((x: { note?: string }) => x.note ?? '').join('\n') : String(n ?? ''))
      .replace(/<\/(p|li|h\d)>/gi, '\n')
      .replace(/<li>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )

function publish(s: Partial<UpdateState>) {
  state = { ...state, ...s }
  for (const wc of watchers) if (!wc.isDestroyed()) wc.send('update:state', state)
}
function remember(info: { version: string; releaseNotes?: unknown; releaseDate?: string }, available: boolean) {
  publish({ checkedAt: Date.now(), latest: info.version, notes: notes(info.releaseNotes), releaseDate: info.releaseDate, status: available ? 'available' : 'up-to-date', error: available && failedBefore(info.version) ? FAILED(info.version) : undefined })
}

export function updateState(wc?: WebContents): UpdateState {
  if (wc && !watchers.has(wc)) {
    watchers.add(wc)
    wc.once('destroyed', () => watchers.delete(wc))
  }
  state = { ...state, supported: canUpdate(), current: app.getVersion(), ...(IS_DEV ? { pinnedTag: readDevPin()?.tag ?? null } : {}) }
  return state
}

export async function checkNow(): Promise<UpdateState> {
  if (!canUpdate()) return updateState()
  configure()
  if (state.status === 'downloading' || state.status === 'ready') return state
  publish({ status: 'checking', error: undefined })
  try {
    const r = await autoUpdater.checkForUpdates()
    if (!r) publish({ status: 'up-to-date', checkedAt: Date.now() })
    else remember(r.updateInfo, r.isUpdateAvailable)
  } catch (e) {
    diag('update check failed', { error: e })
    publish({ status: 'error', error: checkError(e) })
  }
  return state
}

export async function downloadNow(): Promise<UpdateState> {
  if (!canUpdate() || state.status !== 'available') return state
  publish({ status: 'downloading', progress: 0 })
  const onProgress = (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) =>
    publish({ progress: p.percent / 100, transferred: p.transferred, total: p.total, speed: p.bytesPerSecond })
  autoUpdater.on('download-progress', onProgress)
  try {
    await autoUpdater.downloadUpdate()
    publish({ status: 'ready', progress: 1 })
  } catch (e) {
    diag('update download failed', { error: e })
    if (process.env['VEYRA_UPDATE_URL']) console.error('update download failed:', e)
    publish({ status: 'available', error: 'The download didn’t finish. Try again.' })
  } finally {
    autoUpdater.removeListener('download-progress', onProgress)
  }
  return state
}

/** Restart into the downloaded version (also a retry after a failed install: you asked for it). */
export function installNow(): void {
  if (state.status !== 'ready') return
  if (process.env['VEYRA_UPDATE_DRYRUN']) return
  // Restarting would stop a Dev build that is publishing from this app (Build from commits).
  if (devBuildRunning()) {
    publish({ error: 'A Dev build is running. Restart when it finishes.' })
    return
  }
  install(state.latest)
}

/* ---------- staying up to date while Veyra keeps running ---------- */
/*
 * Closing the window keeps Veyra in the tray, so the start-up check alone
 * could leave it on an old version for days. So: look now and then (and when
 * the window is opened again), download quietly, offer "Restart" — and if the
 * window is simply closed with an update ready, install it then and come back
 * quietly in the tray.
 */
let lastLook = 0
let allowed: () => boolean = () => true
const HIDDEN_FLAG = () => join(app.getPath('userData'), 'relaunch-hidden')

/** Look for an update (at most every 5 minutes) and download it if there is one. */
export async function lookForUpdate(force = false): Promise<void> {
  if (!canUpdate() || !allowed()) return
  if (readDevPin()) return
  if (!force && Date.now() - lastLook < 5 * 60_000) return
  if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return
  lastLook = Date.now()
  configure()
  const s = await checkNow()
  if (s.status === 'available') await downloadNow()
}

/** Every 10 minutes while running. `on` says whether automatic updates are switched on. */
export function keepUpToDate(on: () => boolean): void {
  allowed = on
  if (!canUpdate()) return
  lastLook = Date.now() // the start-up check just happened
  setInterval(() => void lookForUpdate(), 10 * 60_000).unref?.()
}

/** Installs a downloaded update now; `hidden` brings Veyra back in the tray. False if there's none. */
export function installReady(hidden: boolean): boolean {
  if (state.status !== 'ready' || process.env['VEYRA_UPDATE_DRYRUN']) return false
  // Not while a Dev build is publishing from this app: installing quits Veyra and would stop it.
  if (devBuildRunning()) return false
  // Not by itself again after it failed.
  if (failedBefore(state.latest)) return false
  try {
    if (hidden) writeFileSync(HIDDEN_FLAG(), '1')
  } catch {
    /* comes back with its window instead */
  }
  install(state.latest)
  return true
}

/** True once after an update installed while the window was closed (start in the tray). */
export function takeHiddenFlag(): boolean {
  try {
    if (!existsSync(HIDDEN_FLAG())) return false
    unlinkSync(HIDDEN_FLAG())
    return true
  } catch {
    return false
  }
}

/* ---------- Dev build switcher (carrotsz19/veyra-study-dev, IS_DEV only) ---------- */
const DEV_API_BASE = () => (process.env['VEYRA_DEV_API'] || 'https://api.github.com').replace(/\/$/, '')

async function fetchDevReleases(): Promise<DevReleaseLike[]> {
  if (!IS_DEV) return []
  if (!DEV_FEED_TOKEN && !process.env['VEYRA_DEV_API']) throw new Error('This Dev build has no test-build feed token.')
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'VeyraStudyDev' }
  if (DEV_FEED_TOKEN) headers.Authorization = `Bearer ${DEV_FEED_TOKEN}`
  const res = await fetch(`${DEV_API_BASE()}/repos/${DEV_REPO.owner}/${DEV_REPO.repo}/releases?per_page=20`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`)
  const data = (await res.json()) as unknown
  return Array.isArray(data) ? (data as DevReleaseLike[]) : []
}

/** Lists published Dev builds with their commit metadata (Dev builds only). */
export async function listDevBuilds(): Promise<{ builds: DevBuild[]; pinnedTag: string | null; error?: string }> {
  if (!IS_DEV) return { builds: [], pinnedTag: null }
  const pinnedTag = readDevPin()?.tag ?? null
  try {
    const raw = await fetchDevReleases()
    const current = app.getVersion()
    const builds = raw
      .map((r) => parseDevRelease(r, current))
      .filter((b): b is DevBuild => b !== null)
      .sort((a, b) => compareVeyraVersions(b.version, a.version))
    return { builds, pinnedTag }
  } catch (e) {
    diag('dev builds list failed', { error: e })
    return { builds: [], pinnedTag, error: e instanceof Error ? e.message : 'Couldn’t load Dev builds.' }
  }
}

/**
 * Downloads a specific Dev release (upgrade or downgrade) through a short-lived local proxy so
 * electron-updater handles progress, SHA-512 verification, signing checks, and quitAndInstall.
 */
export async function installDevBuild(tag: string): Promise<UpdateState> {
  if (!IS_DEV) return updateState()
  if (!canUpdate()) {
    publish({ error: 'Switching Dev builds works in the installed Veyra Study Dev app.' })
    return state
  }
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
    publish({ error: 'Invalid build tag.' })
    return state
  }
  if (state.status === 'downloading') return state
  configure()
  publish({ status: 'checking', targetTag: tag, error: undefined })

  let proxy: Server | null = null
  const onProgress = (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) =>
    publish({ progress: p.percent / 100, transferred: p.transferred, total: p.total, speed: p.bytesPerSecond })

  try {
    const releases = await fetchDevReleases()
    const rel = releases.find((r) => r.tag_name === tag && !r.draft)
    if (!rel) throw new Error('That Dev build is no longer on GitHub.')
    const parsed = parseDevRelease(rel, app.getVersion())
    if (!parsed || !parsed.hasWindows) throw new Error('That Dev build does not have a Windows installer.')

    const newestTag = releases.map((r) => parseDevRelease(r, app.getVersion())).filter((b): b is DevBuild => b !== null && b.hasWindows).sort((a, b) => compareVeyraVersions(b.version, a.version))[0]?.tag
    const assets = new Map((rel.assets ?? []).filter((a) => a.name && a.url).map((a) => [a.name, a.url!]))
    const nonce = randomBytes(12).toString('hex')
    const authHeaders: Record<string, string> = { Accept: 'application/octet-stream', 'User-Agent': 'VeyraStudyDev' }
    if (DEV_FEED_TOKEN) authHeaders.Authorization = `Bearer ${DEV_FEED_TOKEN}`

    proxy = createServer(async (req, res) => {
      try {
        const urlPath = (req.url ?? '').split('?')[0]
        const prefix = `/${nonce}/`
        if (!urlPath.startsWith(prefix)) {
          res.writeHead(404)
          return res.end()
        }
        const name = decodeURIComponent(urlPath.slice(prefix.length))
        const assetUrl = assets.get(name)
        if (!assetUrl) {
          res.writeHead(404)
          return res.end()
        }
        // GitHub private asset endpoints return a 302 to a pre-signed blob URL (which rejects an Auth header).
        const first = await fetch(assetUrl, { headers: authHeaders, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
        const upstream =
          first.status >= 300 && first.status < 400 && first.headers.get('location')
            ? await fetch(first.headers.get('location')!, { signal: AbortSignal.timeout(120_000) })
            : first
        if (!upstream.ok || !upstream.body) {
          res.writeHead(upstream.status || 502)
          return res.end()
        }
        const headersOut: Record<string, string> = { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' }
        const len = upstream.headers.get('content-length')
        if (len) headersOut['Content-Length'] = len
        res.writeHead(200, headersOut)
        Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
      } catch {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      }
    })

    const port = await new Promise<number>((resolvePort, rejectPort) => {
      proxy!.once('error', rejectPort)
      proxy!.listen(0, '127.0.0.1', () => {
        const addr = proxy!.address()
        if (addr && typeof addr === 'object') resolvePort(addr.port)
        else rejectPort(new Error('Could not start local update proxy.'))
      })
    })

    autoUpdater.allowDowngrade = true
    autoUpdater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}/${nonce}` })
    const found = await autoUpdater.checkForUpdates()
    if (!found?.updateInfo) throw new Error('Couldn’t read that Dev build’s update manifest.')

    publish({ status: 'downloading', latest: parsed.version, notes: parsed.notes, releaseDate: parsed.publishedAt, targetTag: tag, progress: 0, transferred: 0, total: 0 })
    autoUpdater.on('download-progress', onProgress)
    await autoUpdater.downloadUpdate()

    // Pin when switching to a non-latest build so auto-updates don't overwrite it on next launch.
    if (newestTag && tag !== newestTag) writeDevPin(tag, parsed.version)
    else clearDevPin()

    publish({ status: 'ready', latest: parsed.version, notes: parsed.notes, releaseDate: parsed.publishedAt, targetTag: tag, pinnedTag: readDevPin()?.tag ?? null, progress: 1, error: undefined })
    return state
  } catch (e) {
    diag('dev build switch failed', { tag, error: e })
    publish({ status: 'idle', targetTag: undefined, error: e instanceof Error ? e.message : 'Couldn’t download that Dev build.' })
    return state
  } finally {
    autoUpdater.removeListener('download-progress', onProgress)
    if (proxy) proxy.close()
    applyDefaultFeed()
  }
}

/** Resumes following the newest Dev release and checks for updates immediately. */
export async function unpinDevBuild(): Promise<UpdateState> {
  if (!IS_DEV) return updateState()
  clearDevPin()
  applyDefaultFeed()
  publish({ pinnedTag: null, targetTag: undefined, error: undefined })
  return checkNow()
}
