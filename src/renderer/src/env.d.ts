import type { AccountApi, GoogleApi, VeyraDb } from '@shared/types'

declare global {
  interface Window {
    veyra: { db: VeyraDb; account: AccountApi; google: GoogleApi; open: (url: string) => Promise<void> }
  }
}

export {}
