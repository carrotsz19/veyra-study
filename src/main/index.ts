import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { Rec } from '../shared/types'
import { Store } from './db'
import { Accounts, ApiError, accountDir } from './account'
import { GoogleCalendar, GoogleError } from './gcal'

// Dev checks: run on a separate profile (sign-in, settings and data).
if (process.env['VEYRA_USERDATA']) app.setPath('userData', process.env['VEYRA_USERDATA'])

let store: Store | null = null
let accounts: Accounts
let google: GoogleCalendar | null = null

/** One Google connection per account (or for the no-account data). */
function openGoogle(): void {
  const folder = accounts.folder()
  const file = folder ? join(accountDir(folder), 'google.bin') : join(app.getPath('userData'), 'google-local.bin')
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
    throw new Error(e instanceof ApiError || e instanceof GoogleError ? e.message : 'Something went wrong. Try again.')
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
  ipcMain.handle('google:state', () => gcal().state())
  ipcMain.handle('google:connect', (_e, id: string, secret: string) => friendly(() => gcal().connect(id, secret)))
  ipcMain.handle('google:disconnect', () => friendly(() => gcal().disconnect()))
  ipcMain.handle('google:options', (_e, o) => friendly(() => gcal().setOptions(o)))
  ipcMain.handle('google:events', (_e, from: string, to: string) =>
    // Dev checks: VEYRA_FAKE_GOOGLE=1 shows sample events without a Google account.
    process.env['VEYRA_FAKE_GOOGLE'] ? fakeEvents() : gcal().events(from, to)
  )
  ipcMain.handle('google:sync', () => friendly(() => gcal().push()))
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
