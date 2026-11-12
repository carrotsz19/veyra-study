import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'

/**
 * Menus with real acrylic. Inside Veyra's own see-through window the browser
 * can't blur what's behind an element (backdrop-filter is skipped there), so
 * the title bar's menus open in a small window of their own whose backdrop is
 * Windows' acrylic: Windows blurs whatever is behind it, like its own menus.
 *
 * One window, made once and reused, so menus open at once. The app asks for a
 * menu at a spot; the menu window draws it and says how big it is; then it's
 * placed and shown. Picking, Esc, ← → (next menu) and clicking away go back
 * to the app.
 */
let pop: BrowserWindow | null = null
let owner: BrowserWindow | null = null
let pending: { x: number; y: number } | null = null
let shownAt = 0

type Load = (w: BrowserWindow, hash: string) => void

export function setupMenus(main: BrowserWindow, load: Load, preload: string, materialOk: boolean): void {
  if (!materialOk) return
  owner = main
  pop = new BrowserWindow({
    parent: main,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    width: 240,
    height: 200,
    webPreferences: { preload, contextIsolation: true, sandbox: false }
  })
  pop.setMenu(null)
  load(pop, 'menu')
  // Clicking anywhere else closes it (the app hears so, to un-highlight its button).
  pop.on('blur', () => hide('away'))
  main.on('closed', () => {
    pop?.destroy()
    pop = null
  })
  main.on('move', () => hide('away'))
  main.on('resize', () => hide('away'))
}

function hide(why: 'away' | 'picked' | 'asked') {
  if (!pop || pop.isDestroyed() || !pop.isVisible()) return
  pop.hide()
  if (why !== 'asked') owner?.webContents.send('menu:closed')
}

export const menusAvailable = () => !!pop

ipcMain.on('menu:supported', (e) => (e.returnValue = !!pop))
// The app: show these items below a point (CSS pixels in the app's window).
ipcMain.on('menu:open', (_e: IpcMainEvent, spec: { x: number; y: number; items: unknown[]; dark: boolean; accent: string; zoom: number }) => {
  if (!pop || !owner) return
  const b = owner.getContentBounds()
  const z = owner.webContents.getZoomFactor()
  pending = { x: Math.round(b.x + spec.x * z), y: Math.round(b.y + spec.y * z) }
  pop.webContents.setZoomFactor(z)
  pop.webContents.send('menu:render', spec)
})
// The menu window: this is how big it came out.
ipcMain.on('menu:size', (_e, w: number, h: number) => {
  if (!pop || !pending) return
  const z = pop.webContents.getZoomFactor()
  pop.setBounds({ x: pending.x, y: pending.y, width: Math.ceil(w * z), height: Math.ceil(h * z) })
  pending = null
  if (!pop.isVisible()) {
    pop.show()
    shownAt = Date.now()
  }
  pop.focus()
})
ipcMain.on('menu:pick', (_e, id: string) => {
  hide('picked')
  owner?.webContents.send('menu:picked', id)
})
// ← / → in the menu: the app opens the next one along.
ipcMain.on('menu:step', (_e, by: number) => owner?.webContents.send('menu:step', by))
ipcMain.on('menu:close', (_e, why: 'asked' | 'away') => hide(why === 'away' ? 'away' : 'asked'))
ipcMain.on('menu:justShown', (e) => (e.returnValue = Date.now() - shownAt < 250))
