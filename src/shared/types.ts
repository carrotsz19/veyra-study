/**
 * Every piece of data in Veyra is a "record": a typed JSON document with
 * sync metadata. Phase 2 sync exchanges records changed since a cursor and
 * merges them last-writer-wins on (updatedAt, deviceId). Deletes are
 * tombstones (deletedAt set) so they sync too.
 */
export type Kind = 'subject' | 'task' | 'note' | 'session' | 'settings'

export interface RecordMeta {
  id: string
  kind: Kind
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  deviceId: string
}

export interface Subject {
  name: string
  color: string
  archived?: boolean
  /** Position in the sidebar and lists (Settings → Subjects); lower comes first. */
  order?: number
}

export type Priority = 'low' | 'normal' | 'high'

export interface Task {
  title: string
  subjectId: string | null
  done: boolean
  completedAt: number | null
  /** Due date as local "YYYY-MM-DD", or null. */
  due: string | null
  priority: Priority
  details?: string
}

export type NoteTemplate = 'page' | 'cornell' | 'lined' | 'grid'
export type NoteFont = 'sans' | 'serif' | 'mono'

export interface Note {
  title: string
  subjectId: string | null
  /** TipTap JSON document (the main notes area). */
  content: unknown
  /** Plain-text preview, kept for search and lists (includes cues and summary). */
  excerpt: string
  pinned?: boolean
  /** Archived notes leave the main list but are kept (Notes → Archived). */
  archived?: boolean
  /** Lower-case labels for filtering. */
  tags?: string[]
  /** Emoji shown above the title and in lists. */
  icon?: string
  /** Cover band colour key (see NOTE_COVERS), or none. */
  cover?: string | null
  template?: NoteTemplate
  font?: NoteFont
  /** Cornell layout: the cue column and the summary, as TipTap JSON. */
  cues?: unknown
  summary?: unknown
}

export interface StudySession {
  subjectId: string | null
  startedAt: number
  endedAt: number
  durationSec: number
  label?: string
}

export interface DataByKind {
  subject: Subject
  task: Task
  note: Note
  session: StudySession
  settings: Partial<import('./settings').AppSettings>
}

export type Rec<K extends Kind = Kind> = RecordMeta & { kind: K; data: DataByKind[K] }

/** The storage API the UI talks to. Desktop: IPC to SQLite in the main process. */
export interface VeyraDb {
  list<K extends Kind>(kind: K): Promise<Rec<K>[]>
  put<K extends Kind>(kind: K, data: DataByKind[K], id?: string): Promise<Rec<K>>
  remove(id: string): Promise<void>
  /** Records (including tombstones) changed after `since`. Used by sync. */
  changesSince(since: number): Promise<Rec[]>
  info(): Promise<{ deviceId: string; dbPath: string }>
}

export interface AccountUser {
  username: string
  displayName: string
  email: string
  emailVerified: boolean
  photoUrl?: string
}

export interface AccountState {
  mode: 'account' | 'guest' | 'none'
  user: AccountUser | null
  server: string
  /** 'moved' after the first sign-in adopted this computer's data, or a sign-out reason. */
  notice?: string
}

export interface AccountApi {
  state(): Promise<AccountState>
  refresh(): Promise<AccountState>
  signIn(username: string, password: string): Promise<AccountState>
  signUp(input: { username: string; email: string; password: string; acceptLegal: boolean }): Promise<AccountState>
  signOut(): Promise<AccountState>
  continueAsGuest(): Promise<AccountState>
  legalUrls(): Promise<{ legal: string; terms: string; privacy: string; terms2: string; privacy2: string }>
}

export interface GoogleEvent {
  id: string
  title: string
  calendar: string
  color: string
  allDay: boolean
  /** All-day: "YYYY-MM-DD" (end exclusive). Timed: ISO date-time. */
  start: string
  end: string
  location: string
  link: string
}

export interface IcalFeed {
  id: string
  name: string
  color: string
  error?: string
}

export interface GoogleState {
  /** The app has its own Google client, so connecting is one click. */
  builtIn: boolean
  /** Using a client the user entered instead of the built-in one. */
  customClient: boolean
  feeds: IcalFeed[]
  connected: boolean
  clientId: string
  hasSecret: boolean
  email: string
  pushTasks: boolean
  /** Calendar ids to show; null = the ones selected in Google Calendar. */
  shown: string[] | null
  calendars: { id: string; summary: string; color: string; selected: boolean; primary: boolean }[]
  error?: string
  lastSync?: number
}

export interface GoogleApi {
  state(): Promise<GoogleState>
  /** Empty id: use the app's built-in client. */
  connect(clientId?: string, clientSecret?: string): Promise<GoogleState>
  addFeed(url: string, name: string): Promise<GoogleState>
  removeFeed(id: string): Promise<GoogleState>
  disconnect(): Promise<GoogleState>
  setOptions(o: { pushTasks?: boolean; shown?: string[] | null }): Promise<GoogleState>
  events(fromIso: string, toIso: string): Promise<{ events: GoogleEvent[]; error?: string }>
  syncNow(): Promise<{ pushed: number }>
}

export type AiProvider = 'ollama' | 'anthropic' | 'gemini' | 'openai'

export interface AiState {
  provider: AiProvider | null
  ollamaUrl: string
  models: Partial<Record<AiProvider, string>>
  hasKey: Record<Exclude<AiProvider, 'ollama'>, boolean>
}

export interface AiStats {
  /** Tokens written in the answer. */
  tokens: number
  /** Tokens per second while writing (after the first token). */
  tps: number
  /** True when the token count is the provider's own; false when estimated from characters. */
  exact: boolean
}

export interface AiEvent {
  id: string
  stats?: AiStats
  delta?: string
  done?: boolean
  cancelled?: boolean
  error?: string
}

