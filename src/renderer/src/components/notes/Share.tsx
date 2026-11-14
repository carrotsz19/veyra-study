import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Check, Copy, Eye, Inbox, Link2, Pencil, Send, Trash2, UserRound, X } from 'lucide-react'
import type { Note, NoteTemplate } from '@shared/types'
import { Dialog, useToast } from '../ui'
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
function LiveArea({ live, field, editable, onEditor }: { live: LiveDoc; field: string; editable: boolean; onEditor: (e: Editor) => void }) {
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
      extensions: noteExtensions(editable ? 'Write here…' : '', false, false, ready ? { doc: live.doc, field } : undefined),
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
  onCan
}: {
  title: string
  body: SharedBody
  files: RemoteFiles
  docId?: string
  share?: string
  call?: Caller
  onCan?: (can: LiveDoc['can']) => void
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
    live ? <LiveArea live={live} field={field} editable={can === 'edit'} onEditor={onEditor(field)} /> : <StaticArea doc={body[field]} />
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

function RoleSelect({ value, onChange, disabled, label }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string }) {
  return (
    <select className="share-role" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)}>
      <option value="view">Viewer</option>
      <option value="edit">Editor</option>
    </select>
  )
}

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
          <select className="share-link-mode" aria-label="Who the link lets in" value={linkMode} disabled={busy} onChange={(e) => setLink(e.target.value as 'off' | Role)}>
            <option value="off">Off: only the people above</option>
            <option value="view">Anyone with the link can view</option>
            <option value="edit">Anyone with the link can edit</option>
          </select>
          {link?.role === 'edit' && (
            <label className="share-check">
              <input type="checkbox" checked={link.signin} disabled={busy} onChange={(e) => void run(() => setRole(link.id, 'edit', e.target.checked))} />
              <span>
                Editors must sign in <span className="dim">(so every change has a name; off lets anyone with the link edit)</span>
              </span>
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

/* ---------- Notes → Shared with you ---------- */

type Opened = { id: string; title: string; body: SharedBody; from: Received['from']; role: Role; docId: string; updatedAt: number }

/** What people shared with you: read it, edit it with them (Editors), keep a copy, or take it off the list. `openId` opens a link someone gave you. */
export function SharedInbox({ onClose, onCopied, openId }: { onClose: () => void; onCopied: (noteId: string) => void; openId?: string }) {
  const toast = useToast()
  const [list, setList] = useState<Received[] | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<string | null>(openId ?? null)
  const [open, setOpen] = useState<Opened | null>(null)
  const [can, setCan] = useState<LiveDoc['can']>(null)
  useEffect(() => {
    sharedWithMe().then(setList, (e) => {
      setList([])
      setError(clean(e, 'Couldn’t reach the Veyra server.'))
    })
  }, [])
  useEffect(() => {
    if (!pick) return setOpen(null)
    setOpen(null)
    readShare(pick).then(
      (r) => setOpen({ id: pick, title: r.title, body: parseBody(r.content), from: r.from, role: r.role, docId: r.docId, updatedAt: r.updatedAt }),
      (e) => setError(clean(e, 'Couldn’t open it.'))
    )
  }, [pick])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const [saving, setSaving] = useState(false)
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
    // The newest text (the plain copy is updated a few seconds after people type).
    const latest = parseBody((await readShare(open.id).catch(() => ({ content: JSON.stringify(open.body) }))).content)
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
  const remove = async (id: string) => {
    await stopSharing(id).catch(() => {})
    setList((l) => l?.filter((x) => x.id !== id) ?? null)
    if (pick === id) setPick(null)
  }
  const inList = !!list?.some((s) => s.id === pick)
  return (
    <div className="scrim hist-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`hist ${pick ? 'hist-reading' : ''}`} role="dialog" aria-modal="true" aria-label="Shared with you">
        <aside className="hist-list">
          <div className="hist-head">
            <Inbox size={17} />
            <b>Shared with you</b>
            <button className="iconbtn plain" aria-label="Close" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
          {error && (
            <p className="share-err" style={{ margin: '0 16px' }}>
              {error}
            </p>
          )}
          {list === null ? (
            <p className="hist-empty">Loading…</p>
          ) : list.length === 0 ? (
            <p className="hist-empty">Nothing yet. When someone shares a note with your @username, it shows up here.</p>
          ) : (
            <ul>
              {list.map((s) => (
                <li key={s.id}>
                  <button className="hist-row" aria-current={pick === s.id || undefined} onClick={() => setPick(s.id)}>
                    <b>{s.title}</b>
                    <span>
                      {s.role === 'edit' ? 'You can edit' : 'You can view'} · from {s.from.displayName || s.from.username} · {formatDistanceToNowStrict(s.updatedAt, { addSuffix: true })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hist-foot">Editors write together and see each other’s changes as they happen. Save a copy to keep your own.</p>
        </aside>
        <section className="hist-main">
          {pick ? (
            <>
              <div className="hist-bar">
                <button className="btn ghost sm share-back" onClick={() => setPick(null)}>
                  ‹ Back
                </button>
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
                {inList && (
                  <button className="iconbtn plain" aria-label="Remove from this list" title="Remove from this list" onClick={() => void remove(pick)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="hist-preview">
                {open && <SharedDoc key={open.id} title={open.title} body={open.body} files={readSharedFile} docId={open.docId} share={inList ? '' : open.id} call={liveCall} onCan={setCan} />}
              </div>
            </>
          ) : (
            <p className="hist-empty center">Pick a note to read it.</p>
          )}
        </section>
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

/** The note, live; editable right here when the link lets anyone edit without signing in. */
export function PublicSharePage({ id }: { id: string }) {
  const [state, setState] = useState<{ title: string; body: SharedBody; from: string; role: Role; signin: boolean; docId?: string; updatedAt: number } | { error: string } | null>(null)
  const [can, setCan] = useState<LiveDoc['can']>(null)
  useEffect(() => {
    fetch(`/api/group/shares/public/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(r.status === 503 ? 'The Veyra server is resting right now (it sleeps from about 12 am to 8 am). Try again later.' : j.error || 'This link doesn’t work.')
        setState({ title: j.title, body: parseBody(j.content), from: j.from, role: j.role ?? 'view', signin: j.signin !== false, docId: j.docId, updatedAt: j.updatedAt })
        document.title = `${j.title} · Veyra Study`
      })
      .catch((e: Error) => setState({ error: e.message }))
  }, [id])
  const files: RemoteFiles = (fid) => webCall('GET', `/files/${encodeURIComponent(fid)}?share=${encodeURIComponent(id)}`)
  // Editing that needs an account happens in the full website, signed in.
  const openSignedIn = () => {
    try {
      localStorage.setItem('veyra.lastRoute', 'notes')
      sessionStorage.setItem('veyra.openShare', id)
    } catch {
      /* the link still opens; the note just isn't picked */
    }
    location.href = '/'
  }
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
                <Pencil size={13} /> You can edit · shared by {state.from}
              </>
            ) : (
              <>Shared by {state.from}</>
            )}
            {state.role === 'edit' && state.signin && can !== 'edit' && (
              <button className="btn sm" onClick={openSignedIn}>
                <Pencil size={13} /> Sign in to edit
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
          <SharedDoc title={state.title} body={state.body} files={files} docId={state.docId} share={id} call={webCall} onCan={setCan} />
        )}
      </main>
    </div>
  )
}
