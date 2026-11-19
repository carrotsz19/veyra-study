/**
 * window.veyra on Android: what the desktop's main process provides, done on
 * the phone. Typed as Window['veyra'], so anything missing fails to compile.
 * Features that only make sense on a computer (Google sign-in, Drive, local
 * AI, AI apps, the tray) report themselves as off.
 */
import type { Kind } from '@shared/types'
import * as idb from './idb'
import * as acct from './account'
import * as online from './online'
import * as reminders from './reminders'
import * as phoneFiles from './files'
import * as exports from './exports'
import * as updates from './updates'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { registerPlugin } from '@capacitor/core'
/** The app's own bit of Android code (android/.../ScreenPlugin.java). */
const Screen = registerPlugin<{ keepOn(o: { on: boolean }): Promise<void>; bars(o: { color: string; dark: boolean }): Promise<void> }>('Screen')

/** The status and navigation bars take the page's colour (#rrggbb), with light icons when it's dark. */
export const colourBars = (color: string, dark: boolean): Promise<void> => Screen.bars({ color, dark }).catch(() => {}) // older app without it
import { withDefaults } from '@shared/settings'
import { ON_WEB } from '@shared/channel'

type Veyra = Window['veyra']
const unsub = () => () => {}
const onComputer = (what: string) => () => Promise.reject(new Error(`${what} is on the computer app.`))

/* ---------- records ---------- */
type External = (e: { kinds: Kind[]; ids: string[] }) => void
const externals = new Set<External>()
export const emitExternal = (kinds: Kind[], ids: string[]) => externals.forEach((f) => f({ kinds, ids }))

const db: Veyra['db'] = {
  list: (kind) => idb.list(kind),
  put: async (kind, data, id) => {
    const rec = await idb.put(kind, data, id)
    online.sync.schedule()
    if (kind === 'task' || kind === 'settings') reminders.schedule()
    return rec
  },
  remove: async (id) => {
    await idb.remove(id)
    online.sync.schedule()
    reminders.schedule()
  },
  changesSince: (since) => idb.changesSince(since),
  info: async () => ({ deviceId: await idb.deviceId(), dbPath: 'This phone' }),
  onExternal: (cb) => {
    externals.add(cb)
    return () => void externals.delete(cb)
  }
}

/* ---------- account ---------- */
const account: Veyra['account'] = {
  state: async () => acct.state(),
  refresh: () => acct.refresh(),
  signIn: (u, p) => acct.signIn(u, p),
  signUp: (input) => acct.signUp(input),
  signOut: () => acct.signOut(),
  continueAsGuest: async () => acct.continueAsGuest(),
  legalUrls: async () => {
    const b = acct.SERVER + '/'
    return { legal: `${b}?page=legal`, terms: `${b}?page=terms&app=ironlog`, privacy: `${b}?page=privacy&app=ironlog`, terms2: `${b}?page=terms&app=cashline`, privacy2: `${b}?page=privacy&app=cashline` }
  },
  requestReset: (id) => acct.requestReset(id),
  resetPassword: (id, code, pw) => acct.resetPassword(id, code, pw),
  verifyEmail: (code) => acct.verifyEmail(code),
  resendVerification: () => acct.resendVerification(),
  setEmail: (email) => acct.setEmail(email),
  changePassword: (current, next) => acct.changePassword(current, next)
}

const friends: Veyra['friends'] = {
  list: () => acct.friendsList(),
  search: (query) => acct.friendsSearch(query),
  send: (username) => acct.friendsSend(username),
  respond: (requesterId, accept) => acct.friendsRespond(requesterId, accept),
  remove: (otherUserId) => acct.friendsRemove(otherUserId)
}

