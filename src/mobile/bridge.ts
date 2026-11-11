/**
 * window.veyra on Android: what the desktop's main process provides, done on
 * the phone. Typed as Window['veyra'], so anything missing fails to compile.
 * Features that only make sense on a computer (Google sign-in, Drive, local
 * AI, AI apps, the tray) report themselves as off.
 */
import type { AccountState, Kind } from '@shared/types'
import * as idb from './idb'

type Veyra = Window['veyra']
const unsub = () => () => {}
const onComputer = (what: string) => () => Promise.reject(new Error(`${what} is on the computer app.`))

/* ---------- records ---------- */
type External = (e: { kinds: Kind[]; ids: string[] }) => void
const externals = new Set<External>()
export const emitExternal = (kinds: Kind[], ids: string[]) => externals.forEach((f) => f({ kinds, ids }))

const db: Veyra['db'] = {
  list: (kind) => idb.list(kind),
  put: (kind, data, id) => idb.put(kind, data, id),
  remove: (id) => idb.remove(id),
  changesSince: (since) => idb.changesSince(since),
  info: async () => ({ deviceId: await idb.deviceId(), dbPath: 'This phone' }),
  onExternal: (cb) => {
    externals.add(cb)
    return () => void externals.delete(cb)
  }
}

/* ---------- account (guest for now) ---------- */
const MODE = 'veyra.mode'
const accountState = (): AccountState => {
  let mode: AccountState['mode'] = 'none'
  try {
    mode = localStorage.getItem(MODE) === 'guest' ? 'guest' : 'none'
  } catch {
    /* storage unavailable */
  }
  return { mode, user: null, server: 'https://veyra.igreenrobotz.workers.dev' }
}
const account: Veyra['account'] = {
  state: async () => accountState(),
  refresh: async () => accountState(),
  signIn: () => Promise.reject(new Error('Signing in on the phone is coming next. Use Veyra Study without an account for now.')),
  signUp: () => Promise.reject(new Error('Create your account on the computer app for now.')),
  signOut: async () => {
    localStorage.removeItem(MODE)
    return accountState()
  },
  continueAsGuest: async () => {
    localStorage.setItem(MODE, 'guest')
    return accountState()
  },
  legalUrls: async () => {
    const b = 'https://veyra.igreenrobotz.workers.dev/'
    return { legal: `${b}?page=legal`, terms: `${b}?page=terms&app=ironlog`, privacy: `${b}?page=privacy&app=ironlog`, terms2: `${b}?page=terms&app=cashline`, privacy2: `${b}?page=privacy&app=cashline` }
  }
}

/* ---------- computer-only features, reported as off ---------- */
const google: Veyra['google'] = {
  state: async () => ({ builtIn: false, customClient: false, feeds: [], connected: false, clientId: '', hasSecret: false, email: '', pushTasks: false, shown: null, calendars: [] }),
  connect: onComputer('Google Calendar'),
  addFeed: onComputer('Calendar links'),
  removeFeed: onComputer('Calendar links'),
  disconnect: onComputer('Google Calendar'),
  setOptions: onComputer('Google Calendar'),
  events: async () => ({ events: [] }),
  syncNow: async () => ({ pushed: 0 })
}
const ai: Veyra['ai'] = {
  state: async () => ({ provider: null, ollamaUrl: '', models: {}, hasKey: { anthropic: false, gemini: false, openai: false } }),
  set: onComputer('AI'),
  forget: onComputer('AI'),
  models: async () => [],
  pull: onComputer('AI'),
  run: onComputer('AI'),
  cancel: async () => {},
  onEvent: unsub,
  onPull: unsub,
  localStatus: onComputer('Local AI'),
  localSetup: onComputer('Local AI'),
  localCancel: async () => {},
  onLocalProgress: unsub
}
const group: Veyra['group'] = {
  status: async () => ({ state: 'signed-out', me: null, error: '' }),
  connect: async () => ({ state: 'signed-out', me: null, error: '' }),
  disconnect: async () => ({ state: 'signed-out', me: null, error: '' }),
  callRaw: async () => ({ ok: false, error: 'Sign in to use group work.', status: 401 }),
  onStatus: unsub,
  onChanged: unsub
}
const files: Veyra['files'] = {
  pick: onComputer('Attaching files'),
  fromPaths: onComputer('Attaching files'),
  fromBytes: onComputer('Attaching files'),
  open: onComputer('Opening files'),
  reveal: async () => {},
  read: onComputer('Files'),
  pathFor: () => ''
}
const drive: Veyra['drive'] = {
  state: async () => ({ builtIn: false, connected: false, email: '', backup: false, backupThrough: 0, backedUp: 0, canPick: false }),
  connect: onComputer('Google Drive'),
  disconnect: onComputer('Google Drive'),
  setBackup: onComputer('Google Drive'),
  saveDoc: onComputer('Google Docs'),
  backup: onComputer('Google Drive'),
  resetBackup: onComputer('Google Drive'),
  pick: onComputer('Google Drive')
}
const sync: Veyra['sync'] = {
  status: async () => ({ enabled: false, state: 'idle', error: '' }),
  now: async () => ({ enabled: false, state: 'idle', error: '' }),
  setEnabled: async () => ({ enabled: false, state: 'idle', error: '' }),
  onStatus: unsub
}
const voice: Veyra['voice'] = {
  status: async () => ({ engine: false, models: [], choices: [] }),
  setup: onComputer('Transcription'),
  cancelSetup: async () => {},
  onProgress: unsub,
  transcribe: onComputer('Transcription'),
  cancel: async () => {},
  onTranscribing: unsub,
  saveRecording: onComputer('Recording')
}
const mcp: Veyra['mcp'] = {
  state: async () => ({ running: false, port: 0, command: '', args: [], claude: { path: '', added: false }, gemini: { path: '', added: false } }),
  apply: async () => ({ running: false, port: 0, command: '', args: [], claude: { path: '', added: false }, gemini: { path: '', added: false } }),
  add: onComputer('AI apps')
}

const appApi: Veyra['app'] = {
  setZoom: (f) => void (document.documentElement.style.zoom = String(Math.min(1.4, Math.max(0.8, f)))),
  exportData: onComputer('Export'),
  importData: onComputer('Import'),
  openDataFolder: async () => {},
  exportNotes: onComputer('Exporting notes'),
  version: async () => '1.0.0',
  materialSupported: false,
  setMaterial: async () => {},
  setStartup: async () => false,
  onNav: unsub
}

export function installBridge(): void {
  const veyra: Veyra = {
    db,
    account,
    google,
    ai,
    group,
    files,
    drive,
    sync,
    voice,
    mcp,
    app: appApi,
    // No synchronous saving on Android; the editor saves when the app is put away instead.
    saveNow: () => {},
    open: async (url) => void window.open(url, '_blank')
  }
  window.veyra = veyra
}
