import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import iconPath from '../../resources/icon.png?asset'
import trayPath from '../../resources/tray@2x.png?asset'
import devBadgePath from '../../resources/dev-badge.png?asset'
import { Reminders } from './reminders'
import { cancelDevBuild, chooseDevRepo, clearDevBuild, devBuilderState, devCandidates, devPreview, startDevBuild, stopDevBuildOnQuit } from './dev-builder'
import type { DevBuildRequest } from '../shared/dev-builder'
import { checkNow, downloadNow, installDevBuild, installNow, installReady, keepUpToDate, listDevBuilds, lookForUpdate, takeHiddenFlag, unpinDevBuild, updateAtStart, updateState } from './updater'
import { withDefaults } from '../shared/settings'
import { ChatNotifier, type ChatNotice } from '../shared/chat-notify'
import { isDmGroup } from '../shared/dm'
import { APP_NAME, IS_DEV } from '../shared/channel'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import type { Rec } from '../shared/types'
import { Store } from './db'
import { Accounts, ApiError, accountDir } from './account'
import { GoogleCalendar, GoogleError } from './gcal'
import { IcalError, IcalFeeds } from './ical'
import { AiError, AiService } from './ai'
import { LocalAi, LocalAiError } from './localai'
import { GroupClient, GroupError } from './group'
import { FileError, Files, registerFileScheme } from './files'
import { DriveError, GoogleDrive } from './drive'
import { Sync } from './sync'
import { VoiceError, Whisper } from './whisper'
import { McpServer, addToClient, clientConfigPath, clientHasVeyra, mcpEntry } from './mcp'
import { setupMenus, setupTextMenu } from './popup'
import { exportBinaryFiles, exportPdfFiles } from './export'
import { crashedRunsInARow, diag, diagDir, initDiag, onProblem, problem, readDiag, recentDiag, trackWindow, windowFacts } from './diaglog'
import { CONTACT } from '../shared/contact'

// Dev checks: VEYRA_FAKE_MIC=1 records a test tone instead of the real microphone.
if (process.env['VEYRA_FAKE_MIC']) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
// Dev checks: run on a separate profile (sign-in, settings and data).
// Otherwise always %APPDATA% eyra-study: the installed app is named "Veyra Study", and its data
// must stay where the app has always kept it.
// Veyra Study Dev (and running the code with npm run dev) keeps its data apart from the real app's.
const devData = IS_DEV || !app.isPackaged
if (process.env['VEYRA_USERDATA']) app.setPath('userData', process.env['VEYRA_USERDATA'])
else app.setPath('userData', join(app.getPath('appData'), devData ? 'veyra-study-dev' : 'veyra-study'))
app.setName(APP_NAME)

// One Veyra at a time: opening it again shows the one already running (in the tray, say).
const firstCopy = app.requestSingleInstanceLock()
if (!firstCopy) app.quit()
// The technical log (Settings → Data & privacy → Diagnostics). Only the copy that stays writes to it.
else initDiag()
/** When Veyra was last opened again while already running. */
let lastReopen = 0
// Opening Veyra again (Start menu, taskbar): install a downloaded update first if there is one.
app.on('second-instance', () => {
  diag('second launch: current window', { window: windowFacts(mainWin), tray: !!tray && !tray.isDestroyed() })
  if (installReady(false)) return
  // Opened twice in quick succession: whatever is there didn't appear, so build a fresh window
  // instead of trusting the old one. (Windows can lose Veyra's window without telling it: then
  // showing it again does nothing, and every later launch hands off to the same invisible copy.)
  const again = Date.now() - lastReopen < 15_000
  lastReopen = Date.now()
  if (again && !startingUp && app.isReady()) return rebuildWindow()
  showWindow()
})
// Packaged builds have a Start menu shortcut with this id, which Windows needs for notifications.
if (app.isPackaged && process.platform === 'win32') app.setAppUserModelId(IS_DEV ? 'app.veyra.study.dev' : 'app.veyra.study')

let mainWin: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** True until the main window exists (the update window comes and goes first). */
let startingUp = true
app.on('before-quit', () => (quitting = true))
/** Settings, read in the main process (tray and reminders). */
const appSettings = () => {
  try {
    return withDefaults((store?.list('settings')[0]?.data as object) ?? {})
  } catch {
    return withDefaults({})
  }
}
function showWindow(screen?: string): void {
  if (!mainWin || mainWin.isDestroyed()) createWindow()
  const w = mainWin!
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  if (screen) w.webContents.send('app:nav', screen)
  // Back from the tray: a good moment to look for an update (at most every 5 minutes).
  void lookForUpdate()
}

/*
 * "Veyra Study couldn't open properly" (or "keeps closing unexpectedly"): a plain Windows message,
 * so it still works when the app's own screens don't (a bad release, say). It offers to send a
 * report (that press is the person's go-ahead, even with automatic reports off), the log folder,
 * and the owner's email. Not an older version: its start-up update check would install the broken
 * one again. The way out of a bad release is a fix or tools/rollback.mjs, which installs by itself.
 */
let reportNow: ((trigger: string) => Promise<{ ok: true } | { ok: false; error: string }>) | null = null
let openTrouble = false
async function couldntOpen(why: string, kind: 'open' | 'crashes' = 'open'): Promise<void> {
  if (openTrouble) return
  openTrouble = true
  if (kind === 'open') problem('couldn’t open', { why })
  // Test launches (tools/smoke.mjs) only need the log line, not a message nobody will click.
  if (process.env['VEYRA_SCREENSHOT']) return
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: kind === 'open' ? `${APP_NAME} couldn’t open properly` : `${APP_NAME} keeps closing unexpectedly`,
      detail: `${why}\n\nYou can send a technical report to the owner so it gets fixed. It holds app events and errors, not your notes or messages. When a fixed version is out, ${APP_NAME} installs it by itself the next time it starts.`,
      buttons: ['Send a report', 'Open the log folder', 'Email the owner', 'Close'],
      defaultId: 0,
      cancelId: 3,
      noLink: true
    })
    if (response === 0) {
      const r = reportNow ? await reportNow(kind === 'open' ? 'couldn’t open' : 'last run ended unexpectedly') : { ok: false as const, error: 'Veyra hadn’t finished starting.' }
      await dialog.showMessageBox({
        type: r.ok ? 'info' : 'warning',
        title: APP_NAME,
        message: r.ok ? 'Report sent. Thank you!' : 'Couldn’t send the report',
        detail: r.ok
          ? 'If you can, also tell the owner what you were doing: by email, or in Veyra when it opens (it will ask).'
          : `${r.error}\n\nYou can email the log instead: choose “Open the log folder” and attach diagnostics.log.`,
        buttons: ['OK']
      })
      if (r.ok) break
      continue
    }
    if (response === 1) {
      void shell.openPath(diagDir())
      continue
    }
    if (response === 2) {
      void shell.openExternal(`mailto:${CONTACT.email}?subject=${encodeURIComponent(`${APP_NAME} ${app.getVersion()} won’t open`)}`)
      continue
    }
    break
  }
}

