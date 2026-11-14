import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Check, Copy, Inbox, Link2, Send, Trash2, UserRound, X } from 'lucide-react'
import type { Note, NoteTemplate } from '@shared/types'
import { Dialog, useToast } from '../ui'
import { noteExtensions, docText } from './extensions'
import { db } from '../../data/store'
import { parseBody, readShare, readSharedFile, shareLink, shareNote, sharedWithMe, sharesOf, stopSharing, swapFiles, type Received, type SharedBody, type ShareInfo } from '../../lib/share'
import { fileSrc, setRemoteFiles, type RemoteFiles } from './attachment'
import { NOTE_COVERS } from './covers'

const clean = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
  // An older server doesn't know about sharing yet.
  return m === 'Not found.' ? 'Sharing needs the newest Veyra server, which isn’t running yet. Try again later.' : m
}

/** One area of a shared note, read-only. */
function Area({ doc }: { doc: unknown }) {
  const editor = useEditor({ extensions: noteExtensions('', false, false), content: (doc as object) ?? '', editable: false, immediatelyRender: true }, [doc])
  return <EditorContent editor={editor} className="hist-doc" />
}

/** A shared note's cover: a gradient, or its picture (from the server). */
function SharedCover({ cover }: { cover?: string | null }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (cover?.startsWith('img:')) fileSrc(cover.slice(4), 'image/jpeg').then(setSrc, () => setSrc(null))
  }, [cover])
  if (!cover) return null
  if (cover.startsWith('img:')) return src ? <div className="share-cover note-cover-img"><img src={src} alt="" /></div> : null
  return NOTE_COVERS[cover] ? <div className="share-cover" style={{ background: NOTE_COVERS[cover] }} /> : null
}

/** A shared note as its reader sees it: cover, title, the notes, and (Cornell) cues and summary. `files` fetches its pictures and attachments. */
export function SharedDoc({ title, body, files }: { title: string; body: SharedBody; files: RemoteFiles }) {
  setRemoteFiles(files)
  return (
    <div className="share-doc">
      <SharedCover cover={body.cover} />
      {body.icon && <div className="share-icon">{body.icon}</div>}
      <h1 className="hist-title">{title}</h1>
      <Area doc={body.content} />
      {docText(body.cues) && (
        <section className="share-extra">
          <h2>Cues and questions</h2>
          <Area doc={body.cues} />
        </section>
      )}
      {docText(body.summary) && (
        <section className="share-extra">
          <h2>Summary</h2>
          <Area doc={body.summary} />
        </section>
      )}
    </div>
  )
}

