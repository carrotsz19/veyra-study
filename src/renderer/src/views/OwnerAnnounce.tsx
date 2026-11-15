import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Megaphone, RefreshCw, Search, Send, Trash2 } from 'lucide-react'
import { groupCall, gid } from '../data/groups'
import { Avatar } from '../components/account'
import { Dialog, Seg, useToast } from '../components/ui'

/**
 * Settings → Owner → Announcements: a message shown in the app as a card until each person
 * dismisses it (server/announce.mjs). To everyone, to people you pick, or to everyone with
 * Veyra AI. Reaches people who've used Group work or sync.
 */
type Audience = 'all' | 'users' | 'ai'
type Sent = { id: string; title: string; body: string; link: string | null; createdAt: number; audience: Audience; usernames: string[]; expiresAt: number | null; seen: number; reach: number }
type Person = { username: string; displayName: string; photoUrl: string }

const LASTS: [string, number | null][] = [
  ['Until I delete it', null],
  ['1 day', 86_400_000],
  ['1 week', 7 * 86_400_000],
  ['1 month', 30 * 86_400_000]
]
const err = (e: unknown) => (e instanceof Error ? e.message : 'That didn’t work.')

export function OwnerAnnounceTab() {
  const toast = useToast()
  const [sent, setSent] = useState<Sent[] | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [link, setLink] = useState('')
  const [audience, setAudience] = useState<Audience>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [lasts, setLasts] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setError('')
    groupCall<{ announcements: Sent[] }>('GET', '/admin/announcements').then((r) => setSent(r.announcements), (e) => setError(err(e)))
  }
  useEffect(() => {
    load()
    groupCall<{ users: Person[] }>('GET', '/admin/users').then((r) => setPeople(r.users), () => {})
  }, [])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^@/, '')
    return people.filter((p) => !t || p.username.includes(t) || p.displayName.toLowerCase().includes(t))
  }, [people, q])
  const ready = title.trim() && body.trim() && (audience !== 'users' || picked.size > 0)
  const who = audience === 'all' ? 'everyone' : audience === 'ai' ? 'everyone with Veyra AI' : picked.size === 1 ? `@${[...picked][0]}` : `${picked.size} people`

  const send = async () => {
    setBusy(true)
    try {
      const ms = LASTS[lasts][1]
      await groupCall('POST', '/admin/announcements', { title: title.trim(), body: body.trim(), link: link.trim() || undefined, audience, usernames: [...picked], expiresAt: ms ? Date.now() + ms : null })
      toast(`Sent to ${who}`)
      setTitle('')
      setBody('')
      setLink('')
      setPicked(new Set())
      setConfirm(false)
      load()
    } catch (e) {
      toast(err(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (a: Sent) => {
    try {
      await groupCall('DELETE', `/admin/announcements/${gid(a.id)}`)
      toast('Deleted. Nobody sees it any more.')
      load()
    } catch (e) {
      toast(err(e))
    }
  }

  return (
    <>
      <h3 className="owner-sub">New announcement</h3>
      <div className="card oan-form">
        <input className="oan-title" placeholder="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea placeholder="Message" rows={4} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        <input placeholder="Link (optional, https://…)" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link" />
        <div className="oan-row">
          <span className="xs dim">For</span>
          <Seg
            value={audience}
            onChange={setAudience}
            options={[
              ['all', 'Everyone'],
              ['users', 'People I pick'],
              ['ai', 'People with Veyra AI']
            ]}
          />
        </div>
        {audience === 'users' && (
          <div className="oan-pick">
            <label className="owner-search">
              <Search size={15} className="dim" />
              <input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
            </label>
            <div className="oan-people">
              {shown.map((p) => (
                <label key={p.username} className="oan-person">
                  <input
                    type="checkbox"
                    checked={picked.has(p.username)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(p.username)
                        else n.delete(p.username)
                        return n
                      })
                    }
                  />
                  <Avatar user={p} />
                  <span className="trunc">
                    {p.displayName} <span className="dim">@{p.username}</span>
                  </span>
                </label>
              ))}
              {!shown.length && <div className="dim sm">No one matches.</div>}
            </div>
          </div>
        )}
        <div className="oan-row">
          <span className="xs dim">Shows</span>
          <select className="oan-lasts" value={lasts} onChange={(e) => setLasts(Number(e.target.value))} aria-label="How long it shows">
            {LASTS.map(([label], i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
          <span className="grow" />
          <button className="btn" disabled={!ready || busy} onClick={() => setConfirm(true)}>
            <Send size={15} /> Send
          </button>
        </div>
        <p className="xs tert" style={{ margin: 0 }}>
          It shows as a card in the app until each person dismisses it. It reaches people who’ve used Group work or sync.
        </p>
      </div>

      <h3 className="owner-sub">Sent</h3>
      {error ? (
        <div className="card owner-problem">
          <span className="grow">{error}</span>
          <button className="btn sec sm" onClick={load}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      ) : !sent ? (
        <div className="dim sm owner-loading">Loading…</div>
      ) : (
        <div className="ig">
          {sent.map((a) => (
            <div key={a.id} className="ig-row owner-item">
              <span className="announce-icon">
                <Megaphone size={15} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ig-title trunc">{a.title}</div>
                <div className="owner-item-text">{a.body}</div>
                <div className="ig-sub">
                  {a.audience === 'all' ? 'Everyone' : a.audience === 'ai' ? 'People with Veyra AI' : a.usernames.map((u) => '@' + u).join(', ')} · seen by {a.seen} of {a.reach} · sent{' '}
                  {formatDistanceToNowStrict(a.createdAt, { addSuffix: true })}
                  {a.expiresAt ? (a.expiresAt > Date.now() ? ` · ends ${formatDistanceToNowStrict(a.expiresAt, { addSuffix: true })}` : ' · ended') : ''}
                </div>
              </div>
              <button className="iconbtn plain" aria-label={`Delete “${a.title}”`} title="Delete (nobody sees it any more)" onClick={() => void remove(a)}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {!sent.length && <div className="ig-row dim sm">Nothing sent yet.</div>}
        </div>
      )}

      {confirm && (
        <Dialog title={`Send to ${who}?`} onClose={() => setConfirm(false)}>
          <div className="oan-preview">
            <b>{title.trim()}</b>
            <p>{body.trim()}</p>
          </div>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn" disabled={busy} onClick={() => void send()}>
              <Send size={15} /> Send
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