/** Watches the first main window open: a screen that crashes, fails to load, stays blank or never appears gets the message above. */
let openingWatched = false
function watchOpening(win: BrowserWindow): void {
  if (openingWatched) return
  openingWatched = true
  let fine = false
  const failed = (why: string) => !fine && !win.isDestroyed() && void couldntOpen(why)
  // Not for a quiet start with Windows (a busy login can be slow, and nobody is waiting for the window).
  const hiddenStart = process.argv.includes('--hidden')
  const never = hiddenStart ? undefined : setTimeout(() => failed('Its window didn’t finish opening within a minute and a half.'), 90_000)
  win.webContents.on('render-process-gone', (_e, d) => d.reason !== 'clean-exit' && failed(`Its screen crashed while opening (${d.reason}).`))
  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => isMainFrame && code !== -3 && failed(`Its screen didn’t load (${desc}).`))
  win.webContents.once('did-finish-load', () => {
    // Loaded is not the same as drawn: a bad release can leave the page empty. Look a little later.
    setTimeout(() => {
      if (win.isDestroyed()) return
      win.webContents
        .executeJavaScript("document.getElementById('root')?.childElementCount ?? 0")
        .then((n: number) => {
          if (n > 0) {
            fine = true
            clearTimeout(never)
          } else failed('Its screen stayed blank.')
        })
        .catch(() => failed('Its screen stopped responding while opening.'))
    }, 8000)
  })
}

/** Replaces the main window (and the tray icon) with fresh ones: the way back when the old window went missing. */
function rebuildWindow(): void {
  problem('rebuilding window', { old: windowFacts(mainWin) })
  const old = mainWin && !mainWin.isDestroyed() ? mainWin : null
  // The new window first: with no window at all for a moment, Veyra would quit.
  mainWin = null
  createWindow()
  const w = mainWin as BrowserWindow | null
  w?.once('ready-to-show', () => {
    if (w.isDestroyed()) return
    w.show()
    w.focus()
  })
  if (old) {
    // destroy() skips the page's unload handlers, where notes and settings save their last edits:
    // run them first (the saves are synchronous), giving up after a moment if the old screen is stuck.
    const flush = old.webContents.isDestroyed() ? Promise.resolve() : old.webContents.executeJavaScript("window.dispatchEvent(new Event('beforeunload'))").catch(() => {})
    void Promise.race([flush, new Promise((r) => setTimeout(r, 1500))]).then(() => {
      for (const child of old.getChildWindows()) if (!child.isDestroyed()) child.destroy()
      if (!old.isDestroyed()) old.destroy()
    })
  }
  if (!process.env['VEYRA_SCREENSHOT']) {
    if (tray && !tray.isDestroyed()) tray.destroy()
    makeTray()
  }
}

/** The tray icon and its menu. */
function makeTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayPath).resize({ width: 16, height: 16 }))
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => showWindow() },
      { label: 'Today', click: () => showWindow('today') },
      { label: 'Tasks', click: () => showWindow('tasks') },
      { type: 'separator' },
      { label: `Quit ${APP_NAME}`, click: () => app.quit() }
    ])
  )
  tray.on('click', () => showWindow())
}

function openChat(groupId: string): void {
  showWindow()
  const w = mainWin
  if (!w || w.isDestroyed()) return
  const send = () => !w.isDestroyed() && w.webContents.send('app:openChat', groupId)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

function showChatNotification(notice: ChatNotice): void {
  const log = process.env['VEYRA_NOTIFY_LOG']
  if (log) return appendFileSync(log, JSON.stringify(notice) + '\n')
  if (!Notification.isSupported()) return
  const n = new Notification({ title: notice.title, body: notice.body, silent: false })
  n.on('click', () => openChat(notice.groupId))
  n.show()
}

// Attachments are shown through veyra-file:// (registered before the app is ready).
registerFileScheme()

let store: Store | null = null
let accounts: Accounts
let google: GoogleCalendar | null = null
let feeds: IcalFeeds | null = null
let ai: AiService | null = null
let group: GroupClient | null = null
let chatNotifier: ChatNotifier | null = null
let drive: GoogleDrive | null = null
let sync: Sync | null = null
const localAi = new LocalAi()
const whisper = new Whisper()
app.on('will-quit', () => whisper.stopAll())
const files = new Files(() => (accounts ? accounts.folder() : null))
app.on('will-quit', () => localAi.stop())
app.on('will-quit', () => stopDevBuildOnQuit())

/** One Google connection per account (or for the no-account data). */
function openGoogle(): void {
  const folder = accounts.folder()
  const file = folder ? join(accountDir(folder), 'google.bin') : join(app.getPath('userData'), 'google-local.bin')
  feeds = new IcalFeeds(folder ? join(accountDir(folder), 'ical.bin') : join(app.getPath('userData'), 'ical-local.bin'))
  ai = new AiService(folder ? join(accountDir(folder), 'ai.bin') : join(app.getPath('userData'), 'ai-local.bin'), () => localAi.ensureRunning(), (model, tps) => localAi.recordSpeed(model, tps))
  google = new GoogleCalendar(
    file,
    (since) => db().changesSince(since).filter((r) => r.kind === 'task') as Rec<'task'>[],
    (id) => (id ? ((db().list('subject') as Rec<'subject'>[]).find((s) => s.id === id)?.data.name ?? null) : null)
  )
  google.schedulePush(5000)
  // A background refresh found changes: open calendars ask again.
  const calendarChanged = () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('calendar:changed')
  }
  google.onChange = calendarChanged
  feeds.onChange = calendarChanged
  drive = new GoogleDrive(folder ? join(accountDir(folder), 'drive.bin') : join(app.getPath('userData'), 'drive-local.bin'), files)
  group = new GroupClient(
    folder ? join(accountDir(folder), 'group.bin') : join(app.getPath('userData'), 'group-local.bin'),
    () => accounts.credentials(),
    (channel, payload) => chatNotifier?.onEvent(channel, payload)
  )
  chatNotifier = new ChatNotifier({
    call: async <T,>(method: 'GET', path: string) => (await group!.call(method, path)) as T,
    meId: () => group?.getStatus().me?.username ?? null,
    enabled: () => appSettings().chatNotify,
    isWindowActive: () => !!mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused(),
    allowGroup: (g) => !(isDmGroup(g) && appSettings().dmWhoCanMessage === 'nobody'),
    notify: showChatNotification
  })
  // Connect in the background so Group work is ready when it's opened.
  if (folder) void group.connect()
  // Your own data on every computer you sign in to (only with a Veyra account).
  if (folder && store) {
    sync = new Sync(store, group, (kinds, ids) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('db:external', { kinds, ids })
      if (kinds.includes('task') || kinds.includes('subject')) google?.schedulePush()
    })
    sync.schedule(4000)
  }
}
const gcal = (): GoogleCalendar => google!

