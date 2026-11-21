import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { Kind, VeyraDb } from '../shared/types'

const db: VeyraDb = {
  list: (kind) => ipcRenderer.invoke('db:list', kind),
  put: (kind, data, id) => ipcRenderer.invoke('db:put', kind, data, id),
  remove: (id) => ipcRenderer.invoke('db:remove', id),
  changesSince: (since) => ipcRenderer.invoke('db:changesSince', since),
  info: () => ipcRenderer.invoke('db:info'),
  /** Records changed by another device (personal sync). */
  onExternal: (cb: (e: { kinds: Kind[]; ids: string[] }) => void) => {
    const h = (_: unknown, e: { kinds: Kind[]; ids: string[] }) => cb(e)
    ipcRenderer.on('db:external', h)
    return () => void ipcRenderer.removeListener('db:external', h)
  }
}

const account = {
  state: () => ipcRenderer.invoke('account:state'),
  refresh: () => ipcRenderer.invoke('account:refresh'),
  signIn: (username: string, password: string) => ipcRenderer.invoke('account:signIn', username, password),
  signUp: (input: { username: string; email: string; password: string; acceptLegal: boolean }) => ipcRenderer.invoke('account:signUp', input),
  signOut: () => ipcRenderer.invoke('account:signOut'),
  continueAsGuest: () => ipcRenderer.invoke('account:guest'),
  legalUrls: () => ipcRenderer.invoke('account:legal'),
  requestReset: (id: string) => ipcRenderer.invoke('account:requestReset', id),
  resetPassword: (id: string, code: string, pw: string) => ipcRenderer.invoke('account:resetPassword', id, code, pw),
  verifyEmail: (code: string) => ipcRenderer.invoke('account:verifyEmail', code),
  resendVerification: () => ipcRenderer.invoke('account:resendVerification'),
  setEmail: (email: string) => ipcRenderer.invoke('account:setEmail', email),
  changePassword: (current: string, next: string) => ipcRenderer.invoke('account:changePassword', current, next)
}

const friends = {
  list: () => ipcRenderer.invoke('friends:list'),
  search: (query: string) => ipcRenderer.invoke('friends:search', query),
  send: (username: string) => ipcRenderer.invoke('friends:send', username),
  respond: (requesterId: string, accept: boolean) => ipcRenderer.invoke('friends:respond', requesterId, accept),
  remove: (otherUserId: string) => ipcRenderer.invoke('friends:remove', otherUserId)
}

const google = {
  state: () => ipcRenderer.invoke('google:state'),
  connect: (id?: string, secret?: string) => ipcRenderer.invoke('google:connect', id, secret),
  addFeed: (url: string, name: string) => ipcRenderer.invoke('google:addFeed', url, name),
  removeFeed: (id: string) => ipcRenderer.invoke('google:removeFeed', id),
  disconnect: () => ipcRenderer.invoke('google:disconnect'),
  setOptions: (o: unknown) => ipcRenderer.invoke('google:options', o),
  events: (from: string, to: string) => ipcRenderer.invoke('google:events', from, to),
  /** Events changed after a background refresh (ask again). */
  onChanged: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('calendar:changed', h)
    return () => void ipcRenderer.removeListener('calendar:changed', h)
  },
  syncNow: () => ipcRenderer.invoke('google:sync')
}

