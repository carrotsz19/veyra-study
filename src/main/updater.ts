/**
 * Updates at start-up. Before the app opens, a small window checks GitHub
 * (carrotsz19/veyra-study releases) for a newer version: none, and the app
 * opens; one, and it shows "Downloading update…" with real progress, then
 * installs it quietly and opens the new version by itself.
 *
 * Only in the installed app. Being offline (or GitHub being slow) never
 * holds the app up for more than a few seconds.
 *
 * Dev checks: VEYRA_UPDATE_URL points at a stand-in update server (latest.yml
 * plus the installer); VEYRA_UPDATE_DRYRUN downloads but doesn't install.
 */
import { app, BrowserWindow, nativeTheme } from 'electron'
import { autoUpdater } from 'electron-updater'
import splashPath from '../../resources/splash.html?asset'

const CHECK_TIMEOUT = 8000

export type StartResult = 'open' | 'installing'

export async function updateAtStart(): Promise<StartResult> {
  const testFeed = process.env['VEYRA_UPDATE_URL']
  if (!app.isPackaged && !testFeed) return 'open'
  if (process.env['VEYRA_NO_UPDATE']) return 'open'

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  if (testFeed) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed })
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
