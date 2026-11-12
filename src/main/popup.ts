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
  // A right-click menu closing isn't the title bar's business.
  if (ctxPick) {
    if (why !== 'picked') ctxPick = null
    return
  }
  if (why !== 'asked') owner?.webContents.send('menu:closed')
}

export const menusAvailable = () => !!pop

ipcMain.on('menu:supported', (e) => (e.returnValue = !!pop))
// The app: show these items below a point (CSS pixels in the app's window).
ipcMain.on('menu:open', (_e: IpcMainEvent, spec: { x: number; y: number; items: unknown[]; dark: boolean; accent: string; zoom: number }) => {
  if (!pop || !owner) return
  ctxPick = null
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
  if (ctxPick) {
    const pick = ctxPick
    ctxPick = null
    pick(id)
    owner?.focus()
    return
  }
  owner?.webContents.send('menu:picked', id)
})
// ← / → in the menu: the app opens the next one along.
ipcMain.on('menu:step', (_e, by: number) => !ctxPick && owner?.webContents.send('menu:step', by))
ipcMain.on('menu:close', (_e, why: 'asked' | 'away') => hide(why === 'away' ? 'away' : 'asked'))
ipcMain.on('menu:justShown', (e) => (e.returnValue = Date.now() - shownAt < 250))

/* ---------- right-click in text: spelling suggestions, then Cut / Copy / Paste ---------- */
let ctxPick: ((id: string) => void) | null = null
type CtxItem = { id: string; label: string; keys?: string } | { sep: true }

/** Right-click menus for text, in the same acrylic menu window (or Windows' own menu without it). */
export function setupTextMenu(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('context-menu', async (_e, p) => {
    const items: CtxItem[] = []
    const run = new Map<string, () => void>()
    const add = (id: string, label: string, fn: () => void, keys?: string) => {
      items.push({ id, label, keys })
      run.set(id, fn)
    }
    // Notes check their own spelling (renderer components/notes/spelling.ts); other fields use Chromium's.
    let own: { word: string; suggestions: string[] } | null = null
    if (p.isEditable && !p.misspelledWord) {
      try {
        const z = wc.getZoomFactor()
        own = await wc.executeJavaScript(`window.__veyraSpellAt ? window.__veyraSpellAt(${p.x / z}, ${p.y / z}) : null`)
      } catch {
        own = null
      }
    }
    if (own) {
      own.suggestions.forEach((w, i) => add(`fix${i}`, w, () => void wc.executeJavaScript(`window.__veyraSpellFix(${JSON.stringify(w)})`).catch(() => {})))
      if (!own.suggestions.length) items.push({ id: 'none', label: 'No spelling suggestions' })
      add('learn', `Add “${own.word}” to dictionary`, () => void wc.executeJavaScript('window.__veyraSpellLearn()').catch(() => {}))
      items.push({ sep: true })
    } else if (p.misspelledWord) {
      p.dictionarySuggestions.slice(0, 5).forEach((w, i) => add(`fix${i}`, w, () => wc.replaceMisspelling(w)))
      if (!p.dictionarySuggestions.length) items.push({ id: 'none', label: 'No spelling suggestions' })
      add('learn', `Add “${p.misspelledWord}” to dictionary`, () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord))
      items.push({ sep: true })
    }
    const f = p.editFlags
    if (p.isEditable) {
      if (f.canUndo) add('undo', 'Undo', () => wc.undo(), 'Ctrl+Z')
      if (f.canRedo) add('redo', 'Redo', () => wc.redo(), 'Ctrl+Y')
      if (f.canUndo || f.canRedo) items.push({ sep: true })
      if (f.canCut && p.selectionText) add('cut', 'Cut', () => wc.cut(), 'Ctrl+X')
      if (f.canCopy && p.selectionText) add('copy', 'Copy', () => wc.copy(), 'Ctrl+C')
      if (f.canPaste) add('paste', 'Paste', () => wc.paste(), 'Ctrl+V')
      if (f.canSelectAll) add('all', 'Select all', () => wc.selectAll(), 'Ctrl+A')
    } else if (p.selectionText.trim()) {
      add('copy', 'Copy', () => wc.copy(), 'Ctrl+C')
    }
    while (items.length && 'sep' in items[items.length - 1]) items.pop()
    if (!items.length) return

    // Without the acrylic window: Windows' own menu.
    if (!pop || pop.isDestroyed()) {
      const { Menu } = await import('electron')
      Menu.buildFromTemplate(
        items.map((it) => ('sep' in it ? { type: 'separator' as const } : { label: it.label, enabled: run.has(it.id), click: () => run.get(it.id)?.() }))
      ).popup({ window: win })
      return
    }
    let look: [string, boolean] = ['#b5502f', false]
    try {
      look = await wc.executeJavaScript(`[getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), document.documentElement.classList.contains('dark')]`)
    } catch {
      /* default look */
    }
    const b = win.getContentBounds()
    pending = { x: Math.round(b.x + p.x), y: Math.round(b.y + p.y) }
    ctxPick = (id) => run.get(id)?.()
    pop.webContents.setZoomFactor(wc.getZoomFactor())
    pop.webContents.send('menu:render', { x: p.x, y: p.y, items, dark: look[1], accent: look[0] || '#b5502f', zoom: wc.getZoomFactor() })
  })
}
