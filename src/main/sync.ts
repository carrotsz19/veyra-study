/**
 * Personal sync on the desktop: the shared logic (shared/sync-core.ts) over
 * this computer's SQLite store, telling every window about its status.
 */
import { BrowserWindow } from 'electron'
import type { Kind } from '../shared/types'
import { SyncCore } from '../shared/sync-core'
import type { Store } from './db'
import type { GroupClient } from './group'

export class Sync extends SyncCore {
  constructor(store: Store, group: GroupClient, onApplied: (kinds: Kind[], ids: string[]) => void) {
    super(store, group, onApplied, (status) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('sync:status', status)
    })
  }
}