/** Note ••• → Share: a link anyone can read, and people you've sent it to. */
export function ShareDialog({ noteId, note, onClose }: { noteId: string; note: () => Note; onClose: () => void }) {
  const toast = useToast()
  const [list, setList] = useState<ShareInfo[] | null>(null)
  const [error, setError] = useState('')
  const [to, setTo] = useState('')
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
  return (
    <Dialog title="Share this note" onClose={onClose} width={480}>
      <p className="sm dim" style={{ marginTop: -6 }}>
        People get a read-only copy that stays up to date as you edit, with its pictures and files (up to 15 MB each).
      </p>
      {error && <p className="share-err">{error}</p>}
      {busy && <p className="sm dim">Sharing… (pictures and files upload the first time)</p>}

      <h4 className="share-h">
        <Link2 size={15} /> Link
      </h4>
      {list === null ? (
        <p className="sm dim">Loading…</p>
      ) : link ? (
        <div className="share-link">
          <input readOnly value={shareLink(link.id)} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
          <button className="btn sm" onClick={() => void copy(link.id)}>
            <Copy size={14} /> Copy
          </button>
          <button className="btn ghost sm" disabled={busy} onClick={() => void run(() => stopSharing(link.id))} title="Anyone with the link can no longer open it">
            Stop
          </button>
        </div>
      ) : (
        <button className="btn sec" disabled={busy} onClick={() => void run(async () => copy((await shareNote(noteId, note())).id))}>
          <Link2 size={15} /> Make a link anyone can read
        </button>
      )}

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
            await shareNote(noteId, note(), who)
            setTo('')
            toast(`Shared with @${who.replace(/^@/, '')}`)
          })
        }}
      >
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@username" aria-label="Share with (username)" autoCapitalize="off" spellCheck={false} />
        <button className="btn sm" disabled={busy || !to.trim()}>
          <Send size={14} /> Share
        </button>
      </form>
      {people.length > 0 && (
        <ul className="share-people">
          {people.map((p) => (
            <li key={p.id}>
              <span className="grow">
                <b>{p.to!.displayName || p.to!.username}</b> <span className="dim">@{p.to!.username}</span>
              </span>
              <button className="iconbtn plain" aria-label={`Stop sharing with @${p.to!.username}`} title="Stop sharing with them" disabled={busy} onClick={() => void run(() => stopSharing(p.id))}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

/** Notes → Shared with you: what people sent you. Read it, keep a copy, or take it off the list. */
export function SharedInbox({ onClose, onCopied }: { onClose: () => void; onCopied: (noteId: string) => void }) {
  const toast = useToast()
  const [list, setList] = useState<Received[] | null>(null)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState<{ title: string; body: SharedBody; from: Received['from']; updatedAt: number } | null>(null)
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
      (r) => setOpen({ title: r.title, body: parseBody(r.content), from: r.from, updatedAt: r.updatedAt }),
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
        const a = await window.veyra.files.fromBytes(name || f.name, mime || f.mime, Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)))
        return a.id
      } catch {
        return null
      }
    }
    const b = open.body
    let cover = b.cover ?? null
    if (cover?.startsWith('img:')) {
      const id = await local(cover.slice(4), 'cover.jpg', 'image/jpeg')
      cover = id ? `img:${id}` : null
    }
    const rec = await db.put('note', {
      title: open.title,
      subjectId: null,
      cover,
      content: (await swapFiles(b.content ?? null, local)) ?? null,
      cues: (await swapFiles(b.cues ?? null, local)) ?? undefined,
      summary: (await swapFiles(b.summary ?? null, local)) ?? undefined,
      template: (b.template as NoteTemplate) || undefined,
      icon: b.icon || undefined,
      excerpt: [docText(b.content), docText(b.cues), docText(b.summary)].join(' ').slice(0, 300)
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
          {error && <p className="share-err" style={{ margin: '0 16px' }}>{error}</p>}
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
                      From {s.from.displayName || s.from.username} · updated {formatDistanceToNowStrict(s.updatedAt, { addSuffix: true })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hist-foot">Shared notes are read-only and stay up to date. Save a copy to change your own.</p>
        </aside>
        <section className="hist-main">
          {pick ? (
            <>
              <div className="hist-bar">
                <button className="btn ghost sm share-back" onClick={() => setPick(null)}>
                  ‹ Back
                </button>
                <span className="hist-when">{open ? `From ${open.from.displayName || open.from.username}` : 'Opening…'}</span>
                <button className="btn sec sm" disabled={!open || saving} onClick={() => void keep()}>
                  <Check size={14} /> Save a copy
                </button>
                <button className="iconbtn plain" aria-label="Remove from this list" title="Remove from this list" onClick={() => void remove(pick)}>
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="hist-preview">{open && <SharedDoc title={open.title} body={open.body} files={readSharedFile} />}</div>
            </>
          ) : (
            <p className="hist-empty center">Pick a note to read it.</p>
          )}
        </section>
      </div>
    </div>
  )
}

/** The website's page for a share link (/s/<id>): the note, read-only, no account needed. */
export function PublicSharePage({ id }: { id: string }) {
  const [state, setState] = useState<{ title: string; body: SharedBody; from: string; updatedAt: number } | { error: string } | null>(null)
  useEffect(() => {
    fetch(`/api/group/shares/public/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(r.status === 503 ? 'The Veyra server is resting right now (it sleeps from about 12 am to 8 am). Try again later.' : j.error || 'This link doesn’t work.')
        setState({ title: j.title, body: parseBody(j.content), from: j.from, updatedAt: j.updatedAt })
        document.title = `${j.title} · Veyra Study`
      })
      .catch((e: Error) => setState({ error: e.message }))
  }, [id])
  return (
    <div className="share-page">
      <header className="share-page-head">
        <a href="/" className="share-brand">
          <img src="/icon.png" alt="" width={22} height={22} /> Veyra Study
        </a>
        {state && 'from' in state && (
          <span className="sm dim">
            Shared by {state.from} · updated {formatDistanceToNowStrict(state.updatedAt, { addSuffix: true })}
          </span>
        )}
      </header>
      <main className="share-page-body">
        {!state ? <p className="dim">Opening…</p> : 'error' in state ? <p className="share-err">{state.error}</p> : <SharedDoc title={state.title} body={state.body} files={(fid) => fetch(`/api/group/files/${encodeURIComponent(fid)}?share=${encodeURIComponent(id)}`).then(async (r) => { if (!r.ok) throw new Error('unavailable'); return r.json() })} />}
      </main>
    </div>
  )
}
