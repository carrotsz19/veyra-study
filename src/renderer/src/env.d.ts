import type { AccountApi, GoogleApi, VeyraDb } from '@shared/types'

declare global {
  interface Window {
    veyra: { db: VeyraDb; account: AccountApi; google: GoogleApi;
      app: { setZoom(f: number): void; exportData(): Promise<{ saved: boolean; path?: string; count?: number }>; openDataFolder(): Promise<void>; exportNotes(files: { name: string; text: string }[]): Promise<{ saved: number }>; version(): Promise<string> }
      open: (url: string) => Promise<void> }
  }
}

export {}
