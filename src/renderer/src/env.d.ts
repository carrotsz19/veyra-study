import type { AccountApi, AiApi, DriveApi, SyncApi, FilesApi, GoogleApi, GroupApi, VeyraDb } from '@shared/types'

declare global {
  interface Window {
    veyra: { db: VeyraDb; account: AccountApi; google: GoogleApi; ai: AiApi; group: GroupApi; files: FilesApi; drive: DriveApi; sync: SyncApi; saveNow(kind: string, data: unknown, id: string): void;
      app: { setZoom(f: number): void; exportData(): Promise<{ saved: boolean; path?: string; count?: number }>; importData(): Promise<{ imported: number }>; openDataFolder(): Promise<void>; exportNotes(files: { name: string; text: string }[]): Promise<{ saved: number }>; version(): Promise<string>; materialSupported: boolean; setMaterial(material: string, theme: string): Promise<void> }
      open: (url: string) => Promise<void> }
  }
}

export {}