const appApi = {
  /** Interface size, as the browser zoom (keeps popups and menus where they belong). */
  setZoom: (f: number) => webFrame.setZoomFactor(Math.min(1.4, Math.max(0.8, f))),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  exportNotes: (files: { name: string; text: string }[]) => ipcRenderer.invoke('notes:export', files),
  exportFiles: (files: { name: string; ext: string; mime: string; bytes: Uint8Array }[], kindLabel: string) => ipcRenderer.invoke('notes:exportFiles', files, kindLabel),
  exportPdf: (files: { name: string; html: string }[]) => ipcRenderer.invoke('notes:exportPdf', files),
  version: () => ipcRenderer.invoke('app:version'),
  /** Windows 11 can show acrylic or mica behind the app. */
  materialSupported: ipcRenderer.sendSync('app:materialSupported') as boolean,
  setMaterial: (material: string, theme: string) => ipcRenderer.invoke('app:setMaterial', material, theme),
  setStartup: (on: boolean) => ipcRenderer.invoke('app:setStartup', on),
  /** Height of Veyra's own title bar (0 where Windows' is used). */
  titleBar: ipcRenderer.sendSync('app:titleBar') as number,
  /** The title bar's menu commands. */
  win: (cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'fullscreen' | 'close' | 'quit' | 'minimize' | 'maximize') => ipcRenderer.invoke('win:cmd', cmd),
  /** The window buttons this window has ('dots' drawn by Veyra, or Windows' own), and choosing them for next time. */
  windowButtons: ipcRenderer.sendSync('app:windowButtons') as 'dots' | 'windows',
  /** The buttons chosen for the next start (can differ from windowButtons until Veyra restarts). */
  windowButtonsChoice: () => ipcRenderer.sendSync('app:windowButtonsChoice') as 'dots' | 'windows',
  setWindowButtons: (b: 'dots' | 'windows') => ipcRenderer.invoke('app:setWindowButtons', b),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  /** Diagnostics: the technical log on this computer, its folder, and sending it when the person asks. */
  diagRead: () => ipcRenderer.invoke('diag:read'),
  diagOpen: () => ipcRenderer.invoke('diag:open'),
  diagSend: (text: string, note: string) => ipcRenderer.invoke('diag:send', text, note),
  /** A report the app sent by itself, waiting for the person to say what happened. */
  diagAsk: () => ipcRenderer.invoke('diag:ask'),
  diagAnswer: (id: string, note: string) => ipcRenderer.invoke('diag:answer', id, note),
  diagDismiss: () => ipcRenderer.invoke('diag:dismiss'),
  onDiagAsk: (cb: (ask: { id: string; trigger: string; at: number }) => void) => {
    const h = (_: unknown, ask: { id: string; trigger: string; at: number }) => cb(ask)
    ipcRenderer.on('diag:ask', h)
    return () => ipcRenderer.removeListener('diag:ask', h)
  },
  /** Whether the window is active and maximised (for the title bar's buttons). */
  winState: () => ipcRenderer.sendSync('win:state') as { focused: boolean; maximized: boolean },
  /** Full screen: the blurred wallpaper Veyra paints in place of acrylic (null: none). */
  onBackdrop: (cb: (url: string | null) => void) => {
    const h = (_: unknown, url: string | null) => cb(url)
    ipcRenderer.on('win:backdrop', h)
    return () => void ipcRenderer.removeListener('win:backdrop', h)
  },
  onWinState: (cb: (s: { focused: boolean; maximized: boolean }) => void) => {
    const h = (_: unknown, s: { focused: boolean; maximized: boolean }) => cb(s)
    ipcRenderer.on('win:state', h)
    return () => void ipcRenderer.removeListener('win:state', h)
  },
  /** The tray or a reminder asks to show a screen. */
  onNav: (cb: (screen: string) => void) => {
    const h = (_: unknown, screen: string) => cb(screen)
    ipcRenderer.on('app:nav', h)
    return () => void ipcRenderer.removeListener('app:nav', h)
  },
  /** Desktop notification support check, test notification, and click-to-open chat handler. */
  notifyCheck: () => ipcRenderer.invoke('app:notifyCheck') as Promise<{ supported: boolean }>,
  notifyTest: (title?: string, body?: string) => ipcRenderer.invoke('app:notifyTest', title, body) as Promise<{ shown: boolean }>,
  onOpenChat: (cb: (groupId: string) => void) => {
    const h = (_: unknown, groupId: string) => cb(groupId)
    ipcRenderer.on('app:openChat', h)
    return () => void ipcRenderer.removeListener('app:openChat', h)
  }
}

