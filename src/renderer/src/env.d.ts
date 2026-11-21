import type { AccountApi, AiApi, DriveApi, FriendsApi, McpApi, UpdateApi, SyncApi, VoiceApi, FilesApi, GoogleApi, GroupApi, VeyraDb } from '@shared/types'

declare global {
  /** A title bar menu, as drawn by the acrylic menu window. */
  interface MenuSpec {
    x: number
    y: number
    dark: boolean
    accent: string
    zoom: number
    items: ({ id: string; label: string; keys?: string; checked?: boolean } | { sep: true })[]
  }
  interface Window {
    veyra: { db: VeyraDb; account: AccountApi; friends: FriendsApi; google: GoogleApi; ai: AiApi; group: GroupApi; files: FilesApi; drive: DriveApi; sync: SyncApi; voice: VoiceApi; mcp: McpApi; update: UpdateApi; saveNow(kind: string, data: unknown, id: string): void;
      app: { setZoom(f: number): void; exportData(): Promise<{ saved: boolean; path?: string; count?: number }>; importData(): Promise<{ imported: number }>; openDataFolder(): Promise<void>; exportNotes(files: { name: string; text: string }[]): Promise<{ saved: number }>; exportFiles(files: { name: string; ext: string; mime: string; bytes: Uint8Array }[], kindLabel: string): Promise<{ saved: number }>; exportPdf?(files: { name: string; html: string }[]): Promise<{ saved: number }>; version(): Promise<string>; materialSupported: boolean; setMaterial(material: string, theme: string): Promise<void>; setStartup(on: boolean): Promise<boolean>; /** Desktop: height of Veyra's own title bar (0 or missing: none). */ titleBar?: number; win?(cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'fullscreen' | 'close' | 'quit' | 'minimize' | 'maximize'): Promise<void>; winState?(): { focused: boolean; maximized: boolean }; windowButtons?: 'dots' | 'windows'; windowButtonsChoice?(): 'dots' | 'windows'; setWindowButtons?(b: 'dots' | 'windows'): Promise<void>; relaunch?(): Promise<void>; /** Desktop: the diagnostics log, its folder, and sending it. */ diagRead?(): Promise<{ text: string; folder: string }>; diagOpen?(): Promise<string>; diagSend?(text: string, note: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>; /** Desktop: a report sent automatically, waiting for the person's description. */ diagAsk?(): Promise<{ id: string; trigger: string; at: number } | null>; diagAnswer?(id: string, note: string): Promise<{ ok: true } | { ok: false; error: string }>; diagDismiss?(): Promise<void>; onDiagAsk?(cb: (ask: { id: string; trigger: string; at: number }) => void): () => void; onBackdrop?(cb: (url: string | null) => void): () => void; onWinState?(cb: (s: { focused: boolean; maximized: boolean }) => void): () => void; onNav(cb: (screen: string) => void): () => void; /** Desktop: native notification support, test popup, and clicking a DM/chat notification. */ notifyCheck?(): Promise<{ supported: boolean }>; notifyTest?(title?: string, body?: string): Promise<{ shown: boolean }>; onOpenChat?(cb: (groupId: string) => void): () => void; /** Android: schedules the timer's end-of-block notification (null cancels). */ timerAlarm?(at: number | null, title?: string, body?: string): Promise<void>; /** Android: a light tap of vibration. */ haptic?(kind: 'light' | 'medium'): Promise<void>; /** Android: keep the screen on (or let it sleep again). */ keepAwake?(on: boolean): Promise<void> }
      open: (url: string) => Promise<void>
      /** Desktop (Windows 11): the title bar's menus in an acrylic window of their own. */
      menu?: {
        supported(): boolean
        open(spec: MenuSpec): void
        close(): void
        justShown(): boolean
        onPicked(cb: (id: string) => void): () => void
        onClosed(cb: () => void): () => void
        onStep(cb: (by: number) => void): () => void
        onRender(cb: (spec: MenuSpec) => void): () => void
        size(w: number, h: number): void
        pick(id: string): void
        step(by: number): void
        dismiss(): void
      } }
  }
}

export {}