export interface AiApi {
  state(): Promise<AiState>
  set(o: { provider?: AiProvider | null; model?: { provider: AiProvider; model: string }; key?: { provider: Exclude<AiProvider, 'ollama'>; key: string }; ollamaUrl?: string }): Promise<AiState>
  forget(): Promise<AiState>
  models(provider: AiProvider): Promise<string[]>
  pull(model: string): Promise<void>
  run(id: string, req: { system: string; prompt: string }): Promise<void>
  cancel(id: string): Promise<void>
  onEvent(cb: (e: AiEvent) => void): () => void
  onPull(cb: (e: { model: string; status: string; progress: number | null }) => void): () => void
  localStatus(): Promise<LocalAiStatus>
  localSetup(model: string): Promise<AiState>
  localCancel(): Promise<void>
  onLocalProgress(cb: (e: LocalAiProgress) => void): () => void
}

export interface LocalModelChoice {
  model: string
  label: string
  sizeGB: number
  why: string
  /** Rough tokens per second on this computer, before it has run. */
  estTps?: [number, number]
  /** Measured tokens per second, once it has run here. */
  measuredTps?: number
}

export interface LocalAiStatus {
  /** managed: downloaded by Veyra; external: Ollama installed separately; null: none yet. */
  engine: 'managed' | 'external' | null
  running: boolean
  models: string[]
  hardware: { ramGB: number; vramGB: number; gpu: string }
  recommended: string
  choices: LocalModelChoice[]
  freeGB: number
  engineSizeGB: number
  /** Measured tokens per second by model name, for any model that has run here. */
  measured: Record<string, number>
}

export interface LocalAiProgress {
  step: 'engine' | 'unpack' | 'start' | 'model' | 'done'
  progress: number | null
  detail: string
}

/* ---------- Group work (the group server on the owner's phone) ---------- */
export interface GroupUser {
  username: string
  displayName: string
  photoUrl: string
  verified: boolean
}

export interface GroupStatus {
  /** idle: not tried yet; signed-out: no Veyra account; offline: server unreachable. */
  state: 'idle' | 'signed-out' | 'connecting' | 'online' | 'offline'
  me: GroupUser | null
  error: string
}

export interface GroupMember extends GroupUser {
  role: 'owner' | 'member'
  joinedAt: number
}

export interface Group {
  id: string
  name: string
  color: string
  owner: string
  role: 'owner' | 'member'
  /** Only the owner sees it. */
  inviteCode?: string
  members: GroupMember[]
  createdAt: number
}

export interface GroupTask {
  title: string
  details: string
  assignee: string | null
  due: string | null
  done: boolean
  doneBy: string | null
  doneAt: number | null
  priority: Priority
}
export interface GroupMessage {
  text: string
}
export interface GroupNote {
  title: string
  icon: string
  content: unknown
  excerpt: string
}
export interface GroupEvent {
  title: string
  date: string | null
  time: string | null
  details: string
}
export interface GroupItemData {
  task: GroupTask
  message: GroupMessage
  note: GroupNote
  event: GroupEvent
}
export type GroupItemKind = keyof GroupItemData

export interface GroupItem<K extends GroupItemKind = GroupItemKind> {
  id: string
  kind: K
  data: GroupItemData[K]
  rev: number
  createdBy: string
  createdAt: number
  updatedBy: string
  updatedAt: number
  deleted: boolean
  seq: number
}

export interface GroupInvite {
  id: string
  createdAt: number
  group: { id: string; name: string; color: string }
  invitedBy: GroupUser
}

export interface GroupPreview {
  id: string
  name: string
  color: string
  owner: GroupUser
  memberCount: number
  alreadyIn: boolean
}

export interface GroupApi {
  status(): Promise<GroupStatus>
  connect(): Promise<GroupStatus>
  disconnect(): Promise<GroupStatus>
  /** One request to the group server, e.g. callRaw('GET', '/groups'). Never throws; see groupCall in the UI. */
  callRaw(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ ok: true; v: any } | { ok: false; error: string; status: number; extra?: any }>
  onStatus(cb: (s: GroupStatus) => void): () => void
  onChanged(cb: (e: { seq: number }) => void): () => void
}

/* ---------- files attached to notes ---------- */
export interface Attachment {
  /** File name in this account's attachments folder (UUID + extension). */
  id: string
  name: string
  mime: string
  size: number
}

export interface FilesApi {
  pick(): Promise<Attachment[]>
  fromPaths(paths: string[]): Promise<Attachment[]>
  fromBytes(name: string, mime: string, bytes: Uint8Array): Promise<Attachment>
  open(id: string): Promise<void>
  reveal(id: string): Promise<void>
  pathFor(file: File): string
}

/* ---------- Google Drive ---------- */
export interface DriveState {
  builtIn: boolean
  connected: boolean
  email: string
  /** Back up notes to Drive automatically. */
  backup: boolean
  /** Note changes up to here (updatedAt) are backed up. */
  backupThrough: number
  backedUp: number
  lastBackup?: number
  error?: string
  /** The file picker is set up (Open from Drive). */
  canPick: boolean
}

export interface DriveBackupFile {
  id: string
  name: string
  markdown: string
  updatedAt: number
  deleted: boolean
}

export interface DriveApi {
  state(): Promise<DriveState>
  connect(): Promise<DriveState>
  disconnect(): Promise<DriveState>
  setBackup(on: boolean): Promise<DriveState>
  saveDoc(noteId: string, title: string, html: string): Promise<{ url: string }>
  backup(files: DriveBackupFile[], through: number): Promise<DriveState & { uploaded: number; removed: number }>
  resetBackup(): Promise<DriveState>
}