const aiApi = {
  state: () => ipcRenderer.invoke('ai:state'),
  set: (o: unknown) => ipcRenderer.invoke('ai:set', o),
  forget: () => ipcRenderer.invoke('ai:forget'),
  models: (p: string) => ipcRenderer.invoke('ai:models', p),
  pull: (model: string) => ipcRenderer.invoke('ai:pull', model),
  run: (id: string, req: unknown) => ipcRenderer.invoke('ai:run', id, req),
  cancel: (id: string) => ipcRenderer.invoke('ai:cancel', id),
  onEvent: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('ai:event', h)
    return () => ipcRenderer.removeListener('ai:event', h)
  },
  localStatus: () => ipcRenderer.invoke('localai:status'),
  localSetup: (model: string) => ipcRenderer.invoke('localai:setup', model),
  localCancel: () => ipcRenderer.invoke('localai:cancel'),
  onLocalProgress: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('localai:progress', h)
    return () => ipcRenderer.removeListener('localai:progress', h)
  },
  onPull: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('ai:pull', h)
    return () => ipcRenderer.removeListener('ai:pull', h)
  }
}

const groupApi = {
  status: () => ipcRenderer.invoke('group:status'),
  connect: () => ipcRenderer.invoke('group:connect'),
  disconnect: () => ipcRenderer.invoke('group:disconnect'),
  /** Answers { ok, v } or { ok: false, error, status, extra }; the UI's wrapper turns that into a throw. */
  callRaw: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('group:call', method, path, body),
  onStatus: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('group:status', h)
    return () => ipcRenderer.removeListener('group:status', h)
  },
  onChanged: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('group:changed', h)
    return () => ipcRenderer.removeListener('group:changed', h)
  }
}

const updateApi = {
  state: () => ipcRenderer.invoke('update:state'),
  check: () => ipcRenderer.invoke('update:check'),
  download: () => ipcRenderer.invoke('update:download'),
  install: () => ipcRenderer.invoke('update:install'),
  devBuilds: () => ipcRenderer.invoke('update:devBuilds'),
  installDevBuild: (tag: string) => ipcRenderer.invoke('update:installDevBuild', tag),
  unpinDevBuild: () => ipcRenderer.invoke('update:unpinDevBuild'),
  onState: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('update:state', h)
    return () => void ipcRenderer.removeListener('update:state', h)
  }
}

const devBuilderApi = {
  state: () => ipcRenderer.invoke('devBuilder:state'),
  candidates: (fetch?: boolean) => ipcRenderer.invoke('devBuilder:candidates', fetch === true),
  preview: (req: unknown) => ipcRenderer.invoke('devBuilder:preview', req),
  start: (req: unknown) => ipcRenderer.invoke('devBuilder:start', req),
  cancel: () => ipcRenderer.invoke('devBuilder:cancel'),
  clear: () => ipcRenderer.invoke('devBuilder:clear'),
  chooseRepo: () => ipcRenderer.invoke('devBuilder:chooseRepo'),
  onState: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('devBuilder:state', h)
    return () => void ipcRenderer.removeListener('devBuilder:state', h)
  },
  onLog: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('devBuilder:log', h)
    return () => void ipcRenderer.removeListener('devBuilder:log', h)
  }
}

const mcpApi = {
  state: () => ipcRenderer.invoke('mcp:state'),
  apply: () => ipcRenderer.invoke('mcp:apply'),
  add: (client: string) => ipcRenderer.invoke('mcp:add', client)
}

const voiceApi = {
  status: () => ipcRenderer.invoke('voice:status'),
  setup: (model: string) => ipcRenderer.invoke('voice:setup', model),
  cancelSetup: () => ipcRenderer.invoke('voice:cancelSetup'),
  onProgress: (cb: (p: unknown) => void) => {
    const h = (_: unknown, p: unknown) => cb(p)
    ipcRenderer.on('voice:progress', h)
    return () => void ipcRenderer.removeListener('voice:progress', h)
  },
  transcribe: (id: string, wav: Uint8Array, model: string, language: string) => ipcRenderer.invoke('voice:transcribe', id, wav, model, language),
  cancel: (id: string) => ipcRenderer.invoke('voice:cancel', id),
  onTranscribing: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('voice:transcribing', h)
    return () => void ipcRenderer.removeListener('voice:transcribing', h)
  },
  saveRecording: (name: string, mime: string, bytes: Uint8Array) => ipcRenderer.invoke('voice:save', name, mime, bytes)
}

