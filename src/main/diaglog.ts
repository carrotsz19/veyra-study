/**
 * Diagnostics: a small technical log on this computer, so a problem like a window
 * vanishing can be traced afterwards. It records app events only (start and quit,
 * windows, crashes, sleep and displays, update checks, errors), never notes, tasks,
 * messages or account details, and every line goes through redact() first.
 *
 * Kept in <userData>/logs: diagnostics.log, rolled over to diagnostics.1.log at
 * about 1 MB, so it never holds more than ~2 MB. Nothing leaves the computer unless
 * the person presses Send in Settings → Data & privacy (see diag:send in index.ts).
 */
import { app, powerMonitor, screen, type BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { release, userInfo } from 'node:os'
import { redact } from '../shared/redact'
import { runEndings } from '../shared/diagruns'

const MAX = 1024 * 1024
let dir = ''
let user = ''

const file = () => join(dir, 'diagnostics.log')
const older = () => join(dir, 'diagnostics.1.log')

const fmt = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? ` | ${v.stack.split('\n').slice(1, 6).map((l) => l.trim()).join(' | ')}` : ''}`
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v
  return JSON.stringify(v)
}

/** Listeners told about problems worth a report (crashes, a lost window), for automatic sending. */
const problemListeners = new Set<(what: string) => void>()
export const onProblem = (fn: (what: string) => void) => problemListeners.add(fn)
/** Logs a problem and tells the listeners. */
export function problem(event: string, fields: Record<string, unknown> = {}): void {
  diag(event, fields)
  for (const fn of problemListeners) {
    try {
      fn(event)
    } catch {
      /* never in the way */
    }
  }
}

/** Adds one line: the time, what happened, and a few key=value details. */
export function diag(event: string, fields: Record<string, unknown> = {}): void {
  if (!dir) return
  try {
    const details = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(' ')
    const line = redact(`${new Date().toISOString()} ${event}${details ? ' ' + details : ''}`, user).slice(0, 2000)
    if (existsSync(file()) && statSync(file()).size > MAX) renameSync(file(), older())
    appendFileSync(file(), line + '\n')
  } catch {
    /* diagnostics never get in the way */
  }
}

/** Everything kept, oldest first. */
export function readDiag(): string {
  if (!dir) return ''
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  return read(older()) + read(file())
}

/** The newest part of the log, at most `max` characters, starting at a whole line. */
export function recentDiag(max: number): string {
  const all = readDiag()
  if (all.length <= max) return all
  const cut = all.slice(-max)
  return cut.slice(cut.indexOf('\n') + 1)
}

let badRunsInARow = 0
/** How many of the runs just before this one ended unexpectedly, in a row. */
export const crashedRunsInARow = () => badRunsInARow

/** The log's folder, for "Open the data folder"-style links. */
export const diagDir = () => dir

/** Call once, after userData is set and before the app is ready. */
export function initDiag(): void {
  try {
    dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    try {
      user = userInfo().username
    } catch {
      user = ''
    }
  } catch {
    dir = ''
    return
  }
  // How did the earlier runs end? (shared/diagruns.ts: a "quit" or Windows shutting down is clean.)
  const ended = runEndings(readDiag())
  const endedBadly = ended.lastEndedBadly
  const lastLine = ended.lastLine
  badRunsInARow = ended.badRunsInARow
  diag('start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    os: `${process.platform} ${release()}`,
    arch: process.arch,
    packaged: app.isPackaged,
    hidden: process.argv.includes('--hidden')
  })
  if (endedBadly) {
    const last = lastLine.replace(/^\S+ /, '').slice(0, 120)
    // Told to listeners once the app is ready (they're added during start-up).
    app.whenReady().then(() => problem('last run ended unexpectedly', { lastEvent: last }))
  }

  // Errors in the main process. The Monitor event only watches: Electron's own crash handling is unchanged.
  process.on('uncaughtExceptionMonitor', (e, origin) => problem('main error', { origin, error: e }))
  process.on('unhandledRejection', (e) => {
    diag('main unhandled rejection', { error: e })
    console.error('Unhandled rejection in the main process:', e)
  })

  app.on('second-instance', () => diag('second launch'))
  app.on('render-process-gone', (_e, wc, d) => {
    const fields = { reason: d.reason, exitCode: d.exitCode, url: wc.getURL().replace(/^.*app\.asar/, '').slice(0, 80) }
    if (d.reason === 'clean-exit') diag('screen process gone', fields)
    else problem('screen process gone', fields)
  })
  app.on('child-process-gone', (_e, d) => {
    const fields = { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name }
    if (d.reason === 'clean-exit' || d.reason === 'killed') diag('helper process gone', fields)
    else problem('helper process gone', fields)
  })
  app.on('before-quit', () => diag('quitting'))
  app.on('will-quit', () => diag('quit'))

  app.whenReady().then(() => {
    diag('ready', { displays: describeDisplays() })
    // Sleep, lock and display changes: likely suspects when windows go missing.
    for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown', 'user-did-become-active', 'user-did-resign-active'] as const) powerMonitor.on(ev as 'suspend', () => diag(`system ${ev}`))
    screen.on('display-added', () => diag('display added', { displays: describeDisplays() }))
    screen.on('display-removed', () => diag('display removed', { displays: describeDisplays() }))
    screen.on('display-metrics-changed', (_e, _d, changed) => diag('display changed', { what: changed.join(','), displays: describeDisplays() }))
  })
}

function describeDisplays(): string {
  try {
    return screen
      .getAllDisplays()
      .map((d) => `${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}*${d.scaleFactor}`)
      .join(' ')
  } catch {
    return '?'
  }
}

/** Follows one window's life: shown, hidden, closed, hung. */
export function trackWindow(win: BrowserWindow, name: string): void {
  const id = win.id
  diag('window created', { name, id })
  const say = (event: string) => () => diag(`window ${event}`, { name, id })
  win.once('ready-to-show', say('ready'))
  win.on('show', say('shown'))
  win.on('hide', say('hidden'))
  win.on('minimize', say('minimized'))
  win.on('restore', say('restored'))
  win.on('unresponsive', () => problem('window not responding', { name, id }))
  win.on('responsive', say('responding again'))
  win.on('closed', say('closed'))
  // Windows signing out, restarting or turning off with Veyra open: Electron skips its quit events
  // then, so this line is what marks the run as ended cleanly (shared/diagruns.ts).
  if (name === 'main') win.on('session-end', (e) => diag('system shutdown', { reasons: (e as unknown as { reasons?: string[] }).reasons?.join(',') }))
  const wc = win.webContents
  wc.on('did-fail-load', (_e, code, desc) => diag('window failed to load', { name, id, code, desc }))
  wc.on('preload-error', (_e, _p, error) => diag('window preload error', { name, id, error }))
  wc.on('console-message', (e) => {
    // Only that the screen hit an error, and where in the app's code: never the message itself,
    // which could quote what's on screen (a note's text, a title).
    const ev = e as unknown as { level?: string | number; sourceId?: string; lineNumber?: number }
    if (ev.level === 'error' || ev.level === 3) diag('screen error', { name, at: `${String(ev.sourceId ?? '').replace(/^.*[\/]/, '')}:${ev.lineNumber ?? '?'}` })
  })
}

/** What Electron believes about a window: the detail that explained the lost-window hang. */
export function windowFacts(win: BrowserWindow | null): string {
  if (!win || win.isDestroyed()) return 'none'
  try {
    const b = win.getBounds()
    return `visible=${win.isVisible()} focused=${win.isFocused()} minimized=${win.isMinimized()} bounds=${b.x},${b.y},${b.width}x${b.height}`
  } catch (e) {
    return `error ${String(e)}`
  }
}
