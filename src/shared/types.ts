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
