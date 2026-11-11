import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { DataByKind, Kind, Rec } from '../shared/types'

interface Row {
  id: string
  kind: string
  data: string
  created_at: number
  updated_at: number
  deleted_at: number | null
  device_id: string
}

const toRec = (r: Row): Rec =>
  ({
    id: r.id,
    kind: r.kind as Kind,
    data: JSON.parse(r.data),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    deviceId: r.device_id
  }) as Rec

export class Store {
  private db: DatabaseSync
  readonly deviceId: string
  private lastStamp = 0

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        device_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind, deleted_at);
      CREATE INDEX IF NOT EXISTS records_updated ON records(updated_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'device_id'`).get() as
      | { value: string }
      | undefined
    if (row) {
      this.deviceId = row.value
    } else {
      this.deviceId = randomUUID()
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('device_id', ?)`).run(this.deviceId)
    }
  }

  /** Strictly increasing ms timestamp, so two quick edits never tie. */
  private stamp(): number {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return this.lastStamp
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  list(kind: Kind): Rec[] {
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE kind = ? AND deleted_at IS NULL ORDER BY created_at`)
      .all(kind) as unknown as Row[]
    return rows.map(toRec)
  }

  put<K extends Kind>(kind: K, data: DataByKind[K], id?: string): Rec {
    const now = this.stamp()
    const existing = id
      ? (this.db.prepare(`SELECT * FROM records WHERE id = ?`).get(id) as Row | undefined)
      : undefined
    const recId = id ?? randomUUID()
    const json = JSON.stringify(data)
    if (existing) {
      this.db
        .prepare(`UPDATE records SET data = ?, updated_at = ?, deleted_at = NULL, device_id = ? WHERE id = ?`)
        .run(json, now, this.deviceId, recId)
    } else {
      this.db
        .prepare(
          `INSERT INTO records (id, kind, data, created_at, updated_at, deleted_at, device_id)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(recId, kind, json, now, now, this.deviceId)
    }
    return toRec(this.db.prepare(`SELECT * FROM records WHERE id = ?`).get(recId) as unknown as Row)
  }

  remove(id: string): void {
    const now = this.stamp()
    this.db
      .prepare(`UPDATE records SET deleted_at = ?, updated_at = ?, device_id = ? WHERE id = ?`)
      .run(now, now, this.deviceId, id)
  }

  changesSince(since: number): Rec[] {
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE updated_at > ? ORDER BY updated_at`)
      .all(since) as unknown as Row[]
    return rows.map(toRec)
  }
}
