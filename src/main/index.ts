import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { Store } from './db'

let store: Store

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
  store = new Store(process.env['VEYRA_DB'] || join(app.getPath('userData'), 'veyra.db'))

  ipcMain.handle('db:list', (_e, kind) => store.list(kind))
  ipcMain.handle('db:put', (_e, kind, data, id) => store.put(kind, data, id))
  ipcMain.handle('db:remove', (_e, id) => store.remove(id))
  ipcMain.handle('db:changesSince', (_e, since) => store.changesSince(since))
  ipcMain.handle('db:info', () => ({ deviceId: store.deviceId, dbPath: store.path }))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
