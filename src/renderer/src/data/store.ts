import { useCallback, useEffect, useState } from 'react'
import type { DataByKind, Kind, Rec, VeyraDb } from '@shared/types'

/**
 * The one door to storage. On desktop it's the Electron preload bridge; the
 * Android build (phase 2) will provide the same VeyraDb interface.
 */
const backend: VeyraDb = window.veyra.db

type Listener = (kind: Kind) => void
const listeners = new Set<Listener>()
const emit = (kind: Kind): void => listeners.forEach((l) => l(kind))

export const db = {
  list: <K extends Kind>(kind: K) => backend.list(kind),
  async put<K extends Kind>(kind: K, data: DataByKind[K], id?: string): Promise<Rec<K>> {
    const rec = await backend.put(kind, data, id)
    emit(kind)
    return rec
  },
  async remove(kind: Kind, id: string): Promise<void> {
    await backend.remove(id)
    emit(kind)
  },
  info: () => backend.info()
}

/** Live list of one kind of record; re-reads whenever that kind changes. */
export function useRecords<K extends Kind>(kind: K): { items: Rec<K>[]; loaded: boolean } {
  const [items, setItems] = useState<Rec<K>[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(() => {
    backend.list(kind).then((rows) => {
      setItems(rows)
      setLoaded(true)
    })
  }, [kind])

  useEffect(() => {
    load()
    const l: Listener = (k) => k === kind && load()
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [kind, load])

  return { items, loaded }
}