function openStore(path: string): void {
  google?.dispose()
  google = null
  feeds?.dispose()
  feeds = null
  ai?.dispose()
  ai = null
  sync?.dispose()
  sync = null
  chatNotifier?.dispose()
  chatNotifier = null
  group?.dispose()
  group = null
  drive?.dispose()
  drive = null
  store?.close()
  store = path ? new Store(path) : null
  if (store && accounts) openGoogle()
}
const db = (): Store => {
  if (!store) throw new Error('No data is open yet.')
  return store
}
/** Errors the user should read go through as-is; anything else is generic. */
const friendly = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (e) {
    throw new Error(e instanceof ApiError || e instanceof GoogleError || e instanceof IcalError || e instanceof AiError || e instanceof LocalAiError || e instanceof FileError || e instanceof DriveError || e instanceof VoiceError ? e.message : 'Something went wrong. Try again.')
  }
}

/* ---------- window material (Windows 11: acrylic or mica behind the app) ---------- */
type Material = 'solid' | 'acrylic' | 'mica'
const materialSupported = process.platform === 'win32' && Number(release().split('.')[2] ?? 0) >= 22621
const prefsFile = () => join(app.getPath('userData'), 'window.json')
type WindowPrefs = { material: Material; theme: 'system' | 'light' | 'dark'; buttons: 'dots' | 'windows' }
function windowPrefs(): WindowPrefs {
  try {
    const j = JSON.parse(readFileSync(prefsFile(), 'utf8'))
    return {
      material: ['solid', 'acrylic', 'mica'].includes(j.material) ? j.material : 'acrylic',
      theme: ['light', 'dark'].includes(j.theme) ? j.theme : 'system',
      buttons: j.buttons === 'dots' ? 'dots' : 'windows'
    }
  } catch {
    return { material: 'acrylic', theme: 'system', buttons: 'windows' }
  }
}
function savePrefs(p: Partial<WindowPrefs>): void {
  // Only what was actually chosen is written, so unchosen options keep following the defaults.
  let saved: Record<string, unknown> = {}
  try {
    saved = JSON.parse(readFileSync(prefsFile(), 'utf8'))
  } catch {
    /* none yet */
  }
  try {
    writeFileSync(prefsFile(), JSON.stringify({ ...saved, ...p }))
  } catch {
    /* not fatal */
  }
}
/** The window buttons this window was made with (Windows only lets its own be added when the window is created). */
let windowButtons: 'dots' | 'windows' = 'windows'
/*
 * Veyra draws its own title bar (the app's name and menus); Windows keeps
 * drawing just the minimise / maximise / close buttons (so Snap layouts still
 * work), in colours that match the theme, on glass or on the solid colour.
 */
const ownTitleBar = process.platform === 'win32'
const TITLE_BAR_H = 40
let barMaterial: Material = 'acrylic'
function overlay(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  const glass = materialSupported && barMaterial !== 'solid'
  return { color: glass ? '#00000000' : dark ? '#15140f' : '#f3f1ec', symbolColor: dark ? '#e9e5dc' : '#2c2a26', height: TITLE_BAR_H }
}
function refreshTitleBar(): void {
  if (!ownTitleBar || windowButtons !== 'windows') return
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setTitleBarOverlay(overlay())
    } catch {
      /* a window without the overlay (the update splash) */
    }
  }
}
nativeTheme.on('updated', refreshTitleBar)

/**
 * Full screen can't use real acrylic (Windows makes it flicker), so Veyra paints it itself:
 * the desktop wallpaper, small and blurred by the page, under the usual tint. Null: none found.
 */
function wallpaper(): string | null {
  try {
    const img = nativeImage.createFromBuffer(readFileSync(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')))
    if (img.isEmpty()) return null
    return img.resize({ width: 640, quality: 'good' }).toJPEG(80).toString('base64')
  } catch {
    return null
  }
}
function sendBackdrop(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const on = materialSupported && barMaterial !== 'solid' && win.isFullScreen()
  const b64 = on ? wallpaper() : null
  win.webContents.send('win:backdrop', b64 ? `data:image/jpeg;base64,${b64}` : null)
}

function applyMaterial(win: BrowserWindow, material: Material): void {
  barMaterial = material
  if (!materialSupported) return
  // Windows flickers acrylic/mica on a full-screen window, so full screen is always solid.
  if (win.isFullScreen()) material = 'solid'
  win.setBackgroundMaterial(material === 'solid' ? 'none' : material)
  win.setBackgroundColor(material === 'solid' ? (nativeTheme.shouldUseDarkColors ? '#15140f' : '#f7f7f5') : '#00000000')
}

function createWindow(): void {
  const win = new BrowserWindow({
    icon: iconPath,
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    // See-through (acrylic / mica) when chosen in Appearance; the page paints the tint.
    ...(() => {
      const p = windowPrefs()
      nativeTheme.themeSource = p.theme
      return materialSupported && p.material !== 'solid' ? { backgroundColor: '#00000000', backgroundMaterial: p.material } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#15140f' : '#f7f7f5' }
    })(),
    autoHideMenuBar: true,
    ...(ownTitleBar ? (() => {
      const p = windowPrefs()
      barMaterial = p.material
      windowButtons = p.buttons
      // Mac-style dots: Veyra draws them in its title bar. Windows: its own buttons, coloured to match.
      return p.buttons === 'windows' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: overlay() } : { titleBarStyle: 'hidden' as const }
    })() : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      // Chromium's sandbox: the preload only needs Electron's own modules.
      sandbox: true
    }
  })

  mainWin = win
  trackWindow(win, 'main')
  watchOpening(win)
  // The title bar's window buttons dim when Veyra isn't the active window, and show restore when maximised.
  const sendState = () => !win.isDestroyed() && win.webContents.send('win:state', { focused: win.isFocused(), maximized: win.isMaximized() })
  for (const ev of ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'focus', sendState)
  // Full screen: solid background (acrylic flickers there); back to the chosen glass on leaving.
  // Coming back to Veyra: look for an update too (at most every 5 minutes).
  win.on('focus', () => void lookForUpdate())
  win.on('enter-full-screen', () => (applyMaterial(win, barMaterial), sendBackdrop(win)))
  win.on('leave-full-screen', () => (applyMaterial(win, barMaterial), sendBackdrop(win)))
  // Veyra Study Dev: a violet dot on its taskbar icon, so it's never mistaken for the real app.
  if (IS_DEV && process.platform === 'win32') win.once('ready-to-show', () => win.setOverlayIcon(nativeImage.createFromPath(devBadgePath), 'Veyra Study Dev (test build)'))
  // Started with Windows: wait in the tray until asked for.
  // (or an update was installed while the window was closed: come back the same way)
  const hidden = (process.argv.includes('--hidden') || takeHiddenFlag()) && !process.env['VEYRA_SCREENSHOT']
  win.once('ready-to-show', () => !hidden && win.show())
  // Closing keeps Veyra in the tray (Settings → Tasks → Reminders), so reminders still come.
  win.on('close', (e) => {
    if (quitting || process.env['VEYRA_SCREENSHOT'] || !tray || !appSettings().keepInTray) return
    e.preventDefault()
    win.hide()
    // An update is downloaded: install it now, while nobody is looking, and come back in the tray.
    installReady(true)
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })

  // Dev check: VEYRA_SCREENSHOT=path.png saves what the window shows, then quits.
  const shot = process.env['VEYRA_SCREENSHOT']
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const script = process.env['VEYRA_EVAL']
        if (script) {
          await win.webContents.executeJavaScript(script).catch((e) => console.error('VEYRA_EVAL', e))
          await new Promise((r) => setTimeout(r, 700))
        }
        const img = await win.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(shot, img.toPNG())
        app.quit()
      }, 2500)
    })
  }

  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  loadPage(win, process.env['VEYRA_ROUTE'])
  // The title bar's menus open in a small acrylic window of their own (real blur behind them).
  if (ownTitleBar) setupMenus(win, loadPage, join(__dirname, '../preload/index.js'), materialSupported)
  // Right-click in text: spelling suggestions, then Cut / Copy / Paste.
  setupTextMenu(win)
}

