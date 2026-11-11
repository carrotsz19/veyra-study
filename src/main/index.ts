import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Rec } from '../shared/types'
import { Store } from './db'
import { Accounts, ApiError, accountDir } from './account'
import { GoogleCalendar, GoogleError } from './gcal'
import { IcalError, IcalFeeds } from './ical'
import { AiError, AiService } from './ai'

// Dev checks: run on a separate profile (sign-in, settings and data).
if (process.env['VEYRA_USERDATA']) app.setPath('userData', process.env['VEYRA_USERDATA'])

let store: Store | null = null
let accounts: Accounts
let google: GoogleCalendar | null = null
let feeds: IcalFeeds | null = null
let ai: AiService | null = null

/** One Google connection per account (or for the no-account data). */
function openGoogle(): void {
  const folder = accounts.folder()
  const file = folder ? join(accountDir(folder), 'google.bin') : join(app.getPath('userData'), 'google-local.bin')
  feeds = new IcalFeeds(folder ? join(accountDir(folder), 'ical.bin') : join(app.getPath('userData'), 'ical-local.bin'))
  ai = new AiService(folder ? join(accountDir(folder), 'ai.bin') : join(app.getPath('userData'), 'ai-local.bin'))
  google = new GoogleCalendar(
    file,
    (since) => db().changesSince(since).filter((r) => r.kind === 'task') as Rec<'task'>[],
    (id) => (id ? ((db().list('subject') as Rec<'subject'>[]).find((s) => s.id === id)?.data.name ?? null) : null)
  )
  google.schedulePush(5000)
}
const gcal = (): GoogleCalendar => google!

function openStore(path: string): void {
  google?.dispose()
  google = null
  feeds?.dispose()
  feeds = null
  ai?.dispose()
  ai = null
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
    throw new Error(e instanceof ApiError || e instanceof GoogleError || e instanceof IcalError || e instanceof AiError ? e.message : 'Something went wrong. Try again.')
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Veyra',
    backgroundColor: '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

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

app.whenReady().then(() => {
  accounts = new Accounts((path) => openStore(path))
  // VEYRA_DB (dev checks) pins one database and skips accounts' choice.
  openStore(process.env['VEYRA_DB'] || accounts.currentDbPath())
  setInterval(() => google?.schedulePush(0), 15 * 60 * 1000)

  ipcMain.handle('db:list', (_e, kind) => db().list(kind))
  ipcMain.handle('db:put', (_e, kind, data, id) => {
    const rec = db().put(kind, data, id)
    if (kind === 'task' || kind === 'subject') google?.schedulePush()
    return rec
  })
  // Synchronous save, used only while the window is closing so the last edit isn't lost.
  ipcMain.on('db:putSync', (e, kind, data, id) => {
    try {
      e.returnValue = db().put(kind, data, id)
      if (kind === 'task') google?.schedulePush()
    } catch {
      e.returnValue = null
    }
  })
  ipcMain.handle('db:remove', (_e, id) => {
    db().remove(id)
    google?.schedulePush()
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
      : Promise.all([gcal().events(from, to), feeds?.events(from, to) ?? { events: [], error: undefined }]).then(([g, f]) => ({
          events: [...g.events, ...f.events].sort((a, b) => (a.start < b.start ? -1 : 1)),
          error: g.error ?? f.error
        }))
  )
  ipcMain.handle('google:sync', () => friendly(() => gcal().push()))
  ipcMain.handle('ai:state', () => ai!.state())
  ipcMain.handle('ai:set', (_e, o) => friendly(async () => ai!.set(o)))
  ipcMain.handle('ai:forget', () => ai!.forget())
  ipcMain.handle('ai:models', (_e, p) => friendly(() => ai!.models(p)))
  ipcMain.handle('ai:pull', (e, model: string) => friendly(() => ai!.pull(model, e.sender)))
  ipcMain.handle('ai:run', (e, id: string, req) => {
    void ai!.run(id, req, e.sender)
  })
  ipcMain.handle('ai:cancel', (_e, id: string) => ai?.cancel(id))
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

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
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
