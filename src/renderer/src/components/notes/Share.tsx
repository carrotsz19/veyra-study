import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Check, Copy, Eye, Link2, Pencil, Send, Trash2, UserRound, Users, X } from 'lucide-react'
import type { Note, NoteTemplate } from '@shared/types'
import { Dialog, useToast } from '../ui'
import { Select } from '../Select'
import { noteExtensions, docText } from './extensions'
import { db } from '../../data/store'
import {
  parseBody,
  readShare,
  readSharedFile,
  setRole,
  shareLink,
  shareNote,
  sharedWithMe,
  sharesOf,
  stopSharing,
  swapFiles,
  type Received,
  type Role,
  type SharedBody,
  type ShareInfo
} from '../../lib/share'
import { openLive, releaseLive, type Caller, type LiveDoc } from '../../lib/live'
import { fileSrc, setRemoteFiles, type RemoteFiles } from './attachment'
import { NOTE_COVERS } from './covers'
import { personColor } from '../../lib/people'
import { Welcome } from '../account'

const clean = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
  // An older server doesn't know about sharing yet.
  return m === 'Not found.' ? 'Sharing needs the newest Veyra server, which isn’t running yet. Try again later.' : m
}

/* ---------- a shared note on screen ---------- */

/** One area of a shared note, read-only (no live document: an older share). */
function StaticArea({ doc }: { doc: unknown }) {
  const editor = useEditor({ extensions: noteExtensions('', false, false), content: (doc as object) ?? '', editable: false, immediatelyRender: true }, [doc])
  return <EditorContent editor={editor} className="hist-doc" />
}

/** One area of a shared note on its live document: everyone's changes show as they happen. */
function LiveArea({ live, field, editable, onEditor, who }: { live: LiveDoc; field: string; editable: boolean; onEditor: (e: Editor) => void; who: string }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let on = true
    void live.ready.then(() => on && setReady(true))
    return () => {
      on = false
    }
  }, [live])
  const editor = useEditor(
    {
      extensions: noteExtensions(editable ? 'Write here…' : '', false, false, ready ? { doc: live.doc, field, ...(field === 'content' ? { caret: { awareness: live.awareness, user: { name: who, color: personColor(who) } } } : {}) } : undefined),
      editable: false,
      immediatelyRender: true,
      onCreate: ({ editor: e }) => onEditor(e)
    },
    [ready, live]
  )
  useEffect(() => editor?.setEditable(editable && ready), [editor, editable, ready])
  if (!ready) return <p className="live-wait">Loading…</p>
  return <EditorContent editor={editor} className={`hist-doc ${editable ? 'live-editable' : ''}`} />
}

/** A shared note's cover: a gradient, or its picture (from the server). */
function SharedCover({ cover }: { cover?: string | null }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (cover?.startsWith('img:')) fileSrc(cover.slice(4), 'image/jpeg').then(setSrc, () => setSrc(null))
  }, [cover])
  if (!cover) return null
  if (cover.startsWith('img:'))
    return src ? (
      <div className="share-cover note-cover-img">
        <img src={src} alt="" />
      </div>
    ) : null
  return NOTE_COVERS[cover] ? <div className="share-cover" style={{ background: NOTE_COVERS[cover] }} /> : null
}

/**
 * A shared note as someone else sees it: cover, title, the notes and (Cornell) cues and summary.
 * With a live document (docId) it updates as people type, and editors can write in it.
 * `files` fetches its pictures and attachments; `call` reaches the server.
 */
