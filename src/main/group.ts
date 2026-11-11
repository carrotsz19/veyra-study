/**
 * Group work on the desktop: the shared client (shared/group-core.ts), with
 * its session encrypted on disk by the OS keychain and its events sent to
 * the windows that asked.
 */
import { safeStorage, type WebContents } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DEFAULT_RELAY, GroupCore, type Credentials, type GroupSaved } from '../shared/group-core'

export { GroupError } from '../shared/group-core'
export const RELAY_URL = (process.env['VEYRA_RELAY'] || DEFAULT_RELAY).replace(/\/$/, '')

export class GroupClient extends GroupCore {
  private listeners = new Set<WebContents>()

  constructor(file: string, credentials: () => Credentials) {
    let self: GroupClient | null = null
    super({
      relay: RELAY_URL,
      load: () => {
        try {
          return existsSync(file) && safeStorage.isEncryptionAvailable() ? (JSON.parse(safeStorage.decryptString(readFileSync(file))) as GroupSaved) : null
        } catch {
          return null
        }
      },
      save: (s) => {
        if (safeStorage.isEncryptionAvailable()) writeFileSync(file, safeStorage.encryptString(JSON.stringify(s)))
      },
      clear: () => rmSync(file, { force: true }),
      credentials,
      emit: (channel, payload) => {
        for (const wc of self?.listeners ?? []) if (!wc.isDestroyed()) wc.send(channel, payload)
      }
    })
    self = this
  }

  watch(wc: WebContents) {
    this.listeners.add(wc)
    wc.once('destroyed', () => this.listeners.delete(wc))
  }
}