/** Loads the app's page into a window (`hash` picks a screen, or "menu" for the menu window). */
/*
 * No window ever leaves Veyra's own page. Its windows can reach your data (window.veyra), so a
 * link that would load a web page in one (say in a note someone shared with your group) opens in
 * the browser instead. Pop-up windows and embedded web views are refused too.
 */
const ownPage = (u: string): boolean => {
  try {
    const url = new URL(u)
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!app.isPackaged && dev && url.origin === new URL(dev).origin) return true
    return url.protocol === 'file:' && /\/renderer\/index\.html$/.test(url.pathname)
  } catch {
    return false
  }
}
app.on('web-contents-created', (_e, wc) => {
  const stay = (e: Electron.Event, url: string) => {
    if (ownPage(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url) || /^mailto:[^\s]+$/i.test(url)) void shell.openExternal(url)
  }
  wc.on('will-navigate', stay)
  wc.on('will-redirect', stay)
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

function loadPage(w: BrowserWindow, hash?: string): void {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    w.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? '#' + hash : ''))
  } else {
    w.loadFile(join(__dirname, '../renderer/index.html'), { hash, query: process.env['VEYRA_THEME'] ? { theme: process.env['VEYRA_THEME'] } : undefined })
  }
}

app.whenReady().then(async () => {
  accounts = new Accounts((path) => openStore(path))
  // VEYRA_DB (dev checks) pins one database and skips accounts' choice.
  openStore(process.env['VEYRA_DB'] || accounts.currentDbPath())
  setInterval(() => google?.schedulePush(0), 15 * 60 * 1000)

  files.handleProtocol()
  ipcMain.handle('voice:status', () => {
    whisper.useSubtitleMaker = appSettings().voiceUseSubtitleMaker
    return whisper.status()
  })
  ipcMain.handle('voice:setup', (e, model) => friendly(() => whisper.setup(model, e.sender)))
  ipcMain.handle('voice:cancelSetup', () => whisper.cancelSetup())
  ipcMain.handle('voice:transcribe', (e, id: string, wav: Uint8Array, model, language: string) => friendly(() => (whisper.useSubtitleMaker = appSettings().voiceUseSubtitleMaker, whisper).transcribe(String(id), wav, model === 'small' ? 'small' : 'base', String(language), e.sender)))
  ipcMain.handle('voice:cancel', (_e, id: string) => whisper.cancel(String(id)))
  ipcMain.handle('voice:save', (_e, name: string, mime: string, bytes: Uint8Array) => friendly(async () => files.fromDownload(String(name), String(mime), bytes)))
  const noSync = { enabled: false, sending: true, history: true, state: 'idle', error: '' }
  ipcMain.handle('sync:status', () => sync?.state() ?? noSync)
  ipcMain.handle('sync:now', () => sync?.run() ?? noSync)
  ipcMain.handle('sync:set', (_e, on: boolean) => sync?.setEnabled(!!on) ?? noSync)
  ipcMain.handle('sync:sending', (_e, on: boolean) => sync?.setSending(!!on) ?? noSync)
  ipcMain.handle('sync:history', (_e, on: boolean) => sync?.setHistory(!!on) ?? noSync)
  const gdrive = (): GoogleDrive => {
    if (!drive) throw new DriveError('Google Drive isn’t ready yet.')
    return drive
  }
  ipcMain.handle('drive:state', () => friendly(async () => gdrive().state()))
  ipcMain.handle('drive:connect', (_e, read?: boolean) => friendly(() => gdrive().connect(read === true)))
  ipcMain.handle('drive:setAssistant', (_e, on: boolean) => friendly(async () => gdrive().setAssistant(!!on)))
  ipcMain.handle('drive:search', (_e, query: string, limit?: number) => friendly(() => gdrive().search(String(query ?? ''), Number(limit) || 10)))
  ipcMain.handle('drive:read', (_e, id: string) => friendly(() => gdrive().read(String(id ?? ''))))
  ipcMain.handle('drive:createDoc', (_e, title: string, html: string) => friendly(() => gdrive().createDoc(String(title ?? ''), String(html ?? '').slice(0, 5_000_000))))
  ipcMain.handle('drive:trash', (_e, id: string) => friendly(() => gdrive().trash(String(id ?? ''))))
  ipcMain.handle('drive:disconnect', () => friendly(async () => gdrive().disconnect()))
  ipcMain.handle('drive:setBackup', (_e, on: boolean) => friendly(async () => gdrive().setBackup(!!on)))
  ipcMain.handle('drive:pick', () => friendly(() => gdrive().pickAndImport()))
  ipcMain.handle('drive:resetBackup', () => friendly(async () => gdrive().resetBackup()))
  ipcMain.handle('drive:saveDoc', (_e, noteId: string, title: string, html: string) =>
    friendly(() => gdrive().saveDoc(String(noteId), String(title ?? ''), String(html ?? '').slice(0, 5_000_000)))
  )
  ipcMain.handle('drive:backup', (_e, list: unknown, through: number) =>
    friendly(() => gdrive().backupNotes(Array.isArray(list) ? list.filter((f) => f && typeof f.id === 'string' && typeof f.markdown === 'string') : [], Number(through) || 0))
  )
  ipcMain.handle('files:pick', () => friendly(() => files.pick()))
  ipcMain.handle('files:fromPaths', (_e, paths: string[]) => friendly(async () => files.fromPaths(Array.isArray(paths) ? paths : [])))
  ipcMain.handle('files:fromBytes', (_e, name: string, mime: string, bytes: Uint8Array) => friendly(async () => files.fromBytes(name, mime, bytes)))
  ipcMain.handle('files:open', (_e, id: string) => friendly(() => files.open(id)))
  ipcMain.handle('files:reveal', (_e, id: string) => files.reveal(id))
  ipcMain.handle('files:read', (_e, id: string) => friendly(async () => files.read(String(id))))
  ipcMain.handle('db:list', (_e, kind) => db().list(kind))
  ipcMain.handle('db:put', (_e, kind, data, id) => {
    const rec = db().put(kind, data, id)
    if (kind === 'task' || kind === 'subject') google?.schedulePush()
    if (kind === 'settings') chatNotifier?.onSettingsChanged()
    sync?.schedule()
    return rec
  })
  // Synchronous save, used only while the window is closing so the last edit isn't lost.
  ipcMain.on('db:putSync', (e, kind, data, id) => {
    try {
      e.returnValue = db().put(kind, data, id)
      if (kind === 'task') google?.schedulePush()
      sync?.schedule(0)
    } catch {
      e.returnValue = null
    }
  })
  ipcMain.handle('db:remove', (_e, id) => {
    db().remove(id)
    google?.schedulePush()
    sync?.schedule()
  })
  ipcMain.handle('db:changesSince', (_e, since) => db().changesSince(since))
  ipcMain.handle('db:info', () => ({ deviceId: db().deviceId, dbPath: db().path }))

  ipcMain.handle('account:state', () => accounts.state())
  ipcMain.handle('account:refresh', () => friendly(() => accounts.refresh()))
  ipcMain.handle('account:signIn', (_e, username: string, password: string) => friendly(() => accounts.signIn(username, password)))
  ipcMain.handle('account:signUp', (_e, input) => friendly(() => accounts.signUp(input)))
  ipcMain.handle('account:signOut', () => friendly(() => accounts.signOut()))
  ipcMain.handle('account:guest', () => accounts.continueAsGuest())
  ipcMain.handle('account:legal', () => accounts.legalUrls())
  ipcMain.handle('account:requestReset', (_e, id: string) => friendly(() => accounts.requestReset(String(id ?? ''))))
  ipcMain.handle('account:resetPassword', (_e, id: string, code: string, pw: string) => friendly(() => accounts.resetPassword(String(id ?? ''), String(code ?? ''), String(pw ?? ''))))
  ipcMain.handle('account:verifyEmail', (_e, code: string) => friendly(() => accounts.verifyEmail(String(code ?? ''))))
  ipcMain.handle('account:resendVerification', () => friendly(() => accounts.resendVerification()))
  ipcMain.handle('account:setEmail', (_e, email: string) => friendly(() => accounts.setEmail(String(email ?? ''))))
  ipcMain.handle('account:changePassword', (_e, current: string, next: string) => friendly(() => accounts.changePassword(String(current ?? ''), String(next ?? ''))))
  ipcMain.handle('friends:list', () => friendly(() => accounts.friendsList()))
  ipcMain.handle('friends:search', (_e, query: string) => friendly(() => accounts.friendsSearch(String(query ?? ''))))
  ipcMain.handle('friends:send', (_e, username: string) => friendly(() => accounts.friendsSend(String(username ?? ''))))
  ipcMain.handle('friends:respond', (_e, requesterId: string, accept: boolean) => friendly(() => accounts.friendsRespond(String(requesterId ?? ''), !!accept)))
  ipcMain.handle('friends:remove', (_e, otherUserId: string) => friendly(() => accounts.friendsRemove(String(otherUserId ?? ''))))
  const withFeeds = <T extends object>(s: T) => ({ ...s, feeds: feeds?.list() ?? [] })
  ipcMain.handle('google:state', () => withFeeds(gcal().state()))
  ipcMain.handle('google:connect', (_e, id?: string, secret?: string) => friendly(async () => withFeeds(await gcal().connect(id, secret))))
  ipcMain.handle('google:disconnect', () => friendly(async () => withFeeds(await gcal().disconnect())))
  ipcMain.handle('google:options', (_e, o) => friendly(async () => withFeeds(await gcal().setOptions(o))))
  ipcMain.handle('google:addFeed', (_e, url: string, name: string) =>
    friendly(async () => {
      await feeds!.add(url, name)
      return withFeeds(gcal().state())
    })
  )
  ipcMain.handle('google:removeFeed', (_e, id: string) => {
    feeds!.remove(id)
    return withFeeds(gcal().state())
  })
  ipcMain.handle('google:events', (_e, from: string, to: string) =>
    // Dev checks: VEYRA_FAKE_GOOGLE=1 shows sample events without a Google account.
    process.env['VEYRA_FAKE_GOOGLE']
      ? fakeEvents()
      : Promise.all([gcal().events(from, to), feeds?.events(from, to) ?? { events: [], error: undefined }, group?.deadlines(from, to) ?? []]).then(([g, f, shared]) => ({
          events: [...g.events, ...f.events, ...shared].sort((a, b) => (a.start < b.start ? -1 : 1)),
          error: g.error ?? f.error
        }))
  )
  ipcMain.handle('google:sync', () => friendly(() => gcal().push()))
  ipcMain.handle('localai:status', () => localAi.status())
  ipcMain.handle('localai:setup', (e, model: string) =>
    friendly(async () => {
      await localAi.setup(model, e.sender)
      return ai!.set({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', model: { provider: 'ollama', model } })
    })
  )
  ipcMain.handle('localai:cancel', () => localAi.cancel())
  ipcMain.handle('ai:state', () => ai!.state())
  ipcMain.handle('ai:set', (_e, o) => friendly(async () => ai!.set(o)))
  ipcMain.handle('ai:forget', () => ai!.forget())
  ipcMain.handle('ai:models', (_e, p) => friendly(() => ai!.models(p)))
  ipcMain.handle('ai:pull', (e, model: string) => friendly(() => ai!.pull(model, e.sender)))
  ipcMain.handle('ai:run', (e, id: string, req) => {
    void ai!.run(id, req, e.sender)
  })
  ipcMain.handle('ai:cancel', (_e, id: string) => ai?.cancel(id))
  // Group work. Calls answer { ok, v } or { ok: false, error, status, extra } so the
  // UI keeps the server's message and details (a note's newer copy on 409).
  const idle = { state: 'idle', me: null, error: '' }
  ipcMain.handle('group:status', (e) => {
    group?.watch(e.sender)
    return group?.getStatus() ?? idle
  })
  ipcMain.handle('group:connect', (e) => {
    group?.watch(e.sender)
    return group?.connect() ?? idle
  })
  ipcMain.handle('group:disconnect', () => {
    group?.disconnect()
    return group?.getStatus() ?? idle
  })
  ipcMain.handle('group:call', async (_e, method: string, path: string, body?: unknown) => {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || typeof path !== 'string' || !/^\/[A-Za-z0-9\-_/?=&%.@]*$/.test(path) || path.includes('..') || path.startsWith('/session') || (path.startsWith('/poll') && !path.startsWith('/poll/voice?')))
      return { ok: false, error: 'That isn’t a group request.', status: 400 }
    try {
      if (!group) throw new GroupError('Group work isn’t ready yet.')
      return { ok: true, v: await group.call(method, path, body) }
    } catch (e) {
      if (e instanceof GroupError) return { ok: false, error: e.message, status: e.status, extra: e.extra }
      return { ok: false, error: 'Something went wrong. Try again.', status: 0 }
    }
  })
  ipcMain.on('app:materialSupported', (e) => (e.returnValue = materialSupported))
  ipcMain.handle('app:setMaterial', (_e, material: Material, theme: 'system' | 'light' | 'dark') => {
    const m: Material = ['solid', 'acrylic', 'mica'].includes(material) ? material : 'acrylic'
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system'
    savePrefs({ material: m, theme: nativeTheme.themeSource })
    for (const w of BrowserWindow.getAllWindows()) applyMaterial(w, m)
    barMaterial = m
    if (mainWin && !mainWin.isDestroyed() && mainWin.isFullScreen()) sendBackdrop(mainWin)
    refreshTitleBar()
  })
  ipcMain.on('app:titleBar', (e) => (e.returnValue = ownTitleBar ? TITLE_BAR_H : 0))
  // Which window buttons this window has, and choosing them for the next start.
  ipcMain.on('app:windowButtons', (e) => (e.returnValue = windowButtons))
  ipcMain.on('app:windowButtonsChoice', (e) => (e.returnValue = windowPrefs().buttons))
  ipcMain.handle('app:setWindowButtons', (_e, b: string) => savePrefs({ buttons: b === 'windows' ? 'windows' : 'dots' }))
  // Diagnostics: show the log, and send it to the group server when the person asks (never by itself).
  ipcMain.handle('diag:read', () => ({ text: readDiag(), folder: diagDir() }))
  ipcMain.handle('diag:open', () => shell.openPath(diagDir()))
  /*
   * Sending reports by itself (Settings → Data & privacy → Diagnostics, off unless chosen):
   * after a crash, a window that stopped responding or went missing, or a run that ended
   * unexpectedly. It waits a little so what happened next is in the log too, sends at most
   * once every 6 hours, and keeps one that couldn't go (offline, server asleep) for later.
   */
  const AUTO_EVERY = 6 * 3600_000
  const autoFile = () => join(diagDir(), 'auto-send.json')
  /** lastSent: when one last went; pending: the problem waiting to be sent; ask: a sent one to ask the person about. */
  type AutoState = { lastSent: number; pending: string; ask: { id: string; trigger: string; at: number } | null }
  const autoState = (): AutoState => {
    try {
      const j = JSON.parse(readFileSync(autoFile(), 'utf8'))
      const ask = j.ask && typeof j.ask.id === 'string' ? { id: String(j.ask.id), trigger: String(j.ask.trigger ?? ''), at: Number(j.ask.at) || 0 } : null
      return { lastSent: Number(j.lastSent) || 0, pending: String(j.pending ?? ''), ask }
    } catch {
      return { lastSent: 0, pending: '', ask: null }
    }
  }
  const saveAuto = (st: AutoState) => {
    try {
      writeFileSync(autoFile(), JSON.stringify(st))
    } catch {
      /* tries again next time */
    }
  }
  let autoTimer: NodeJS.Timeout | null = null
  const autoSend = async () => {
    autoTimer = null
    if (!appSettings().diagAutoSend || !group) return
    const st = autoState()
    if (!st.pending || Date.now() - st.lastSent < AUTO_EVERY) return
    try {
      const r = await group.call('POST', '/diagnostics', {
        log: recentDiag(150_000),
        auto: true,
        trigger: st.pending,
        version: app.getVersion(),
        platform: `${process.platform} ${release()}`
      })
      const ask = r?.id ? { id: String(r.id), trigger: st.pending, at: Date.now() } : null
      saveAuto({ lastSent: Date.now(), pending: '', ask })
      diag('diagnostics sent automatically', { id: r?.id })
      // Ask the person what happened (the report is far more useful with it).
      if (ask) for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('diag:ask', ask)
    } catch (e) {
      // Kept for later: the next problem, the hourly try, or the next start.
      diag('diagnostics not sent automatically', { status: e instanceof GroupError ? e.status : 0 })
    }
  }
  // Sent from the "couldn't open" message: now, whatever the setting (pressing Send is the go-ahead).
  reportNow = async (trigger) => {
    if (!group) return { ok: false, error: 'Sign in to your Veyra account to send reports.' }
    try {
      const r = await group.call('POST', '/diagnostics', { log: recentDiag(150_000), auto: true, trigger, version: app.getVersion(), platform: `${process.platform} ${release()}` })
      const st = autoState()
      saveAuto({ lastSent: Date.now(), pending: '', ask: r?.id ? { id: String(r.id), trigger, at: Date.now() } : st.ask })
      diag('diagnostics sent from the couldn’t-open message', { id: r?.id })
      return { ok: true }
    } catch (e) {
      const status = e instanceof GroupError ? e.status : 0
      if (status === 401) return { ok: false, error: 'Sign in to your Veyra account to send reports.' }
      if (status <= 0) return { ok: false, error: 'Couldn’t reach the Veyra server. It’s off from about midnight to 8 am.' }
      return { ok: false, error: 'The server didn’t take the report.' }
    }
  }
  onProblem((what) => {
    if (!appSettings().diagAutoSend) return
    const st = autoState()
    if (!st.pending) saveAuto({ ...st, pending: what })
    if (!autoTimer) autoTimer = setTimeout(() => void autoSend(), 20_000)
  })
  // One left from before (or from a run that crashed before it could send): try soon, then every hour.
  setTimeout(() => void autoSend(), 60_000).unref()
  setInterval(() => void autoSend(), 3600_000).unref()
  // A report sent by itself that the person hasn't said anything about yet (asked for a week at most).
  ipcMain.handle('diag:ask', () => {
    const { ask } = autoState()
    return ask && Date.now() - ask.at < 7 * 86400_000 ? ask : null
  })
  ipcMain.handle('diag:answer', async (_e, id: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const st = autoState()
    if (!group || !st.ask || st.ask.id !== id) return { ok: false, error: 'That report is no longer waiting for an answer.' }
    try {
      await group.call('POST', `/diagnostics/${encodeURIComponent(id)}/note`, { note: String(note ?? '').slice(0, 2000) })
      saveAuto({ ...st, ask: null })
      diag('diagnostics answer sent', { id })
      return { ok: true }
    } catch (e) {
      const status = e instanceof GroupError ? e.status : 0
      return { ok: false, error: status <= 0 ? 'Couldn’t reach the Veyra server. It’s off from about midnight to 8 am; try again later.' : 'Couldn’t add that to the report. Try again later.' }
    }
  })
  ipcMain.handle('diag:dismiss', () => {
    const st = autoState()
    if (st.ask) saveAuto({ ...st, ask: null })
  })
  ipcMain.handle('diag:send', async (_e, text: string, note: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    if (!group) return { ok: false, error: 'Sign in to your Veyra account first, then try again.' }
    try {
      // Exactly what the person saw in the preview (the newest part, if it's very long).
      const r = await group.call('POST', '/diagnostics', {
        log: String(text ?? '').slice(-300_000),
        note: String(note ?? '').slice(0, 2000),
        version: app.getVersion(),
        platform: `${process.platform} ${release()}`
      })
      diag('diagnostics sent', { id: r?.id })
      return { ok: true, id: String(r?.id ?? '') }
    } catch (e) {
      const status = e instanceof GroupError ? e.status : 0
      diag('diagnostics not sent', { status })
      if (status === 401) return { ok: false, error: 'Sign in to your Veyra account first, then try again.' }
      if (status === 400) return { ok: false, error: 'Say what happened (a sentence is enough), then send.' }
      if (status === 404) return { ok: false, error: 'The Veyra server can’t take reports yet. Try again after the next update.' }
      if (status === 413) return { ok: false, error: 'The report is too big to send. Email it instead.' }
      if (status === 429) return { ok: false, error: 'Too many reports for now. Try again in an hour.' }
      if (status <= 0) return { ok: false, error: 'Couldn’t reach the Veyra server. It’s off from about midnight to 8 am; try again later.' }
      return { ok: false, error: e instanceof Error ? e.message : 'Couldn’t send the report. Try again later.' }
    }
  })
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })
  ipcMain.on('win:state', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    e.returnValue = { focused: !!w?.isFocused(), maximized: !!w?.isMaximized() }
  })
  // The title bar's menus: editing, the window, quitting.
  ipcMain.handle('win:cmd', (e, cmd: string) => {
    const wc = e.sender
    const win = BrowserWindow.fromWebContents(wc)
    switch (cmd) {
      case 'undo': return wc.undo()
      case 'redo': return wc.redo()
      case 'cut': return wc.cut()
      case 'copy': return wc.copy()
      case 'paste': return wc.paste()
      case 'selectAll': return wc.selectAll()
      case 'fullscreen': return win?.setFullScreen(!win.isFullScreen())
      case 'minimize': return win?.minimize()
      case 'maximize': return win ? (win.isMaximized() ? win.unmaximize() : win.maximize()) : undefined
      case 'close': return win?.close()
      case 'quit': return app.quit()
    }
  })
  ipcMain.handle('update:state', (e) => updateState(e.sender))
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:download', () => downloadNow())
  ipcMain.handle('update:install', () => installNow())
  ipcMain.handle('update:devBuilds', () => listDevBuilds())
  ipcMain.handle('update:installDevBuild', (_e, tag: string) => installDevBuild(String(tag ?? '')))
  ipcMain.handle('update:unpinDevBuild', () => unpinDevBuild())
  // Dev builds on Windows: build and publish a Dev release from chosen commits (src/main/dev-builder.ts).
  ipcMain.handle('devBuilder:state', (e) => devBuilderState(e.sender))
  ipcMain.handle('devBuilder:candidates', (_e, fetch?: boolean) => devCandidates(fetch === true))
  ipcMain.handle('devBuilder:preview', (_e, req: DevBuildRequest) => devPreview(req))
  ipcMain.handle('devBuilder:start', (_e, req: DevBuildRequest) => startDevBuild(req))
  ipcMain.handle('devBuilder:cancel', () => cancelDevBuild())
  ipcMain.handle('devBuilder:clear', () => clearDevBuild())
  ipcMain.handle('devBuilder:chooseRepo', (e) => chooseDevRepo(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('app:notifyCheck', () => ({ supported: Notification.isSupported() }))
  ipcMain.handle('app:notifyTest', (_e, title?: string, body?: string) => {
    const t = String(title ?? APP_NAME).slice(0, 100)
    const b = String(body ?? 'Direct message desktop notifications are enabled.').slice(0, 200)
    const log = process.env['VEYRA_NOTIFY_LOG']
    if (log) {
      appendFileSync(log, JSON.stringify({ test: true, title: t, body: b }) + '\n')
      return { shown: true }
    }
    if (!Notification.isSupported()) return { shown: false }
    const n = new Notification({ title: t, body: b, silent: false })
    n.on('click', () => showWindow('messages'))
    n.show()
    return { shown: true }
  })
  ipcMain.handle('data:openFolder', () => shell.openPath(dirname(db().path)))
  ipcMain.handle('data:export', async () => {
    const records = db().changesSince(0).filter((r) => !r.deletedAt)
    const res = await dialog.showSaveDialog({
      title: 'Export your Veyra Study data',
      defaultPath: `veyra-study-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { saved: false }
    writeFileSync(res.filePath, JSON.stringify({ app: 'veyra-study', version: app.getVersion(), exportedAt: new Date().toISOString(), records }, null, 2))
    return { saved: true, path: res.filePath, count: records.length }
  })
  ipcMain.handle('data:import', () => friendly(async () => {
    const res = await dialog.showOpenDialog({ title: 'Import a Veyra Study backup', filters: [{ name: 'Veyra Study backup', extensions: ['json'] }], properties: ['openFile'] })
    if (res.canceled || !res.filePaths[0]) return { imported: 0 }
    let file: any
    try {
      file = JSON.parse(readFileSync(res.filePaths[0], 'utf8'))
    } catch {
      throw new ApiError('That file isn’t a Veyra Study backup.')
    }
    if (file?.app !== 'veyra-study' || !Array.isArray(file.records)) throw new ApiError('That file isn’t a Veyra Study backup.')
    const kinds = new Set(['subject', 'task', 'note', 'session', 'settings', 'folder', 'noteVersion'])
    let n = 0
    for (const r of file.records) {
      if (!r || typeof r.id !== 'string' || !kinds.has(r.kind) || typeof r.data !== 'object') continue
      db().put(r.kind, r.data, r.id)
      n++
    }
    google?.schedulePush()
    sync?.schedule(0)
    return { imported: n }
  }))
  ipcMain.handle('notes:export', async (_e, files: { name: string; text: string }[]) => {
    const safe = (n: string) => (n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Untitled').slice(0, 120)
    if (!files.length) return { saved: 0 }
    if (files.length === 1) {
      const res = await dialog.showSaveDialog({ title: 'Export note', defaultPath: `${safe(files[0].name)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
      if (res.canceled || !res.filePath) return { saved: 0 }
      writeFileSync(res.filePath, files[0].text)
      return { saved: 1 }
    }
    const res = await dialog.showOpenDialog({ title: `Choose a folder for ${files.length} notes`, properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return { saved: 0 }
    const used = new Set<string>()
    for (const f of files) {
      let base = safe(f.name)
      for (let i = 2; used.has(base.toLowerCase()); i++) base = `${safe(f.name)} (${i})`
      used.add(base.toLowerCase())
      writeFileSync(join(res.filePaths[0], `${base}.md`), f.text)
    }
    return { saved: files.length }
  })
  ipcMain.handle('notes:exportFiles', (_e, list: { name: string; ext: string; bytes: Uint8Array }[], kindLabel: string) =>
    friendly(() => exportBinaryFiles(list, kindLabel))
  )
  ipcMain.handle('notes:exportPdf', (_e, list: { name: string; html: string }[]) =>
    friendly(() => exportPdfFiles(list))
  )
  ipcMain.handle('app:open', (_e, url: string) => {
    // Web links, and email (the "still being built" notice's Email button).
    if (/^https:\/\//.test(url) || /^mailto:[^\s]+$/.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('app:setStartup', (_e, on: boolean) => {
    // Only a packaged Veyra registers itself (a dev build would register Electron).
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] })
    return app.isPackaged
  })

  // Check for an update first (the installed app); one being installed means this copy is closing.
  nativeTheme.themeSource = windowPrefs().theme
  // Anything going wrong in the check still opens the app.
  if ((await updateAtStart(appSettings().checkUpdatesAtStart).catch(() => 'open' as const)) === 'installing') return
  createWindow()
  startingUp = false
  // Closed unexpectedly the last two times or more: say so, with the same ways out. Only once the
  // window is actually on screen (not during a quiet start with Windows).
  const crashes = crashedRunsInARow()
  if (crashes >= 2) mainWin?.once('show', () => void couldntOpen(`It closed unexpectedly the last ${crashes} times it was used.`, 'crashes'))
  keepUpToDate(() => appSettings().checkUpdatesAtStart)
  if (!process.env['VEYRA_SCREENSHOT']) makeTray()
  const reminders = new Reminders(() => store, (screen) => showWindow(screen))

  // AI apps (MCP): reads go through here; writes refresh the screens and sync like any edit.
  const mcp = new McpServer({
    store: () => store,
    allowWrites: () => appSettings().mcpAllowWrites,
    changed: (kinds, ids) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('db:external', { kinds, ids })
      sync?.schedule()
      if (kinds.includes('task') || kinds.includes('subject')) google?.schedulePush()
    },
    events: async (from, to) => {
      const [g, f, shared] = await Promise.all([
        google?.events(from, to).catch(() => ({ events: [] })) ?? { events: [] },
        feeds?.events(from, to).catch(() => ({ events: [] })) ?? { events: [] },
        group?.deadlines(from, to).catch(() => []) ?? []
      ])
      return { events: [...g.events, ...f.events, ...shared].sort((a, b) => (a.start < b.start ? -1 : 1)) }
    },
    group: (method, path, body) => {
      if (!group) throw new Error('Sign in to your Veyra account to use group work.')
      return group.call(method, path, body)
    }
  })
  let mcpError = ''
  const mcpApply = async () => {
    mcpError = ''
    try {
      if (appSettings().mcpEnabled) await mcp.start()
      else mcp.stop()
    } catch (e) {
      mcpError = e instanceof Error ? e.message : 'The AI connector couldn’t start.'
    }
  }
  const mcpState = () => {
    const e = mcpEntry()
    return {
      running: mcp.running(),
      port: mcp.port,
      command: e.command,
      args: e.args,
      claude: { path: clientConfigPath('claude'), added: clientHasVeyra('claude') },
      gemini: { path: clientConfigPath('gemini'), added: clientHasVeyra('gemini') },
      ...(mcpError ? { error: mcpError } : {})
    }
  }
  setTimeout(() => void mcpApply(), 1500) // once the database is open
  app.on('will-quit', () => mcp.stop())
  ipcMain.handle('mcp:state', () => mcpState())
  ipcMain.handle('mcp:apply', async () => {
    await mcpApply()
    return mcpState()
  })
  ipcMain.handle('mcp:add', (_e, client: string) =>
    friendly(async () => {
      if (client !== 'claude' && client !== 'gemini') throw new ApiError('Unknown app.')
      if (!mcp.running()) await mcpApply()
      try {
        const file = addToClient(client)
        return { ...mcpState(), file }
      } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : 'Couldn’t change that app’s settings.')
      }
    })
  )
  app.on('will-quit', () => reminders.dispose())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Not while starting up: the update window closes just before the main one opens.
  if (startingUp) return
  if (process.platform !== 'darwin') app.quit()
})

function fakeEvents() {
  const d = (off: number, h?: number, m = 0) => {
    const t = new Date()
    t.setDate(t.getDate() + off)
    if (h === undefined) return t.toLocaleDateString('en-CA')
    t.setHours(h, m, 0, 0)
    return t.toISOString()
  }
  const ev = (id: string, title: string, start: string, end: string, allDay: boolean, calendar: string, color: string) =>
    ({ id, title, start, end, allDay, calendar, color, location: '', link: '' })
  return {
    events: [
      ev('1', 'Biology lecture', d(0, 9), d(0, 10, 30), false, 'University', '#4285f4'),
      ev('2', 'Study group', d(0, 16), d(0, 17), false, 'Personal', '#33b679'),
      ev('3', 'Midterm week', d(2), d(5), true, 'University', '#4285f4'),
      ev('4', 'Calculus tutorial', d(1, 14), d(1, 15), false, 'University', '#4285f4'),
      ev('5', 'Dentist', d(3, 11), d(3, 11, 30), false, 'Personal', '#e67c73')
    ]
  }
}