/* ---------- computer-only features, reported as off ---------- */
const google: Veyra['google'] = {
  state: async () => ({ builtIn: false, customClient: false, feeds: [], connected: false, clientId: '', hasSecret: false, email: '', pushTasks: false, shown: null, calendars: [] }),
  connect: onComputer('Google Calendar'),
  addFeed: onComputer('Calendar links'),
  removeFeed: onComputer('Calendar links'),
  disconnect: onComputer('Google Calendar'),
  setOptions: onComputer('Google Calendar'),
  events: async (from, to) => ({ events: await online.group.deadlines(from, to) }),
  syncNow: async () => ({ pushed: 0 })
}
/** AI on the phone and the website: only Veyra AI (through the Veyra server), or off. */
const AI_KEY = 'veyra.ai'
const aiChoice = (): { provider: 'veyra' | null; model?: string } => {
  try {
    const v = JSON.parse(localStorage.getItem(AI_KEY) ?? '{}')
    return { provider: v.provider === 'veyra' ? 'veyra' : null, model: typeof v.model === 'string' ? v.model : undefined }
  } catch {
    return { provider: null }
  }
}
const aiState = () => {
  const c = aiChoice()
  return { provider: c.provider, ollamaUrl: '', models: c.model ? { veyra: c.model } : {}, hasKey: { anthropic: false, gemini: false, openai: false } }
}
const ai: Veyra['ai'] = {
  state: async () => aiState(),
  set: async (o) => {
    const c = aiChoice()
    if (o.provider !== undefined) {
      if (o.provider !== null && o.provider !== 'veyra') throw new Error('Only Veyra AI works here. The other kinds of AI are in the computer app.')
      c.provider = o.provider
    }
    if (o.model?.provider === 'veyra') c.model = o.model.model
    try {
      localStorage.setItem(AI_KEY, JSON.stringify(c))
    } catch {
      /* storage unavailable */
    }
    return aiState()
  },
  forget: async () => {
    try {
      localStorage.removeItem(AI_KEY)
    } catch {
      /* storage unavailable */
    }
    return aiState()
  },
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
  status: async () => online.group.getStatus(),
  connect: () => online.group.connect(),
  disconnect: async () => {
    online.group.disconnect()
    return online.group.getStatus()
  },
  callRaw: (method, path, body) => online.groupCallRaw(method, path, body),
  onStatus: online.onGroupStatus,
  onChanged: online.onGroupChanged
}
const files: Veyra['files'] = {
  pick: () => phoneFiles.pick(),
  fromPaths: async () => [],
  fromBytes: (name, mime, bytes) => phoneFiles.save(name, mime, bytes),
  open: (id) => phoneFiles.open(id),
  reveal: async () => {},
  read: (id) => phoneFiles.read(id),
  pathFor: () => '',
  url: (id) => phoneFiles.url(id)
}
const drive: Veyra['drive'] = {
  state: async () => ({ builtIn: false, connected: false, email: '', backup: false, backupThrough: 0, backedUp: 0, canPick: false }),
  connect: onComputer('Google Drive'),
  disconnect: onComputer('Google Drive'),
  setBackup: onComputer('Google Drive'),
  saveDoc: onComputer('Google Docs'),
  backup: onComputer('Google Drive'),
  resetBackup: onComputer('Google Drive'),
  pick: onComputer('Google Drive'),
  setAssistant: onComputer('Google Drive'),
  search: onComputer('Google Drive'),
  read: onComputer('Google Drive'),
  createDoc: onComputer('Google Docs'),
  trash: onComputer('Google Drive')
}
const sync: Veyra['sync'] = {
  status: () => online.sync.state(),
  now: () => online.sync.run(),
  setEnabled: (on) => online.sync.setEnabled(on),
  setSending: (on) => online.sync.setSending(on),
  setHistory: (on) => online.sync.setHistory(on),
  onStatus: online.onSyncStatus
}
const voice: Veyra['voice'] = {
  status: async () => ({ engine: false, models: [], choices: [] }),
  setup: onComputer('Transcription'),
  cancelSetup: async () => {},
  onProgress: unsub,
  transcribe: onComputer('Transcription'),
  cancel: async () => {},
  onTranscribing: unsub,
  saveRecording: (name, mime, bytes) => phoneFiles.save(name, mime, bytes)
}
// The website is always the newest version: nothing to update.
const update: Veyra['update'] = ON_WEB
  ? {
      state: async () => ({ supported: false, current: __APP_VERSION__, status: 'idle' }),
      check: async () => ({ supported: false, current: __APP_VERSION__, status: 'idle' }),
      download: async () => ({ supported: false, current: __APP_VERSION__, status: 'idle' }),
      install: async () => {},
      onState: unsub
    }
  : {
  state: () => updates.getState(),
  check: () => updates.check(),
  download: () => updates.download(),
  install: () => updates.install(),
  onState: (cb) => updates.onState(cb)
}
const mcp: Veyra['mcp'] = {
  state: async () => ({ running: false, port: 0, command: '', args: [], claude: { path: '', added: false }, gemini: { path: '', added: false } }),
  apply: async () => ({ running: false, port: 0, command: '', args: [], claude: { path: '', added: false }, gemini: { path: '', added: false } }),
  add: onComputer('AI apps')
}

const appApi: Veyra['app'] = {
  setZoom: (f) => void (document.documentElement.style.zoom = String(Math.min(1.4, Math.max(0.8, f)))),
  exportData: () => exports.exportData(__APP_VERSION__),
  importData: async () => {
    const r = await exports.importData()
    if (r.imported) {
      online.sync.schedule()
      reminders.schedule()
      emitExternal(['subject', 'task', 'note', 'session', 'settings', 'folder', 'noteVersion'], [])
    }
    return r
  },
  openDataFolder: async () => {},
  exportNotes: (files) => exports.exportNotes(files),
  version: async () => __APP_VERSION__,
  materialSupported: false,
  setMaterial: async () => {},
  setStartup: async () => false,
  onNav: (cb) => reminders.onNav(cb),
  timerAlarm: (at, title, body) => reminders.timerAlarm(at, title, body),
  keepAwake: async (on) => {
    try {
      if (ON_WEB) return void (await webWake(on))
      await Screen.keepOn({ on })
    } catch {
      /* older app without the plugin */
    }
  },
  haptic: async (kind) => {
    try {
      await Haptics.impact({ style: kind === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light })
    } catch {
      /* no vibration motor */
    }
  }
}

/** The website: the browser's screen wake lock, while the timer runs. */
let wake: { release(): Promise<void> } | null = null
async function webWake(on: boolean) {
  const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
  if (on && !wake && nav.wakeLock) wake = await nav.wakeLock.request('screen')
  else if (!on && wake) {
    await wake.release()
    wake = null
  }
}

export async function installBridge(): Promise<void> {
  await acct.start()
  await phoneFiles.startFiles()
  online.create()
  const veyra: Veyra = {
    db,
    account,
    friends,
    google,
    ai,
    group,
    files,
    drive,
    sync,
    voice,
    mcp,
    update,
    app: appApi,
    // No synchronous saving on Android; the editor saves when the app is put away instead.
    saveNow: () => {},
    open: async (url) => void window.open(url, '_blank')
  }
  window.veyra = veyra
  // What other devices change shows up on the screens straight away.
  online.setOnApplied((kinds, ids) => {
    emitExternal(kinds, ids)
    if (kinds.includes('task')) reminders.schedule()
  })
  reminders.startReminders()
  online.startOnline()
  // Look for a new version now and then (Settings → Software update can turn this off).
  if (!ON_WEB) void idb.list('settings').then((r) => {
    if (withDefaults((r[0]?.data as object) ?? {}).checkUpdatesAtStart) updates.checkAtStart(() => {})
  })
}
