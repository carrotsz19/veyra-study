import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Megaphone, X } from 'lucide-react'
import { groupCall } from '../data/groups'

/**
 * Announcements from the owner of Veyra Study (server/announce.mjs): one card at a time, newest
 * first, until you dismiss it. Checked when the app opens and every 10 minutes.
 */
interface Announcement {
  id: string
  title: string
  body: string
  link: string | null
  createdAt: number
  from: { username: string; displayName: string }
}

const openLink = (url: string) => (window.veyra.open ? window.veyra.open(url) : window.open(url, '_blank', 'noopener'))

export function Announcements({ online }: { online: boolean }) {
  const [list, setList] = useState<Announcement[]>([])
  const load = useCallback(() => {
    groupCall<{ announcements: Announcement[] }>('GET', '/announcements')
      .then((r) => setList(r.announcements))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!online) return
    load()
    const t = setInterval(load, 10 * 60_000)
    return () => clearInterval(t)
  }, [online, load])

  const a = list[0]
  if (!a) return null
  const dismiss = () => {
    setList((l) => l.slice(1))
    void groupCall('POST', `/announcements/${encodeURIComponent(a.id)}/read`).catch(() => {})
  }
  return (
    <div className="announce" role="status" aria-live="polite">
      <span className="announce-icon">
        <Megaphone size={16} />
      </span>
      <div className="announce-text">
        <b>{a.title}</b>
        <p>{a.body}</p>
        <div className="announce-foot">
          <span className="xs dim">
            From {a.from.displayName} · {new Date(a.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
            {list.length > 1 ? ` · ${list.length - 1} more` : ''}
          </span>
          {a.link && (
            <button className="btn ghost sm" onClick={() => openLink(a.link!)}>
              <ExternalLink size={13} /> Open
            </button>
          )}
          <button className="btn sm" onClick={dismiss}>
            Got it
          </button>
        </div>
      </div>
      <button className="iconbtn plain announce-x" aria-label="Dismiss" onClick={dismiss}>
        <X size={15} />
      </button>
    </div>
  )
}
