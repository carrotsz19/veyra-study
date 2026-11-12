import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import iconPath from '../../resources/icon.png?asset'
import trayPath from '../../resources/tray@2x.png?asset'
import { Reminders } from './reminders'
import { checkNow, downloadNow, installNow, installReady, keepUpToDate, lookForUpdate, takeHiddenFlag, updateAtStart, updateState } from './updater'
import { withDefaults } from '../shared/settings'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
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

// Dev checks: VEYRA_FAKE_MIC=1 records a test tone instead of the real microphone.
if (process.env['VEYRA_FAKE_MIC']) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
// Dev checks: run on a separate profile (sign-in, settings and data).
// Otherwise always %APPDATA%eyra-study: the installed app is named "Veyra Study", and its data
// must stay where the app has always kept it.
if (process.env['VEYRA_USERDATA']) app.setPath('userData', process.env['VEYRA_USERDATA'])
else app.setPath('userData', join(app.getPath('appData'), 'veyra-study'))

// One Veyra at a time: opening it again shows the one already running (in the tray, say).
if (!app.requestSingleInstanceLock()) app.quit()
// Opening Veyra again (Start menu, taskbar): install a downloaded update first if there is one.
app.on('second-instance', () => {
  if (installReady(false)) return
  showWindow()
})
// Packaged builds have a Start menu shortcut with this id, which Windows needs for notifications.
if (app.isPackaged && process.platform === 'win32') app.setAppUserModelId('app.veyra.study')

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
  // Back from the tray: a good moment to look for an update (at most every half hour).
  void lookForUpdate()
}

// Attachments are shown through veyra-file:// (registered before the app is ready).
registerFileScheme()

let store: Store | null = null
let accounts: Accounts
let google: GoogleCalendar | null = null
let feeds: IcalFeeds | null = null
let ai: AiService | null = null
let group: GroupClient | null = null
let drive: GoogleDrive | null = null
let sync: Sync | null = null
const localAi = new LocalAi()
const whisper = new Whisper()
app.on('will-quit', () => whisper.stopAll())
const files = new Files(() => (accounts ? accounts.folder() : null))
app.on('will-quit', () => localAi.stop())

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
  drive = new GoogleDrive(folder ? join(accountDir(folder), 'drive.bin') : join(app.getPath('userData'), 'drive-local.bin'), files)
  group = new GroupClient(folder ? join(accountDir(folder), 'group.bin') : join(app.getPath('userData'), 'group-local.bin'), () => accounts.credentials())
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
function windowPrefs(): { material: Material; theme: 'system' | 'light' | 'dark' } {
  try {
    const j = JSON.parse(readFileSync(prefsFile(), 'utf8'))
    return { material: ['solid', 'acrylic', 'mica'].includes(j.material) ? j.material : 'acrylic', theme: ['light', 'dark'].includes(j.theme) ? j.theme : 'system' }
  } catch {
    return { material: 'acrylic', theme: 'system' }
  }
}
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
  if (!ownTitleBar) return
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setTitleBarOverlay(overlay())
    } catch {
      /* a window without the overlay (the update splash) */
    }
  }
}
nativeTheme.on('updated', refreshTitleBar)

function applyMaterial(win: BrowserWindow, material: Material): void {
  barMaterial = material
  if (!materialSupported) return
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
    title: 'Veyra',
    // See-through (acrylic / mica) when chosen in Appearance; the page paints the tint.
    ...(() => {
      const p = windowPrefs()
      nativeTheme.themeSource = p.theme
      return materialSupported && p.material !== 'solid' ? { backgroundColor: '#00000000', backgroundMaterial: p.material } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#15140f' : '#f7f7f5' }
    })(),
    autoHideMenuBar: true,
    ...(ownTitleBar ? (() => {
      barMaterial = windowPrefs().material
      return { titleBarStyle: 'hidden' as const, titleBarOverlay: overlay() }
    })() : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWin = win
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

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (process.env['VEYRA_ROUTE'] ? '#' + process.env['VEYRA_ROUTE'] : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: process.env['VEYRA_ROUTE'], query: process.env['VEYRA_THEME'] ? { theme: process.env['VEYRA_THEME'] } : undefined })
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
  const noSync = { enabled: false, state: 'idle', error: '' }
  ipcMain.handle('sync:status', () => sync?.state() ?? noSync)
  ipcMain.handle('sync:now', () => sync?.run() ?? noSync)
  ipcMain.handle('sync:set', (_e, on: boolean) => sync?.setEnabled(!!on) ?? noSync)
  const gdrive = (): GoogleDrive => {
    if (!drive) throw new DriveError('Google Drive isn’t ready yet.')
    return drive
  }
  ipcMain.handle('drive:state', () => friendly(async () => gdrive().state()))
  ipcMain.handle('drive:connect', () => friendly(() => gdrive().connect()))
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
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || typeof path !== 'string' || !/^\/[A-Za-z0-9\-_/?=&%.@]*$/.test(path) || path.includes('..') || path.startsWith('/session') || path.startsWith('/poll'))
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
    try {
      writeFileSync(prefsFile(), JSON.stringify({ material: m, theme: nativeTheme.themeSource }))
    } catch {
      /* not fatal */
    }
    for (const w of BrowserWindow.getAllWindows()) applyMaterial(w, m)
    barMaterial = m
    refreshTitleBar()
  })
  ipcMain.on('app:titleBar', (e) => (e.returnValue = ownTitleBar ? TITLE_BAR_H : 0))
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
      case 'close': return win?.close()
      case 'quit': return app.quit()
    }
  })
  ipcMain.handle('update:state', (e) => updateState(e.sender))
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:download', () => downloadNow())
  ipcMain.handle('update:install', () => installNow())
  ipcMain.handle('app:version', () => app.getVersion())
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
    const kinds = new Set(['subject', 'task', 'note', 'session', 'settings'])
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
  ipcMain.handle('app:open', (_e, url: string) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
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
  keepUpToDate(() => appSettings().checkUpdatesAtStart)
  if (!process.env['VEYRA_SCREENSHOT']) {
    tray = new Tray(nativeImage.createFromPath(trayPath).resize({ width: 16, height: 16 }))
    tray.setToolTip('Veyra Study')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Veyra Study', click: () => showWindow() },
        { label: 'Today', click: () => showWindow('today') },
        { label: 'Tasks', click: () => showWindow('tasks') },
        { type: 'separator' },
        { label: 'Quit Veyra Study', click: () => app.quit() }
      ])
    )
    tray.on('click', () => showWindow())
  }
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