export function SharedDoc({
  title,
  body,
  files,
  docId,
  share = '',
  call,
  onCan,
  who = 'Guest'
}: {
  title: string
  body: SharedBody
  files: RemoteFiles
  docId?: string
  share?: string
  call?: Caller
  onCan?: (can: LiveDoc['can']) => void
  /** The name on your cursor. */
  who?: string
}) {
  setRemoteFiles(files)
  const [live, setLive] = useState<LiveDoc | null>(null)
  const [can, setCan] = useState<LiveDoc['can']>(null)
  useEffect(() => {
    if (!docId || !call) return
    const l = openLive(docId, share, call)
    setLive(l)
    setCan(l.can)
    const off = l.onChange(() => setCan(l.can))
    return () => {
      off()
      releaseLive(docId)
    }
  }, [docId, share]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onCan?.(can), [can]) // eslint-disable-line react-hooks/exhaustive-deps
  const canRef = useRef(can)
  canRef.current = can

  // Editors keep the plain-text copy (what readers on older apps and link previews see) up to date.
  const editors = useRef<Record<string, Editor>>({})
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onEditor = (field: string) => (e: Editor) => {
    editors.current[field] = e
    e.on('update', ({ transaction }) => {
      if (!transaction.docChanged || canRef.current !== 'edit' || !docId || !call) return
      if (textTimer.current) clearTimeout(textTimer.current)
      textTimer.current = setTimeout(() => {
        const json = (f: string) => editors.current[f]?.getJSON() ?? (body as unknown as Record<string, unknown>)[f] ?? null
        void call('POST', `/docs/${docId}/text?x=1${share ? `&share=${encodeURIComponent(share)}` : ''}`, {
          content: JSON.stringify({ ...body, content: json('content'), cues: json('cues'), summary: json('summary') })
        }).catch(() => {})
      }, 5000)
    })
  }
  const cornell = body.template === 'cornell' || !!docText(body.cues) || !!docText(body.summary)
  const area = (field: 'content' | 'cues' | 'summary') =>
    live ? <LiveArea live={live} field={field} editable={can === 'edit'} onEditor={onEditor(field)} who={who} /> : <StaticArea doc={body[field]} />
  return (
    <div className="share-doc">
      <SharedCover cover={body.cover} />
      {body.icon && <div className="share-icon">{body.icon}</div>}
      <h1 className="hist-title">{title}</h1>
      {area('content')}
      {cornell && (
        <>
          <section className="share-extra">
            <h2>Cues and questions</h2>
            {area('cues')}
          </section>
          <section className="share-extra">
            <h2>Summary</h2>
            {area('summary')}
          </section>
        </>
      )}
    </div>
  )
}

/* ---------- Share… (like Google Docs: who can view, who can edit) ---------- */

const ROLES = [
  { value: 'view', label: 'Viewer' },
  { value: 'edit', label: 'Editor' }
]
function RoleSelect({ value, onChange, disabled, label }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string }) {
  return <Select className="share-role" label={label} value={value} disabled={disabled} options={ROLES} onChange={(v) => onChange(v as Role)} />
}
const LINK_MODES = [
  { value: 'off', label: 'Off: only the people above' },
  { value: 'view', label: 'Anyone with the link can view' },
  { value: 'edit', label: 'Anyone with the link can edit' }
]

