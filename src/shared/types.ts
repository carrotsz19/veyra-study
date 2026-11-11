/**
 * Every piece of data in Veyra is a "record": a typed JSON document with
 * sync metadata. Phase 2 sync exchanges records changed since a cursor and
 * merges them last-writer-wins on (updatedAt, deviceId). Deletes are
 * tombstones (deletedAt set) so they sync too.
 */
export type Kind = 'subject' | 'task' | 'note' | 'session'

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
