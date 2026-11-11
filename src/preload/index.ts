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
  legalUrls: () => ipcRenderer.invoke('account:legal')
}

const google = {
  state: () => ipcRenderer.invoke('google:state'),
  connect: (id?: string, secret?: string) => ipcRenderer.invoke('google:connect', id, secret),
  addFeed: (url: string, name: string) => ipcRenderer.invoke('google:addFeed', url, name),
  removeFeed: (id: string) => ipcRenderer.invoke('google:removeFeed', id),
  disconnect: () => ipcRenderer.invoke('google:disconnect'),
  setOptions: (o: unknown) => ipcRenderer.invoke('google:options', o),
  events: (from: string, to: string) => ipcRenderer.invoke('google:events', from, to),
  syncNow: () => ipcRenderer.invoke('google:sync')
}

const appApi = {
  /** Interface size, as the browser zoom (keeps popups and menus where they belong). */
  setZoom: (f: number) => webFrame.setZoomFactor(Math.min(1.4, Math.max(0.8, f))),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  exportNotes: (files: { name: string; text: string }[]) => ipcRenderer.invoke('notes:export', files),
  version: () => ipcRenderer.invoke('app:version'),
  /** Windows 11 can show acrylic or mica behind the app. */
  materialSupported: ipcRenderer.sendSync('app:materialSupported') as boolean,
  setMaterial: (material: string, theme: string) => ipcRenderer.invoke('app:setMaterial', material, theme),
  setStartup: (on: boolean) => ipcRenderer.invoke('app:setStartup', on),
  /** The tray or a reminder asks to show a screen. */
  onNav: (cb: (screen: string) => void) => {
    const h = (_: unknown, screen: string) => cb(screen)
    ipcRenderer.on('app:nav', h)
    return () => void ipcRenderer.removeListener('app:nav', h)
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

const syncApi = {
  status: () => ipcRenderer.invoke('sync:status'),
  now: () => ipcRenderer.invoke('sync:now'),
  setEnabled: (on: boolean) => ipcRenderer.invoke('sync:set', on),
  onStatus: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('sync:status', h)
    return () => ipcRenderer.removeListener('sync:status', h)
  }
}

const driveApi = {
  state: () => ipcRenderer.invoke('drive:state'),
  connect: () => ipcRenderer.invoke('drive:connect'),
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

contextBridge.exposeInMainWorld('veyra', { db, account, google, app: appApi, saveNow, ai: aiApi, group: groupApi, files: filesApi, drive: driveApi, sync: syncApi, open: (url: string) => ipcRenderer.invoke('app:open', url) })