/** Note ••• → Share: the link (off, view or edit) and people, each a Viewer or an Editor. */
export function ShareDialog({ noteId, note, onClose }: { noteId: string; note: () => Note; onClose: () => void }) {
  const toast = useToast()
  const [list, setList] = useState<ShareInfo[] | null>(null)
  const [error, setError] = useState('')
  const [to, setTo] = useState('')
  const [newRole, setNewRole] = useState<Role>('edit')
  const [busy, setBusy] = useState(false)
  const reload = () =>
    sharesOf(noteId).then(setList, (e) => {
      setList([])
      setError(clean(e, 'Couldn’t reach the Veyra server.'))
    })
  useEffect(() => void reload(), [noteId]) // eslint-disable-line react-hooks/exhaustive-deps
  const link = list?.find((s) => !s.to)
  const people = list?.filter((s) => s.to) ?? []
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await f()
      await reload()
    } catch (e) {
      setError(clean(e, 'That didn’t work. Try again.'))
    } finally {
      setBusy(false)
    }
  }
  const copy = async (id: string) => {
    await navigator.clipboard.writeText(shareLink(id))
    toast('Link copied')
  }
  const linkMode = !link ? 'off' : link.role
  const setLink = (mode: 'off' | Role) =>
    void run(async () => {
      if (mode === 'off') return link && stopSharing(link.id)
      if (link) return setRole(link.id, mode)
      const s = await shareNote(noteId, note(), undefined, mode)
      await copy(s.id)
    })
  return (
    <Dialog title="Share this note" onClose={onClose} width={500}>
      <p className="sm dim" style={{ marginTop: -6 }}>
        Editors write in it with you at the same time; viewers see changes as they happen. Pictures and files go with it (up to 15 MB each).
      </p>
      {error && <p className="share-err">{error}</p>}
      {busy && <p className="sm dim">Saving… (pictures and files upload the first time)</p>}

      <h4 className="share-h">
        <UserRound size={15} /> People
      </h4>
      <form
        className="share-to"
        onSubmit={(e) => {
          e.preventDefault()
          const who = to.trim()
          if (!who) return
          void run(async () => {
            await shareNote(noteId, note(), who, newRole)
            setTo('')
            toast(`Shared with @${who.replace(/^@/, '')}`)
          })
        }}
      >
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@username" aria-label="Share with (username)" autoCapitalize="off" spellCheck={false} />
        <RoleSelect value={newRole} onChange={setNewRole} label="What they can do" />
        <button className="btn sm" disabled={busy || !to.trim()}>
          <Send size={14} /> Share
        </button>
      </form>
      {people.length > 0 && (
        <ul className="share-people">
          {people.map((p) => (
            <li key={p.id}>
              <span className="grow trunc">
                <b>{p.to!.displayName || p.to!.username}</b> <span className="dim">@{p.to!.username}</span>
              </span>
              <RoleSelect value={p.role} disabled={busy} label={`What @${p.to!.username} can do`} onChange={(r) => void run(() => setRole(p.id, r))} />
              <button className="iconbtn plain" aria-label={`Stop sharing with @${p.to!.username}`} title="Stop sharing with them" disabled={busy} onClick={() => void run(() => stopSharing(p.id))}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4 className="share-h">
        <Link2 size={15} /> Link
      </h4>
      {list === null ? (
        <p className="sm dim">Loading…</p>
      ) : (
        <>
          <Select className="share-link-mode" label="Who the link lets in" value={linkMode} disabled={busy} options={LINK_MODES} onChange={(v) => setLink(v as 'off' | Role)} />
          {link?.role === 'edit' && (
            <label className="toggle-row share-signin">
              <span>
                <b>Editors must sign in</b>
                <span className="sm dim">{link.signin ? 'Every change has a name on it.' : 'Anyone with the link can edit, without an account.'}</span>
              </span>
              <input type="checkbox" className="switch" checked={link.signin} disabled={busy} onChange={(e) => void run(() => setRole(link.id, 'edit', e.target.checked))} />
            </label>
          )}
          {link && (
            <div className="share-link">
              <input readOnly value={shareLink(link.id)} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <button className="btn sm" onClick={() => void copy(link.id)}>
                <Copy size={14} /> Copy
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  )
}

/* ---------- Notes → Shared: what people shared with you, and what you've shared ---------- */

/** Links opened in this browser without signing in (the website keeps them so they can be found again). */
export type RecentLink = { id: string; title: string; from: string; at: number }
const RECENT = 'veyra.recentLinks'
export function recentLinks(): RecentLink[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]')
  } catch {
    return []
  }
}
export function rememberLink(l: RecentLink) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([l, ...recentLinks().filter((x) => x.id !== l.id)].slice(0, 30)))
  } catch {
    /* storage unavailable */
  }
}
export function forgetLink(id: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify(recentLinks().filter((x) => x.id !== id)))
  } catch {
    /* storage unavailable */
  }
}
/** A share link waiting to be opened once you're signed in ("Open in Veyra Study" on a link page). */
export const PENDING_SHARE = 'veyra.openShare'
export function takePendingShare(): string | null {
  try {
    const id = localStorage.getItem(PENDING_SHARE)
    if (id) localStorage.removeItem(PENDING_SHARE)
    return id
  } catch {
    return null
  }
}

export type SharedPick = { id: string; link: boolean }

/** The Shared tab's list. `mine` are your own shared notes (they open as usual). */
export function SharedList({
  signedIn,
  picked,
  onPick,
  mine,
  onOpenMine,
  reloadKey
}: {
  signedIn: boolean
  picked: string | null
  onPick: (p: SharedPick) => void
  mine: { id: string; title: string; people: number; link: boolean }[]
  onOpenMine: (noteId: string) => void
  reloadKey: number
}) {
  const [list, setList] = useState<(Received & { link?: boolean })[] | null>(signedIn ? null : [])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!signedIn) return
    sharedWithMe().then(setList, (e) => {
      setList([])
      setError(clean(e, 'Couldn’t reach the Veyra server.'))
    })
  }, [signedIn, reloadKey])
  const recents = recentLinks().filter((r) => !list?.some((x) => x.id === r.id))
  return (
    <>
      {error && <p className="share-err np-shared-err">{error}</p>}
      <section className="np-section">
        <h3 className="np-section-title">Shared with you</h3>
        {list === null ? (
          <p className="np-shared-empty">Loading…</p>
        ) : list.length === 0 && recents.length === 0 ? (
          <p className="np-shared-empty">{signedIn ? 'Nothing yet. Notes people share with your @username, and links you open, show up here.' : 'Links you open in this browser show up here. Sign in to keep them on all your devices.'}</p>
        ) : (
          <div className="np-group">
            {list.map((x) => (
              <button key={x.id} className="np-row" aria-current={picked === x.id} onClick={() => onPick({ id: x.id, link: !!x.link })}>
                <span className="np-row-body">
                  <span className="np-row-title">
                    <span className="trunc">{x.title}</span>
                    {x.role === 'edit' ? <Pencil size={11} className="tert" aria-label="You can edit" /> : <Eye size={11} className="tert" aria-label="You can view" />}
                  </span>
                  <span className="np-row-text">
                    <span className="np-row-date">{formatDistanceToNowStrict(x.updatedAt, { addSuffix: true })}</span>
                    From {x.from.displayName || x.from.username}
                    {x.link ? ' · link' : ''}
                  </span>
                </span>
              </button>
            ))}
            {recents.map((r) => (
              <a key={r.id} className="np-row" href={`/s/${r.id}`}>
                <span className="np-row-body">
                  <span className="np-row-title">
                    <span className="trunc">{r.title}</span>
                    <Link2 size={11} className="tert" />
                  </span>
                  <span className="np-row-text">
                    <span className="np-row-date">{formatDistanceToNowStrict(r.at, { addSuffix: true })}</span>
                    From {r.from} · opened in this browser
                  </span>
                </span>
              </a>
            ))}
          </div>
        )}
      </section>
      {signedIn && (
        <section className="np-section">
          <h3 className="np-section-title">Shared by you</h3>
          {mine.length === 0 ? (
            <p className="np-shared-empty">Share a note from its ••• menu → Share…</p>
          ) : (
            <div className="np-group">
              {mine.map((m) => (
                <button key={m.id} className="np-row" onClick={() => onOpenMine(m.id)}>
                  <span className="np-row-body">
                    <span className="np-row-title">
                      <span className="trunc">{m.title || 'Untitled'}</span>
                      <Users size={11} className="tert" />
                    </span>
                    <span className="np-row-text">
                      {[m.people ? `${m.people} ${m.people === 1 ? 'person' : 'people'}` : '', m.link ? 'link on' : ''].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  )
}

/** A note someone shared with you, in the Notes pane: live, editable for Editors. */
export function SharedPane({ pick, who, onCopied, onRemoved, onBack }: { pick: SharedPick; who: string; onCopied: (noteId: string) => void; onRemoved: () => void; onBack?: () => void }) {
  const toast = useToast()
  const [open, setOpen] = useState<{ title: string; body: SharedBody; from: Received['from']; docId: string } | null>(null)
  const [error, setError] = useState('')
  const [can, setCan] = useState<LiveDoc['can']>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setOpen(null)
    setError('')
    readShare(pick.id).then(
      (r) => setOpen({ title: r.title, body: parseBody(r.content), from: r.from, docId: r.docId }),
      (e) => setError(clean(e, 'Couldn’t open it.'))
    )
  }, [pick.id])
  const keep = async () => {
    if (!open || saving) return
    setSaving(true)
    // The copy is yours: its pictures and files are saved to this device too.
    const local = async (id: string, name: string, mime: string) => {
      if (!id.startsWith('sf_')) return null
      try {
        const f = await readSharedFile(id)
        return (await window.veyra.files.fromBytes(name || f.name, mime || f.mime, Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)))).id
      } catch {
        return null
      }
    }
    // The newest text (the plain copy follows people's typing by a few seconds).
    const latest = parseBody((await readShare(pick.id).catch(() => ({ content: JSON.stringify(open.body) }))).content)
    let cover = latest.cover ?? null
    if (cover?.startsWith('img:')) {
      const id = await local(cover.slice(4), 'cover.jpg', 'image/jpeg')
      cover = id ? `img:${id}` : null
    }
    const rec = await db.put('note', {
      title: open.title,
      subjectId: null,
      cover,
      content: (await swapFiles(latest.content ?? null, local)) ?? null,
      cues: (await swapFiles(latest.cues ?? null, local)) ?? undefined,
      summary: (await swapFiles(latest.summary ?? null, local)) ?? undefined,
      template: (latest.template as NoteTemplate) || undefined,
      icon: latest.icon || undefined,
      excerpt: [docText(latest.content), docText(latest.cues), docText(latest.summary)].join(' ').slice(0, 300)
    })
    setSaving(false)
    toast('Saved a copy to your notes')
    onCopied(rec.id)
  }
  const remove = async () => {
    await stopSharing(pick.id).catch(() => {})
    toast('Removed from Shared')
    onRemoved()
  }
  return (
    <div className="note-pane shared-pane">
      <div className="hist-bar">
        {onBack && (
          <button className="btn ghost sm" onClick={onBack}>
            ‹ Shared
          </button>
        )}
        <span className="hist-when">
          {open ? (
            <>
              {can === 'edit' ? <Pencil size={13} /> : <Eye size={13} />} {can === 'edit' ? 'Editing with' : 'Shared by'} {open.from.displayName || open.from.username}
            </>
          ) : (
            'Opening…'
          )}
        </span>
        <button className="btn sec sm" disabled={!open || saving} onClick={() => void keep()}>
          <Check size={14} /> Save a copy
        </button>
        <button className="iconbtn plain" aria-label="Remove from Shared" title="Remove from Shared" onClick={() => void remove()}>
          <Trash2 size={15} />
        </button>
      </div>
      <div className="hist-preview">
        {error && <p className="share-err">{error}</p>}
        {open && <SharedDoc key={pick.id} title={open.title} body={open.body} files={(fid) => readSharedFile(fid, pick.link ? pick.id : '')} docId={open.docId} share={pick.link ? pick.id : ''} call={liveCall} onCan={setCan} who={who} />}
      </div>
    </div>
  )
}

/** The app reaches the live document while signed in. */
const liveCall: Caller = async (method, path, body) => {
  const { groupCall } = await import('../../data/groups')
  return groupCall(method, path, body)
}

/* ---------- the website's page for a link (/s/<id>) ---------- */

/** Through the website's own address (no account needed for what the link allows). */
const webCall: Caller = async (method, path, body) => {
  const r = await fetch(`/api/group${path}`, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `The server answered ${r.status}.`)
  return j
}

/** The document behind a link, like a Google Doc: read it, or edit it with others (signed in, or when the link allows anyone). */
export function PublicSharePage({ id }: { id: string }) {
  const [state, setState] = useState<{ title: string; body: SharedBody; from: string; role: Role; signin: boolean; docId?: string; updatedAt: number } | { error: string } | null>(null)
  const [can, setCan] = useState<LiveDoc['can']>(null)
  const [account, setAccount] = useState<{ signedIn: boolean; name: string } | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => {
    void window.veyra.account.state().then((a) => setAccount({ signedIn: a.mode === 'account', name: a.user?.displayName || a.user?.username || 'Guest' }))
  }, [])
  useEffect(() => {
    fetch(`/api/group/shares/public/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(r.status === 503 ? 'The Veyra server is resting right now (it sleeps from about 12 am to 8 am). Try again later.' : j.error || 'This link doesn’t work.')
        setState({ title: j.title, body: parseBody(j.content), from: j.from, role: j.role ?? 'view', signin: j.signin !== false, docId: j.docId, updatedAt: j.updatedAt })
        rememberLink({ id, title: j.title, from: j.from, at: Date.now() })
        document.title = `${j.title} · Veyra Study`
      })
      .catch((e: Error) => setState({ error: e.message }))
  }, [id])
  // Signed in: it's kept in your Notes → Shared too, on every device.
  useEffect(() => {
    if (account?.signedIn) void liveCall('POST', `/shares/${encodeURIComponent(id)}/save`).catch(() => {})
  }, [account?.signedIn, id])
  if (!account) return null
  if (signingIn)
    return (
      <Welcome
        notice="Sign in to edit this note. You'll come straight back to it."
        onDone={() => location.reload()}
        onCancel={() => setSigningIn(false)}
      />
    )
  const call: Caller = account.signedIn ? liveCall : webCall
  const files: RemoteFiles = (fid) => call('GET', `/files/${encodeURIComponent(fid)}?share=${encodeURIComponent(id)}`)
  const openInApp = () => {
    try {
      localStorage.setItem(PENDING_SHARE, id)
    } catch {
      /* it still opens Notes */
    }
    location.href = '/#notes'
  }
  const editableHere = state && 'role' in state && state.role === 'edit'
  return (
    <div className="share-page">
      <header className="share-page-head">
        <a href="/" className="share-brand">
          <img src="/icon.png" alt="" width={22} height={22} /> Veyra Study
        </a>
        {state && 'from' in state && (
          <span className="sm dim share-page-meta">
            {can === 'edit' ? (
              <>
                <Pencil size={13} /> Editing · shared by {state.from}
              </>
            ) : (
              <>
                <Eye size={13} /> {editableHere && !account.signedIn ? 'Viewing' : 'View only'} · shared by {state.from}
              </>
            )}
            {account.signedIn ? (
              <span className="share-me" title={`Signed in as ${account.name}`}>
                <span className="share-me-dot" style={{ background: personColor(account.name) }} />
                {account.name}
              </span>
            ) : editableHere && state.signin ? (
              <button className="btn sm" onClick={() => setSigningIn(true)}>
                <Pencil size={13} /> Sign in to edit
              </button>
            ) : (
              <button className="btn sec sm" onClick={() => setSigningIn(true)}>
                Sign in
              </button>
            )}
            {account.signedIn && (
              <button className="btn sec sm" onClick={openInApp} title="Opens Veyra Study, with this note in Notes → Shared">
                Open in Veyra Study
              </button>
            )}
          </span>
        )}
      </header>
      <main className="share-page-body">
        {!state ? (
          <p className="dim">Opening…</p>
        ) : 'error' in state ? (
          <p className="share-err">{state.error}</p>
        ) : (
          <SharedDoc key={account.signedIn ? 'in' : 'out'} title={state.title} body={state.body} files={files} docId={state.docId} share={id} call={call} onCan={setCan} who={account.name} />
        )}
      </main>
    </div>
  )
}
