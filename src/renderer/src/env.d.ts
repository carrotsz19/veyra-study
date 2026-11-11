import type { VeyraDb } from '@shared/types'

declare global {
  interface Window {
    veyra: { db: VeyraDb }
  }
}

export {}
