import { contextBridge, ipcRenderer } from 'electron'
import type { VeyraDb } from '../shared/types'

const db: VeyraDb = {
  list: (kind) => ipcRenderer.invoke('db:list', kind),
  put: (kind, data, id) => ipcRenderer.invoke('db:put', kind, data, id),
  remove: (id) => ipcRenderer.invoke('db:remove', id),
  changesSince: (since) => ipcRenderer.invoke('db:changesSince', since),
  info: () => ipcRenderer.invoke('db:info')
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

contextBridge.exposeInMainWorld('veyra', { db, account, google, open: (url: string) => ipcRenderer.invoke('app:open', url) })
