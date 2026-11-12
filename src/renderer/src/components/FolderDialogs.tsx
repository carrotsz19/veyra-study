import { useState } from 'react'
import { Check, Folder as FolderIcon, FolderPlus, FolderMinus } from 'lucide-react'
import type { Folder, Rec } from '@shared/types'
import { Dialog } from './ui'
import { newFolder } from '../lib/folders'

/** Naming a folder: a new one, or renaming. */
export function FolderNameDialog({ title, initial = '', action, onSave, onClose }: { title: string; initial?: string; action: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial)
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          onSave(name.trim())
          onClose()
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="folder-name">Name</label>
          <input id="folder-name" autoFocus value={name} placeholder="Revision" maxLength={60} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        </div>
        <div className="actions">
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!name.trim()}>
            {action}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** Picking a folder to move things into (or out of every folder), or making a new one there and then. */
export function FolderPickDialog({
  scope,
  folders,
  current,
  title,
  onPick,
  onClose
}: {
  scope: Folder['scope']
  folders: Rec<'folder'>[]
  /** The folder they're in now, if they're all in the same one. */
  current?: string | null
  title: string
  onPick: (folderId: string | null, name: string) => void
  onClose: () => void
}) {
  const [naming, setNaming] = useState(false)
  if (naming)
    return (
      <FolderNameDialog
        title="New folder"
        action="Create and move"
        onClose={() => setNaming(false)}
        onSave={async (name) => {
          const f = await newFolder(scope, name)
          onPick(f.id, f.data.name)
          onClose()
        }}
      />
    )
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="folder-pick">
        {folders.map((f) => (
          <button key={f.id} className="menu-row" onClick={() => (onPick(f.id, f.data.name), onClose())}>
            <FolderIcon size={16} className="dim" />
            <span className="grow trunc">{f.data.name}</span>
            {current === f.id && <Check size={15} style={{ color: 'var(--tint)' }} />}
          </button>
        ))}
        <button className="menu-row" onClick={() => (onPick(null, ''), onClose())}>
          <FolderMinus size={16} className="dim" />
          <span className="grow">{scope === 'note' ? 'Not in a folder' : 'No folder'}</span>
          {current === null && <Check size={15} style={{ color: 'var(--tint)' }} />}
        </button>
        <div className="menu-sep" />
        <button className="menu-row" onClick={() => setNaming(true)}>
          <FolderPlus size={16} className="dim" />
          <span className="grow">New folder…</span>
        </button>
      </div>
    </Dialog>
  )
}
