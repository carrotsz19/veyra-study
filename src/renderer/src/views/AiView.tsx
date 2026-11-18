import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CloudOff, History, Lock, LockKeyhole, NotebookPen, Pencil, RefreshCw, Search, Sparkles, SquarePen, Trash2 } from 'lucide-react'
import { docPlain, markdownToDoc, noteMarkdown } from '@shared/notetext'
import type { Note, Rec } from '@shared/types'
import { useNav } from '../nav'
import { useAccount } from '../components/account'
import { useToast } from '../components/ui'
import { AgentPanel } from '../components/notes/AgentPanel'
import { chatInfo, deleteChat, listChats, newChatId, renameChat, type NoteContext, type PastChat } from '../data/agent'
import { db, useRecords } from '../data/store'
import { groupCall } from '../data/groups'
import type { VeyraAiStatus } from '../data/veyra-ai'
import { usePhone } from '../lib/phone'
import { syncNow, useChatSync } from '../data/chat-sync'

/**
 * The Veyra AI tab: every AI chat in one place, like claude.ai — the chats on the left (newest
 * first, with search), the open chat on the right. Chats of their own start here; a note's chats
 * (from its Assistant) are here too, and carry on here knowing their note.
 *
 * While it's tried out, it's open to the owner only, and to everyone approved for Veyra AI once
 * the owner turns it on (Owner → AI). Everyone else sees "Coming soon".
 */

/** Whether the tab is open to this person: the owner, or everyone once the owner allows it. null while checking. */
let openCache: boolean | null = null
export function useAiTabOpen(): boolean | null {
  const signedIn = useAccount().state.mode === 'account'
  const [open, setOpen] = useState<boolean | null>(signedIn ? openCache : false)
  useEffect(() => {
    if (!signedIn) return setOpen(false)
    let live = true
    groupCall<VeyraAiStatus>('GET', '/ai')
      .then((s) => {
        openCache = !!(s.owner || (s.approved && s.aiTab))
        if (live) setOpen(openCache)
      })
      .catch(() => live && setOpen(openCache ?? false))
    return () => {
      live = false
    }
  }, [signedIn])
  return open
}

export function AiView({ chatId }: { chatId?: string }) {
  const open = useAiTabOpen()
  if (open === null) return null
  return open ? <AiChats initial={chatId} /> : <ComingSoon />
}

function ComingSoon() {
  const { go } = useNav()
  return (
    <div className="inner view ai-locked">
      <div className="topbar">
        <h1>Veyra AI</h1>
      </div>
      <div className="ai-soon">
        <div className="ai-soon-icon">
          <Sparkles size={26} />
          <span className="ai-soon-lock">
            <Lock size={13} />
          </span>
        </div>
        <h2>Update Coming Soon!</h2>
        <p className="ai-soon-sub">Stay Tuned!</p>
        <p className="dim">
          This tab will be a home for AI chats of their own, not tied to a note. For now, open the Assistant in any note, and use <History size={13} className="ai-soon-inline" /> Past chats there to get back to your earlier chats from any note.
        </p>
        <button className="btn sec" onClick={() => go({ name: 'notes' })}>
          <NotebookPen size={15} /> Go to Notes
        </button>
      </div>
    </div>
  )
}

const DAY = 86_400_000
/** 3:40 PM today, Tue this week, 12 Nov before that. */
const when = (at: number) => {
  const d = new Date(at)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (at >= today.getTime()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at >= today.getTime() - 6 * DAY) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}
const groupOf = (at: number) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (at >= today.getTime()) return 'Today'
  if (at >= today.getTime() - 6 * DAY) return 'Previous 7 days'
  return 'Older'
}

