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
import type { UpdateState } from '../shared/types'
import { autoUpdater } from 'electron-updater'
import splashPath from '../../resources/splash.html?asset'

const CHECK_TIMEOUT = 8000

export type StartResult = 'open' | 'installing'

/** Updates work in the installed app (or against a test feed). */
export const canUpdate = () => (app.isPackaged || !!process.env['VEYRA_UPDATE_URL']) && !process.env['VEYRA_NO_UPDATE']

let configured = false
function configure() {
  if (configured) return
  configured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  const testFeed = process.env['VEYRA_UPDATE_URL']
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
  }
}

export async function updateAtStart(checkAtStart = true): Promise<StartResult> {
  if (!canUpdate()) return 'open'
  configure()
  // Turned off in Settings: just remember what's out there, for Settings → Software update.
  if (!checkAtStart) {
    void checkNow().catch(() => {})
    return 'open'
  }

  // Started with Windows (quietly, into the tray): no window; fetch any update now, install it when Veyra quits.
  if (process.argv.includes('--hidden')) {
    autoUpdater.autoDownload = true
    void autoUpdater.checkForUpdates().catch(() => {})
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
    title: 'Veyra Study',
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
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
    return 'installing'
  } catch {
    // Offline, GitHub trouble, a download that broke: open the app as it is; the next start tries again.
    set({ step: 'starting', note: 'Couldn’t check for updates. Opening Veyra Study…' })
    await new Promise((r) => setTimeout(r, 700))
    close()
    return 'open'
  }
}

/* ---------- Settings → Software update ---------- */
let state: UpdateState = { supported: false, current: '', status: 'idle' }
const watchers = new Set<WebContents>()
const notes = (n: unknown): string =>
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

function publish(s: Partial<UpdateState>) {
  state = { ...state, ...s }
  for (const wc of watchers) if (!wc.isDestroyed()) wc.send('update:state', state)
}
function remember(info: { version: string; releaseNotes?: unknown; releaseDate?: string }, available: boolean) {
  publish({ checkedAt: Date.now(), latest: info.version, notes: notes(info.releaseNotes), releaseDate: info.releaseDate, status: available ? 'available' : 'up-to-date', error: undefined })
}

export function updateState(wc?: WebContents): UpdateState {
  if (wc && !watchers.has(wc)) {
    watchers.add(wc)
    wc.once('destroyed', () => watchers.delete(wc))
  }
  state = { ...state, supported: canUpdate(), current: app.getVersion() }
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
    publish({ status: 'error', error: /ENOTFOUND|ECONN|ETIMEDOUT|net::/i.test(String(e)) ? 'Can’t reach GitHub. Check your connection.' : 'Couldn’t check for updates. Try again later.' })
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
    if (process.env['VEYRA_UPDATE_URL']) console.error('update download failed:', e)
    publish({ status: 'available', error: 'The download didn’t finish. Try again.' })
  } finally {
    autoUpdater.removeListener('download-progress', onProgress)
  }
  return state
}

/** Restart into the downloaded version. */
export function installNow(): void {
  if (state.status !== 'ready') return
  if (process.env['VEYRA_UPDATE_DRYRUN']) return
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}