const syncApi = {
  status: () => ipcRenderer.invoke('sync:status'),
  now: () => ipcRenderer.invoke('sync:now'),
  setEnabled: (on: boolean) => ipcRenderer.invoke('sync:set', on),
  setSending: (on: boolean) => ipcRenderer.invoke('sync:sending', on),
  setHistory: (on: boolean) => ipcRenderer.invoke('sync:history', on),
  onStatus: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('sync:status', h)
    return () => ipcRenderer.removeListener('sync:status', h)
  }
}

const driveApi = {
  state: () => ipcRenderer.invoke('drive:state'),
  connect: (read?: boolean) => ipcRenderer.invoke('drive:connect', read),
  setAssistant: (on: boolean) => ipcRenderer.invoke('drive:setAssistant', on),
  search: (query: string, limit?: number) => ipcRenderer.invoke('drive:search', query, limit),
  read: (id: string) => ipcRenderer.invoke('drive:read', id),
  createDoc: (title: string, html: string) => ipcRenderer.invoke('drive:createDoc', title, html),
  trash: (id: string) => ipcRenderer.invoke('drive:trash', id),
  disconnect: () => ipcRenderer.invoke('drive:disconnect'),
  setBackup: (on: boolean) => ipcRenderer.invoke('drive:setBackup', on),
  resetBackup: () => ipcRenderer.invoke('drive:resetBackup'),
  pick: () => ipcRenderer.invoke('drive:pick'),
  saveDoc: (noteId: string, title: string, html: string) => ipcRenderer.invoke('drive:saveDoc', noteId, title, html),
  backup: (files: unknown[], through: number) => ipcRenderer.invoke('drive:backup', files, through)
}

const filesApi = {
  pick: () => ipcRenderer.invoke('files:pick'),
  fromPaths: (paths: string[]) => ipcRenderer.invoke('files:fromPaths', paths),
  fromBytes: (name: string, mime: string, bytes: Uint8Array) => ipcRenderer.invoke('files:fromBytes', name, mime, bytes),
  open: (id: string) => ipcRenderer.invoke('files:open', id),
  reveal: (id: string) => ipcRenderer.invoke('files:reveal', id),
  read: (id: string) => ipcRenderer.invoke('files:read', id),
  /** The path of a dropped file ('' for pasted data, which has none). */
  pathFor: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

/** Saves right away, blocking: only for the moment the window closes. */
const saveNow = (kind: string, data: unknown, id: string) => ipcRenderer.sendSync('db:putSync', kind, data, id)

/** Title bar menus in their own acrylic window (Windows 11). */
const menuApi = {
  supported: () => ipcRenderer.sendSync('menu:supported') as boolean,
  // The app's side
  open: (spec: unknown) => ipcRenderer.send('menu:open', spec),
  close: () => ipcRenderer.send('menu:close', 'asked'),
  justShown: () => ipcRenderer.sendSync('menu:justShown') as boolean,
  onPicked: (cb: (id: string) => void) => {
    const h = (_: unknown, id: string) => cb(id)
    ipcRenderer.on('menu:picked', h)
    return () => void ipcRenderer.removeListener('menu:picked', h)
  },
  onClosed: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('menu:closed', h)
    return () => void ipcRenderer.removeListener('menu:closed', h)
  },
  onStep: (cb: (by: number) => void) => {
    const h = (_: unknown, by: number) => cb(by)
    ipcRenderer.on('menu:step', h)
    return () => void ipcRenderer.removeListener('menu:step', h)
  },
  // The menu window's side
  onRender: (cb: (spec: unknown) => void) => {
    const h = (_: unknown, spec: unknown) => cb(spec)
    ipcRenderer.on('menu:render', h)
    return () => void ipcRenderer.removeListener('menu:render', h)
  },
  size: (w: number, h: number) => ipcRenderer.send('menu:size', w, h),
  pick: (id: string) => ipcRenderer.send('menu:pick', id),
  step: (by: number) => ipcRenderer.send('menu:step', by),
  dismiss: () => ipcRenderer.send('menu:close', 'away')
}

contextBridge.exposeInMainWorld('veyra', {
  menu: menuApi, db, account, friends, google, app: appApi, saveNow, ai: aiApi, group: groupApi, files: filesApi, drive: driveApi, sync: syncApi, voice: voiceApi, mcp: mcpApi, update: updateApi, devBuilder: devBuilderApi, open: (url: string) => ipcRenderer.invoke('app:open', url) })