/** A note as the Assistant sees it, without its editor open: read from, and added to, the saved note. */
function useNoteContext(rec: Rec<'note'> | undefined): NoteContext | null {
  const latest = useRef<Note | undefined>(rec?.data)
  if (rec) latest.current = rec.data
  const id = rec?.id
  const title = rec?.data.title || 'Untitled'
  return useMemo(() => {
    if (!id) return null
    const save = (next: Note) => {
      latest.current = next
      void db.put('note', next, id)
    }
    return {
      id,
      title,
      markdown: () => (latest.current ? noteMarkdown(latest.current).replace(/^# [^\n]*\n*/, '') : ''),
      append: (md: string) => {
        const d = latest.current
        if (!d) return
        const doc = (d.content as { type: string; content?: unknown[] } | null) ?? { type: 'doc', content: [] }
        const content = { type: 'doc', content: [...(doc.content ?? []), ...markdownToDoc(md).content] }
        save({ ...d, content, excerpt: docPlain(content).slice(0, 300) } as Note)
      },
      snapshot: () => latest.current as Note,
      restore: (was: Note) => save(was)
    }
  }, [id, title])
}

/** Under the chats: whether they sync (encrypted) to your other devices. */
function SyncLine() {
  const sync = useChatSync()
  const { go } = useNav()
  const toSettings = () => {
    sessionStorage.setItem('veyra.settingsSection', 'account')
    go({ name: 'settings' })
  }
  if (sync.status === 'on')
    return (
      <button className="aic-sync" onClick={() => void syncNow()} title={sync.error || 'Encrypted on your devices: only you can read them. Click to sync now.'}>
        {sync.syncing ? <RefreshCw size={12} className="spin" /> : <LockKeyhole size={12} />}
        <span className="grow">{sync.error ? 'Couldn’t sync just now' : 'Synced, end-to-end encrypted'}</span>
      </button>
    )
  return (
    <button className="aic-sync" onClick={toSettings} title="Settings → Account → AI chats sync">
      <CloudOff size={12} />
      <span className="grow">{sync.status === 'locked' ? 'Locked on this device: unlock to sync' : sync.status === 'unavailable' ? 'On this device (sync unavailable)' : 'On this device only: turn on sync'}</span>
    </button>
  )
}

function AiChats({ initial }: { initial?: string }) {
  const phone = usePhone()
  const toast = useToast()
  const { go } = useNav()
  const [chats, setChats] = useState(listChats)
  const [current, setCurrent] = useState(() => initial ?? newChatId())
  // On the phone the list and the chat are separate screens: the list first.
  const [listOpen, setListOpen] = useState(phone && !initial)
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const { items: notes } = useRecords('note')

  useEffect(() => {
    const again = () => setChats(listChats())
    window.addEventListener('veyra:chats', again)
    return () => window.removeEventListener('veyra:chats', again)
  }, [])
  useEffect(() => {
    if (!initial) return
    setCurrent(initial)
    setListOpen(false)
  }, [initial])

  const startNew = () => {
    setCurrent(newChatId())
    setListOpen(false)
  }
  // Ctrl+N: a new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        startNew()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const noteById = useMemo(() => new Map(notes.filter((n) => !n.data.trashedAt).map((n) => [n.id, n])), [notes])
  const nameOf = (c: PastChat) => (c.noteId ? noteById.get(c.noteId)?.data.title || c.title || 'Untitled note' : c.title || c.first || 'New chat')
  const shown = useMemo(() => {
    const terms = q.trim().toLowerCase()
    return terms ? chats.filter((c) => `${nameOf(c)} ${c.first}`.toLowerCase().includes(terms)) : chats
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, q, noteById])

  const open = chats.find((c) => c.id === current)
  const noteId = open?.noteId ?? chatInfo(current)?.noteId ?? null
  const noteRec = noteId ? noteById.get(noteId) : undefined
  const ctx = useNoteContext(noteRec)
  const title = open ? nameOf(open) : 'New chat'

  const remove = (c: PastChat) => {
    deleteChat(c.id)
    if (c.id === current) setCurrent(newChatId())
    toast('Chat deleted')
  }
  const saveAsNote = async (md: string) => {
    const content = markdownToDoc(md)
    const name = (open?.title || 'From Veyra AI').slice(0, 120)
    const rec = await db.put('note', { title: name, subjectId: null, content, excerpt: docPlain(content).slice(0, 300) } as Note)
    toast(`Saved as the note “${name}”`, { label: 'Open', run: () => go({ name: 'notes', noteId: rec.id }) })
  }

  const list = (
    <nav className="aic-list" aria-label="Chats">
      <div className="aic-top">
        <span className="aic-top-mark" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <b className="grow">Veyra AI</b>
        <button className="iconbtn aic-new" aria-label="New chat" title="New chat (Ctrl+N)" onClick={startNew}>
          <SquarePen size={16} />
        </button>
      </div>
      <label className="aic-search">
        <Search size={14} />
        <input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
      </label>
      <div className="aic-scroll">
        {!shown.length && <p className="xs dim aic-empty">{q ? 'No chats match.' : 'Your chats show up here: the ones you start here, and the ones beside your notes.'}</p>}
        {shown.map((c, i) => {
          const group = groupOf(c.at)
          const name = nameOf(c)
          return (
            <div key={c.id}>
              {(i === 0 || groupOf(shown[i - 1].at) !== group) && <div className="aic-group">{group}</div>}
              <div className={`aic-row ${c.id === current ? 'on' : ''}`}>
                {editing === c.id ? (
                  <input
                    className="aic-rename"
                    autoFocus
                    defaultValue={name}
                    aria-label="Chat name"
                    onBlur={(e) => {
                      renameChat(c.id, e.target.value)
                      setEditing(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <button
                    className="aic-open"
                    onClick={() => {
                      setCurrent(c.id)
                      setListOpen(false)
                    }}
                    title={c.noteId ? `A chat from the note “${name}”` : name}
                  >
                    <span className="aic-name trunc">{name}</span>
                    <span className="aic-meta trunc">
                      {c.noteId && <NotebookPen size={11} aria-hidden="true" />}
                      {c.noteId ? (noteById.has(c.noteId) ? 'Note' : 'Note deleted') : `${Math.ceil(c.count / 2)} ${c.count > 2 ? 'questions' : 'question'}`} · {when(c.at)}
                    </span>
                  </button>
                )}
                {!c.noteId && editing !== c.id && (
                  <button className="iconbtn plain aic-act" aria-label={`Rename ${name}`} title="Rename" onClick={() => setEditing(c.id)}>
                    <Pencil size={13} />
                  </button>
                )}
                {editing !== c.id && (
                  <button className="iconbtn plain aic-act" aria-label={`Delete ${name}`} title="Delete" onClick={() => remove(c)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <SyncLine />
    </nav>
  )

  const heading = (
    <>
      {phone && (
        <button className="iconbtn plain" aria-label="All chats" onClick={() => setListOpen(true)}>
          <ArrowLeft size={17} />
        </button>
      )}
      {noteId && (
        <span className="ai-badge">
          <NotebookPen size={14} />
        </span>
      )}
      <span className="grow aic-title">
        <b className="trunc">{title}</b>
        {noteId &&
          (noteRec ? (
            <button className="linkbtn xs" onClick={() => go({ name: 'notes', noteId: noteRec.id })}>
              Open note
            </button>
          ) : (
            <span className="xs tert">Its note was deleted</span>
          ))}
      </span>
    </>
  )

  return (
    <div className={`aic ${phone ? (listOpen ? 'aic-phone-list' : 'aic-phone-chat') : ''}`}>
      {(!phone || listOpen) && list}
      {(!phone || !listOpen) && (
        <AgentPanel
          key={current}
          chatKey={current}
          note={ctx}
          variant="page"
          heading={heading}
          onInsert={ctx ? (md) => (ctx.append(md), toast(`Added to “${ctx.title}”`)) : (md) => void saveAsNote(md)}
          insertLabel={ctx ? 'Add to the note' : 'Save as a note'}
        />
      )}
    </div>
  )
}
