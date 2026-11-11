import { contextBridge, ipcRenderer } from 'electron'
import type { VeyraDb } from '../shared/types'

const db: VeyraDb = {
  list: (kind) => ipcRenderer.invoke('db:list', kind),
  put: (kind, data, id) => ipcRenderer.invoke('db:put', kind, data, id),
  remove: (id) => ipcRenderer.invoke('db:remove', id),
  changesSince: (since) => ipcRenderer.invoke('db:changesSince', since),
  info: () => ipcRenderer.invoke('db:info')
}

contextBridge.exposeInMainWorld('veyra', { db })
