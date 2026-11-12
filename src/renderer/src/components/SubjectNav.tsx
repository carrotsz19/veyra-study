import { useState } from 'react'
import { ChevronRight, Folder as FolderIcon, FolderOpen } from 'lucide-react'
import type { Rec } from '@shared/types'
import { sortSubjects } from '../lib/subjects'
import { collapsedFolders, saveCollapsed, useFolders } from '../lib/folders'
import type { Route } from '../nav'

/**
 * The sidebar's subjects: folders first (each can fold away, remembered on
 * this device), then the subjects that aren't in a folder.
 */
export function SubjectNav({ subjects, route, go, tip }: { subjects: Rec<'subject'>[]; route: Route; go: (r: Route) => void; tip: (label: string) => string | undefined }) {
  const folders = useFolders('subject')
  const [closed, setClosed] = useState(collapsedFolders)
  const active = sortSubjects(subjects).filter((s) => !s.data.archived)
  const inFolder = (s: Rec<'subject'>) => (s.data.folderId && folders.some((f) => f.id === s.data.folderId) ? s.data.folderId : null)
  const toggle = (id: string) => {
    const next = new Set(closed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setClosed(next)
    saveCollapsed(next)
  }
  const subjectBtn = (s: Rec<'subject'>, nested: boolean) => (
    <button
      key={s.id}
      className={`navbtn ${nested ? 'nested' : ''}`}
      aria-current={route.name === 'subject' && 'id' in route && route.id === s.id}
      onClick={() => go({ name: 'subject', id: s.id })}
      title={tip(s.data.name)}
      aria-label={s.data.name}
    >
      <span className="dot" style={{ background: s.data.color }} />
      <span className="trunc nav-label">{s.data.name}</span>
    </button>
  )
  return (
    <>
      {folders.map((f) => {
        const list = active.filter((s) => inFolder(s) === f.id)
        const open = !closed.has(f.id)
        // A closed folder still shows which subject you're on.
        const current = !open && list.some((s) => route.name === 'subject' && 'id' in route && route.id === s.id)
        return (
          <div key={f.id} className={`side-folder ${open ? 'open' : ''}`}>
            <button className={`navbtn side-folder-head ${current ? 'has-current' : ''}`} aria-expanded={open} onClick={() => toggle(f.id)} title={tip(`${f.data.name} (${list.length})`)} aria-label={`${f.data.name} folder`}>
              <ChevronRight size={13} className="side-folder-chev" />
              {open ? <FolderOpen size={16} /> : <FolderIcon size={16} />}
              <span className="trunc nav-label">{f.data.name}</span>
              {!open && list.length > 0 && <span className="count">{list.length}</span>}
            </button>
            <div className="side-folder-body">
              <div>{list.map((s) => subjectBtn(s, true))}</div>
            </div>
          </div>
        )
      })}
      {active.filter((s) => !inFolder(s)).map((s) => subjectBtn(s, false))}
    </>
  )
}
