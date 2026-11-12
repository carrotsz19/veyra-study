import type { AccountApi, AiApi, DriveApi, McpApi, UpdateApi, SyncApi, VoiceApi, FilesApi, GoogleApi, GroupApi, VeyraDb } from '@shared/types'

declare global {
  interface Window {
    veyra: { db: VeyraDb; account: AccountApi; google: GoogleApi; ai: AiApi; group: GroupApi; files: FilesApi; drive: DriveApi; sync: SyncApi; voice: VoiceApi; mcp: McpApi; update: UpdateApi; saveNow(kind: string, data: unknown, id: string): void;
      app: { setZoom(f: number): void; exportData(): Promise<{ saved: boolean; path?: string; count?: number }>; importData(): Promise<{ imported: number }>; openDataFolder(): Promise<void>; exportNotes(files: { name: string; text: string }[]): Promise<{ saved: number }>; version(): Promise<string>; materialSupported: boolean; setMaterial(material: string, theme: string): Promise<void>; setStartup(on: boolean): Promise<boolean>; onNav(cb: (screen: string) => void): () => void; /** Android: schedules the timer's end-of-block notification (null cancels). */ timerAlarm?(at: number | null, title?: string, body?: string): Promise<void> }
      open: (url: string) => Promise<void> }
  }
}

export {}
