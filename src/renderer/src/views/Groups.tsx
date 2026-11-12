import { useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  Check,
  ChevronLeft,
  CalendarClock,
  Copy,
  Crown,
  FileText,
  ListTodo,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserPlus,
  Users,
  WifiOff,
  X
} from 'lucide-react'
import type { Editor } from '@tiptap/react'
import type { Group, GroupInvite, GroupItem, GroupNote, GroupPreview, GroupTask, GroupUser } from '@shared/types'
import { Dialog, Empty, Seg, useToast } from '../components/ui'
import { Avatar, useAccount } from '../components/account'
import { ServerHoursBanner } from '../components/ServerHours'
import { Area } from '../components/notes/NoteEditor'
import { NoteToolbar } from '../components/notes/Toolbar'
import { SlashMenu } from '../components/notes/SlashMenu'
import { docText } from '../components/notes/extensions'
import { useSettings } from '../data/settings'
import { useNav } from '../nav'
import { usePhone } from '../lib/phone'
import { transition } from '../lib/motion'
import { dueLabel, isOverdue, todayKey } from '../lib/dates'
import {
  GROUP_COLORS,
  GroupCallError,
  addItem,
  deleteItem,
  gid,
  groupCall,
  saveItem,
  useGroupItems,
  useGroupStatus,
  useGroups,
  type ItemsApi
} from '../data/groups'
import '../notes.css'
import '../groups.css'
import { Select } from '../components/Select'
import { DateField, TimeField } from '../components/DateTime'

type Tab = 'tasks' | 'chat' | 'notes' | 'deadlines' | 'members'
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.')

export function Groups() {
  const account = useAccount().state
  const { go } = useNav()
  const { status, retry } = useGroupStatus()
  const online = status?.state === 'online'
  const { groups, invites, reload, setGroups } = useGroups(online)
  const [openId, setOpenId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('veyra.group') || null
    } catch {
      return null
    }
  })
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null)
  const toast = useToast()
  // On a phone the list of groups comes first; tapping one opens it as its own page.
  const phone = usePhone()
  const [phoneOpen, setPhoneOpen] = useState(false)

  useEffect(() => {
    try {
      if (openId) localStorage.setItem('veyra.group', openId)
    } catch {
      /* storage unavailable */
    }
  }, [openId])

  if (account.mode !== 'account')
    return (
      <div className="inner view">
        <Header />
        <div className="card">
          <Empty
            icon={Users}
            title="Sign in to work with your group"
            text="Group work uses your Veyra account, so classmates can find you by @username."
            action={
              <button className="btn" onClick={() => go({ name: 'settings' })}>
                Sign in
              </button>
            }
          />
        </div>
      </div>
    )

  if (!groups && (!status || status.state === 'connecting' || status.state === 'idle' || online))
    return (
      <div className="inner view">
        <Header />
        <div className="card grp-status">
          <RefreshCw size={16} className="spin" /> Connecting to the group server…
        </div>
      </div>
    )

  if (!groups)
    return (
      <div className="inner view">
        <Header />
        <ServerHoursBanner />
        <div className="card grp-status grp-offline">
          <WifiOff size={18} />
          <div className="grow">
            <b>Can’t reach the group server</b>
            <div className="sm dim">{status?.error || 'It may be switched off or restarting. Your own tasks and notes still work.'}</div>
          </div>
          <button className="btn sec" onClick={retry}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      </div>
    )

  const open = groups.find((g) => g.id === openId) ?? groups[0] ?? null
  const answer = async (inv: GroupInvite, a: 'accept' | 'decline') => {
    try {
      const r = await groupCall<{ group?: Group }>('POST', `/invites/${gid(inv.id)}/${a}`)
      await reload()
      if (r.group) {
        setOpenId(r.group.id)
        toast(`You joined ${r.group.name}`)
      }
    } catch (e) {
      toast(msg(e))
    }
  }

  return (
    <div className={`inner view grp ${phone && phoneOpen && open ? 'grp-phone-open' : ''}`}>
      <Header>
        <button className="btn ghost" onClick={() => setDialog('join')}>
          Join with a code
        </button>
        <button className="btn" onClick={() => setDialog('new')}>
          <Plus size={16} /> New group
        </button>
      </Header>

      <ServerHoursBanner />

      {status && status.state !== 'online' && (
        <div className="card grp-status grp-offline grp-banner">
          {status.state === 'connecting' ? <RefreshCw size={16} className="spin" /> : <WifiOff size={16} />}
          <span className="grow sm">
            {status.state === 'connecting' ? 'Reconnecting… showing what was last loaded.' : `${status.error || 'Can’t reach the group server.'} Showing what was last loaded.`}
          </span>
          {status.state !== 'connecting' && (
            <button className="btn sec sm" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      )}

      {invites.length > 0 && (
        <div className="ig grp-invites">
          {invites.map((inv) => (
            <div key={inv.id} className="ig-row">
              <span className="grp-swatch" style={{ background: inv.group.color }} />
              <div className="grow">
                <div className="ig-title trunc">{inv.group.name}</div>
                <div className="ig-sub">@{inv.invitedBy?.username} invited you</div>
              </div>
              <button className="btn ghost sm" onClick={() => answer(inv, 'decline')}>
                Decline
              </button>
              <button className="btn sm" onClick={() => answer(inv, 'accept')}>
                Join
              </button>
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="card">
          <Empty
            icon={Users}
            title="No groups yet"
            text="Make one for a class project or study group, then invite people by @username or send them the join code."
            action={
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="btn" onClick={() => setDialog('new')}>
                  <Plus size={16} /> New group
                </button>
                <button className="btn ghost" onClick={() => setDialog('join')}>
                  Join with a code
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <div className="grp-layout">
          <nav className="ig grp-list" aria-label="Your groups">
            {groups.map((g) => (
              <button
                key={g.id}
                className="ig-row tap"
                aria-current={!phone && open?.id === g.id}
                onClick={() => {
                  // On a computer the group just switches; on a phone its page slides in.
                  if (phone)
                    transition(() => {
                      setOpenId(g.id)
                      setPhoneOpen(true)
                    }, 'push')
                  else setOpenId(g.id)
                }}
              >
                <span className="grp-swatch" style={{ background: g.color }}>
                  {g.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ig-title trunc">{g.name}</div>
                  <div className="ig-sub">
                    {g.members.length} {g.members.length === 1 ? 'member' : 'members'}
                  </div>
                </div>
              </button>
            ))}
          </nav>
          {open && (!phone || phoneOpen) && (
            <GroupPanel
              key={open.id}
              group={open}
              me={status?.me ?? null}
              onBack={phone ? () => transition(() => setPhoneOpen(false), 'pop') : undefined}
              onChanged={(g) => setGroups((all) => all && all.map((x) => (x.id === g.id ? g : x)))}
              onGone={() => {
                setOpenId(null)
                void reload()
              }}
            />
          )}
        </div>
      )}

      {dialog === 'new' && (
        <NewGroupDialog
          onClose={() => setDialog(null)}
          onMade={(g) => {
            setGroups((all) => [...(all ?? []), g])
            setOpenId(g.id)
          }}
        />
      )}
      {dialog === 'join' && (
        <JoinDialog
          onClose={() => setDialog(null)}
          onJoined={(g) => {
            void reload()
            setOpenId(g.id)
            toast(`You joined ${g.name}`)
          }}
        />
      )}
    </div>
  )
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="topbar">
      <div>
        <h1>Group work</h1>
        <p className="dim">Shared tasks, chat, notes and deadlines with your classmates.</p>
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  )
}

/* ---------- one group ---------- */
function GroupPanel({ group, me, onChanged, onGone, onBack }: { group: Group; me: GroupUser | null; onChanged: (g: Group) => void; onGone: () => void; onBack?: () => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('veyra.groupTab') as Tab) || 'tasks'
    } catch {
      return 'tasks'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('veyra.groupTab', tab)
    } catch {
      /* storage unavailable */
    }
  }, [tab])
  const items = useGroupItems(group.id)
  const openTasks = items.list('task').filter((t) => !t.data.done).length

  return (
    <section className={`grp-panel tab-${tab}`} aria-label={group.name}>
      {onBack && (
        <button className="phone-back" onClick={onBack}>
          <ChevronLeft size={20} /> Groups
        </button>
      )}
      <div className="between grp-head">
        <div className="row" style={{ minWidth: 0 }}>
          <span className="grp-swatch lg" style={{ background: group.color }}>
            {group.name.slice(0, 1).toUpperCase()}
          </span>
          <div style={{ minWidth: 0 }}>
            <h2 className="trunc grp-name">{group.name}</h2>
            <div className="xs dim">
              {openTasks ? `${openTasks} open ${openTasks === 1 ? 'task' : 'tasks'} · ` : ''}
              {group.members.length} {group.members.length === 1 ? 'member' : 'members'}
            </div>
          </div>
        </div>
        <Seg<Tab>
          value={tab}
          onChange={setTab}
          options={[
            ['tasks', 'Tasks'],
            ['chat', 'Chat'],
            ['notes', 'Notes'],
            ['deadlines', 'Deadlines'],
            ['members', 'Members']
          ]}
        />
      </div>
      {/* On a phone only this part scrolls (the chat scrolls its messages instead). */}
      <div className="grp-body">
      {items.error && !items.loaded ? (
        <div className="card grp-status grp-offline">
          <WifiOff size={18} /> <span className="grow">{items.error}</span>
          <button className="btn sec sm" onClick={() => items.reload()}>
            Try again
          </button>
        </div>
      ) : !items.loaded ? (
        <div className="card grp-status">
          <RefreshCw size={16} className="spin" /> Loading…
        </div>
      ) : tab === 'tasks' ? (
        <GroupTasks group={group} items={items} me={me} />
      ) : tab === 'chat' ? (
        <GroupChat group={group} items={items} me={me} />
      ) : tab === 'notes' ? (
        <GroupNotes group={group} items={items} />
      ) : tab === 'deadlines' ? (
        <GroupDeadlines group={group} items={items} />
      ) : (
        <GroupMembers group={group} me={me} onChanged={onChanged} onGone={onGone} />
      )}
      </div>
    </section>
  )
}

const who = (group: Group, username: string | null | undefined) => group.members.find((m) => m.username === username)

/* ---------- tasks ---------- */
function GroupTasks({ group, items, me }: { group: Group; items: ItemsApi; me: GroupUser | null }) {
  const toast = useToast()
  const [quick, setQuick] = useState('')
  const [filter, setFilter] = useState<'open' | 'mine' | 'done'>('open')
  const [editing, setEditing] = useState<GroupItem<'task'> | 'new' | null>(null)
  const all = items.list('task')
  const shown = all
    .filter((t) => (filter === 'done' ? t.data.done : !t.data.done && (filter === 'open' || t.data.assignee === me?.username)))
    .sort((a, b) => (a.data.done ? (b.data.doneAt ?? 0) - (a.data.doneAt ?? 0) : (a.data.due ?? '9999').localeCompare(b.data.due ?? '9999') || a.createdAt - b.createdAt))

  const add = async () => {
    const title = quick.trim()
    if (!title) return
    setQuick('')
    try {
      items.apply(
        await addItem(group.id, 'task', { title, details: '', assignee: filter === 'mine' ? (me?.username ?? null) : null, due: null, done: false, doneBy: null, doneAt: null, priority: 'normal' })
      )
    } catch (e) {
      setQuick(title)
      toast(msg(e))
    }
  }
  const toggle = async (t: GroupItem<'task'>) => {
    const done = !t.data.done
    try {
      items.apply(await saveItem(group.id, t, { ...t.data, done, doneBy: done ? (me?.username ?? null) : null, doneAt: done ? Date.now() : null }))
    } catch (e) {
      toast(msg(e))
    }
  }

  return (
    <>
      <div className="between" style={{ marginBottom: 10 }}>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            ['open', 'Open'],
            ['mine', 'Mine'],
            ['done', 'Done']
          ]}
        />
        <button className="btn sec sm" onClick={() => setEditing('new')}>
          <Plus size={14} /> New task
        </button>
      </div>
      <form
        className="card row quick-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <Plus size={18} className="dim" style={{ marginLeft: 8 }} />
        <input style={{ border: 0 }} placeholder={filter === 'mine' ? 'Add a task for yourself and press Enter' : 'Add a task for the group and press Enter'} value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick add a group task" />
      </form>
      {shown.length ? (
        <div className="ig" style={{ marginTop: 12 }}>
          {shown.map((t) => {
            const a = who(group, t.data.assignee)
            const late = isOverdue(t.data.due, t.data.done)
            return (
              <div
                key={t.id}
                className={`ig-row tap ${t.data.done ? 'task-done' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setEditing(t)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    setEditing(t)
                  }
                }}
              >
                <button
                  className="tick"
                  role="checkbox"
                  aria-checked={t.data.done}
                  aria-label={t.data.done ? 'Mark not done' : 'Mark done'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void toggle(t)
                  }}
                  style={{ marginLeft: 2 }}
                >
                  {t.data.done && <Check size={14} strokeWidth={3} />}
                </button>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ig-title trunc">{t.data.title}</div>
                  <div className="ig-sub trunc">
                    {t.data.done && t.data.doneBy ? `Done by @${t.data.doneBy}` : t.data.details || `Added by @${t.createdBy}`}
                  </div>
                </div>
                {t.data.priority === 'high' && !t.data.done && <span className="pill bad">High</span>}
                {t.data.due && !t.data.done && <span className={`pill ${late ? 'bad' : ''}`}>{dueLabel(t.data.due)}</span>}
                {a ? (
                  <span title={`@${a.username}`}>
                    <Avatar user={a} />
                  </span>
                ) : (
                  !t.data.done && <span className="pill">Anyone</span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card" style={{ marginTop: 12 }}>
          <Empty icon={ListTodo} title={filter === 'done' ? 'Nothing finished yet' : filter === 'mine' ? 'Nothing assigned to you' : 'No open tasks'} text="Add one above. Anyone in the group can tick it off." />
        </div>
      )}
      {editing && <GroupTaskDialog group={group} items={items} task={editing === 'new' ? null : editing} me={me} onClose={() => setEditing(null)} />}
    </>
  )
}

function GroupTaskDialog({ group, items, task, me, onClose }: { group: Group; items: ItemsApi; task: GroupItem<'task'> | null; me: GroupUser | null; onClose: () => void }) {
  const toast = useToast()
  const [d, setD] = useState<GroupTask>(
    task?.data ?? { title: '', details: '', assignee: null, due: null, done: false, doneBy: null, doneAt: null, priority: 'normal' }
  )
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!d.title.trim()) return toast('Give the task a title.')
    setBusy(true)
    try {
      const data = { ...d, doneBy: d.done ? (d.doneBy ?? me?.username ?? null) : null, doneAt: d.done ? (d.doneAt ?? Date.now()) : null }
      items.apply(task ? await saveItem(group.id, task, data) : await addItem(group.id, 'task', data))
      onClose()
    } catch (e) {
      toast(msg(e))
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!task) return
    try {
      await deleteItem(group.id, task.id)
      items.apply({ id: task.id, deleted: true })
      onClose()
    } catch (e) {
      toast(msg(e))
    }
  }
  return (
    <Dialog title={task ? 'Group task' : 'New group task'} onClose={onClose} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="gt-title">
            Task
          </label>
          <input id="gt-title" autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={300} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="gt-details">
            Details
          </label>
          <textarea id="gt-details" rows={3} value={d.details} onChange={(e) => setD({ ...d, details: e.target.value })} maxLength={4000} />
        </div>
        <div className="grid g2 field">
          <div>
            <label className="field-label" htmlFor="gt-who">
              Who’s doing it
            </label>
            <Select
              id="gt-who"
              label="Who’s doing it"
              value={d.assignee ?? ''}
              onChange={(v) => setD({ ...d, assignee: v || null })}
              options={[
                { value: '', label: 'Anyone' },
                ...group.members.map((m) => ({ value: m.username, label: m.username === me?.username ? `${m.displayName} (you)` : m.displayName, hint: `@${m.username}` }))
              ]}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="gt-due">
              Due
            </label>
            <DateField id="gt-due" label="Due" value={d.due ?? null} onChange={(due) => setD({ ...d, due })} />
          </div>
        </div>
        <div className="field">
          <label className="field-label">Priority</label>
          <Seg
            value={d.priority}
            onChange={(priority) => setD({ ...d, priority })}
            options={[
              ['low', 'Low'],
              ['normal', 'Normal'],
              ['high', 'High']
            ]}
          />
        </div>
        {task && (
          <p className="xs dim" style={{ marginTop: 12 }}>
            Added by @{task.createdBy} {format(task.createdAt, 'd MMM')}
            {task.updatedBy !== task.createdBy ? ` · last changed by @${task.updatedBy}` : ''}
          </p>
        )}
        <div className="actions between" style={{ marginTop: 16 }}>
          {task ? (
            <button type="button" className="btn ghost" onClick={remove}>
              <Trash2 size={15} /> Delete
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            <button type="button" className="btn sec" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={busy}>
              {task ? 'Save' : 'Add task'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

/* ---------- chat ---------- */
function GroupChat({ group, items, me }: { group: Group; items: ItemsApi; me: GroupUser | null }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const messages = items.list('message').sort((a, b) => a.createdAt - b.createdAt)
  const last = messages[messages.length - 1]?.id

  // Follow new messages, unless you've scrolled up to read older ones.
  const stuck = useRef(true)
  useEffect(() => {
    if (stuck.current) end.current?.scrollIntoView({ block: 'end' })
  }, [last])

  // Blocks a second send at once (a held or quickly repeated Enter used to post the same message several times).
  const inFlight = useRef(false)
  const send = async () => {
    const t = text.trim()
    if (!t || inFlight.current) return
    inFlight.current = true
    setSending(true)
    // Clear the box straight away, so a repeat Enter has nothing to send; put it back if sending fails.
    setText('')
    try {
      items.apply(await addItem(group.id, 'message', { text: t }))
      stuck.current = true
    } catch (e) {
      setText((cur) => cur || t)
      toast(msg(e))
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }
  const remove = async (m: GroupItem<'message'>) => {
    try {
      await deleteItem(group.id, m.id)
      items.apply({ id: m.id, deleted: true })
    } catch (e) {
      toast(msg(e))
    }
  }

  return (
    <div className="card grp-chat">
      <div
        className="grp-msgs"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {messages.length === 0 && <Empty icon={MessageSquare} title="No messages yet" text={`Say hi to ${group.name}.`} />}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const first = !prev || prev.createdBy !== m.createdBy || m.createdAt - prev.createdAt > 5 * 60_000
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
          const mine = m.createdBy === me?.username
          const u = who(group, m.createdBy) ?? { username: m.createdBy, displayName: m.createdBy, photoUrl: '' }
          return (
            <div key={m.id}>
              {newDay && <div className="grp-day">{format(m.createdAt, 'EEEE d MMMM')}</div>}
              <div className={`grp-msg ${mine ? 'mine' : ''} ${first ? 'first' : ''}`}>
                <div className="grp-msg-av">{first && !mine && <Avatar user={u} />}</div>
                <div className="grp-msg-body">
                  {first && (
                    <div className="xs dim">
                      {mine ? 'You' : u.displayName} · {format(m.createdAt, 'h:mm a')}
                    </div>
                  )}
                  <div className="grp-bubble">{m.data.text}</div>
                </div>
                {(mine || group.role === 'owner') && (
                  <button className="iconbtn plain grp-msg-del" aria-label="Delete message" title="Delete message" onClick={() => remove(m)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
        <div ref={end} />
      </div>
      <form
        className="grp-compose"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          rows={1}
          placeholder={`Message ${group.name}`}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          aria-label="Message"
        />
        <button className="btn" disabled={!text.trim() || sending} aria-label="Send">
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}

/* ---------- notes ---------- */
function GroupNotes({ group, items }: { group: Group; items: ItemsApi }) {
  const toast = useToast()
  const notes = items.list('note').sort((a, b) => b.updatedAt - a.updatedAt)
  const [openId, setOpenId] = useState<string | null>(notes[0]?.id ?? null)
  const open = notes.find((n) => n.id === openId) ?? null

  const create = async () => {
    try {
      const n = await addItem(group.id, 'note', { title: '', icon: '', content: null, excerpt: '' })
      items.apply(n)
      setOpenId(n.id)
    } catch (e) {
      toast(msg(e))
    }
  }

  return (
    <div className="grp-notes">
      <div className="grp-note-list">
        <button className="btn sec sm" style={{ width: '100%', marginBottom: 8 }} onClick={create}>
          <Plus size={14} /> New shared note
        </button>
        <div className="ig">
          {notes.map((n) => (
            <button key={n.id} className="ig-row tap" aria-current={n.id === open?.id} onClick={() => setOpenId(n.id)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ig-title trunc">{n.data.title || 'Untitled'}</div>
                <div className="ig-sub trunc">
                  @{n.updatedBy} · {format(n.updatedAt, 'd MMM')}
                </div>
              </div>
            </button>
          ))}
        </div>
        {!notes.length && <p className="sm dim" style={{ padding: '4px 4px' }}>Notes everyone in the group can read and edit.</p>}
      </div>
      {open ? (
        <SharedNote key={open.id} group={group} note={open} items={items} onDeleted={() => setOpenId(null)} />
      ) : (
        <div className="card grow">
          <Empty icon={FileText} title="No shared notes" text="Make one for meeting notes, a project plan or a study guide." />
        </div>
      )}
    </div>
  )
}

/**
 * One shared note. Saves a moment after you stop typing, with the revision it
 * started from; if someone else saved first, the server refuses and you
 * choose whose version to keep, so nobody's work vanishes.
 */
function SharedNote({ group, note, items, onDeleted }: { group: Group; note: GroupItem<'note'>; items: ItemsApi; onDeleted: () => void }) {
  const toast = useToast()
  const { s } = useSettings()
  const base = useRef(note) // the copy our edits started from
  const draft = useRef<GroupNote>(note.data)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [title, setTitle] = useState(note.data.title)
  const [conflict, setConflict] = useState<GroupItem<'note'> | null>(null)
  const [state, setState] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [version, setVersion] = useState(0) // remounts the editor with someone else's text
  const [editor, setEditor] = useState<Editor | null>(null)

  // Someone else saved: take it in if you have nothing unsaved.
  useEffect(() => {
    if (note.rev > base.current.rev && !dirty.current && !conflict) {
      base.current = note
      draft.current = note.data
      setTitle(note.data.title)
      setVersion((v) => v + 1)
    }
  }, [note, conflict])

  const save = async (force = false) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current) return
    setState('saving')
    const sending = draft.current
    try {
      const saved = await saveItem(group.id, force && conflict ? conflict : base.current, sending)
      base.current = saved
      if (draft.current === sending) {
        dirty.current = false
        setState('saved')
      } else setState('unsaved')
      setConflict(null)
      items.apply(saved)
    } catch (e) {
      if (e instanceof GroupCallError && e.status === 409 && e.extra?.current) {
        setConflict(e.extra.current)
        setState('unsaved')
      } else {
        setState('unsaved')
        toast(msg(e))
      }
    }
  }
  const later = () => {
    dirty.current = true
    setState('unsaved')
    if (timer.current) clearTimeout(timer.current)
    if (!conflict) timer.current = setTimeout(() => void save(), 900)
  }
  // Leaving the note, or putting the app away, saves what's pending.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && timer.current) void save()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      if (timer.current) void save()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const takeTheirs = () => {
    if (!conflict) return
    base.current = conflict
    draft.current = conflict.data
    dirty.current = false
    setTitle(conflict.data.title)
    setConflict(null)
    setState('saved')
    setVersion((v) => v + 1)
    items.apply(conflict)
  }
  const remove = async () => {
    try {
      await deleteItem(group.id, note.id)
      items.apply({ id: note.id, deleted: true })
      onDeleted()
    } catch (e) {
      toast(msg(e))
    }
  }

  return (
    <div className="card grp-note">
      {conflict && (
        <div className="grp-conflict" role="alert">
          <b>@{conflict.updatedBy} changed this note while you were editing.</b>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => void save(true)}>
              Keep mine
            </button>
            <button className="btn sec sm" onClick={takeTheirs}>
              Use theirs
            </button>
          </div>
        </div>
      )}
      <div className="between">
        <input
          className="grp-note-title"
          placeholder="Untitled"
          value={title}
          maxLength={200}
          onChange={(e) => {
            setTitle(e.target.value)
            draft.current = { ...draft.current, title: e.target.value }
            later()
          }}
          aria-label="Note title"
        />
        <span className="xs tert" style={{ whiteSpace: 'nowrap' }}>
          {state === 'saving' ? 'Saving…' : state === 'unsaved' ? 'Not saved yet' : `Saved · @${base.current.updatedBy}`}
        </span>
        <button className="iconbtn plain" aria-label="Delete note" title="Delete note" onClick={remove}>
          <Trash2 size={15} />
        </button>
      </div>
      {s.noteToolbar !== 'slash' && <NoteToolbar editor={editor} />}
      <div className="note-main grp-note-body">
        <Area
          key={version}
          content={draft.current.content}
          placeholder="Write together."
          attach={false}
          onChange={(json, text) => {
            draft.current = { ...draft.current, content: json, excerpt: text.slice(0, 300) }
            later()
          }}
          onActive={setEditor}
          onReady={setEditor}
        />
      </div>
      <SlashMenu />
      <p className="xs tert" style={{ marginTop: 8 }}>
        {docText(draft.current.content) ? '' : 'Everyone in the group can edit this note. '}Started by @{note.createdBy}.
      </p>
    </div>
  )
}

/* ---------- deadlines ---------- */
function GroupDeadlines({ group, items }: { group: Group; items: ItemsApi }) {
  const toast = useToast()
  const [form, setForm] = useState({ title: '', date: todayKey(), time: '', details: '' })
  const today = todayKey()
  const events = items.list('event').sort((a, b) => `${a.data.date}${a.data.time ?? ''}`.localeCompare(`${b.data.date}${b.data.time ?? ''}`))
  const dueTasks = items.list('task').filter((t) => t.data.due && !t.data.done)
  const upcoming = events.filter((e) => (e.data.date ?? '') >= today)
  const past = events.filter((e) => (e.data.date ?? '') < today).reverse()

  const add = async () => {
    if (!form.title.trim()) return toast('Give the deadline a name.')
    if (!form.date) return toast('Pick a date for the deadline.')
    try {
      items.apply(await addItem(group.id, 'event', { title: form.title.trim(), date: form.date, time: form.time || null, details: form.details }))
      setForm({ ...form, title: '', time: '', details: '' })
    } catch (e) {
      toast(msg(e))
    }
  }
  const remove = async (e: GroupItem<'event'>) => {
    try {
      await deleteItem(group.id, e.id)
      items.apply({ id: e.id, deleted: true })
    } catch (err) {
      toast(msg(err))
    }
  }
  const row = (e: GroupItem<'event'>) => (
    <div key={e.id} className="ig-row">
      <div className="grp-date">
        <b>{format(parseISO(e.data.date!), 'd')}</b>
        <span>{format(parseISO(e.data.date!), 'MMM')}</span>
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ig-title trunc">{e.data.title}</div>
        <div className="ig-sub trunc">
          {dueLabel(e.data.date!)}
          {e.data.time ? ` at ${format(parseISO(`${e.data.date}T${e.data.time}`), 'h:mm a')}` : ''}
          {e.data.details ? ` · ${e.data.details}` : ''}
        </div>
      </div>
      <button className="iconbtn plain" aria-label={`Delete ${e.data.title}`} onClick={() => remove(e)}>
        <X size={15} />
      </button>
    </div>
  )

  return (
    <>
      <form
        className="card grp-dl-form"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input placeholder="Deadline, e.g. Lab report due" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Deadline name" maxLength={200} />
        <DateField label="Date" placeholder="Pick a date" clearable={false} value={form.date || null} onChange={(date) => setForm({ ...form, date: date ?? '' })} />
        <TimeField label="Time (optional)" value={form.time || null} onChange={(time) => setForm({ ...form, time })} />
        <button className="btn">
          <Plus size={15} /> Add
        </button>
      </form>
      <p className="xs dim" style={{ margin: '8px 2px 12px' }}>
        Group deadlines and due group tasks also show in your Calendar and on Today.
      </p>
      {upcoming.length ? (
        <div className="ig">{upcoming.map(row)}</div>
      ) : (
        <div className="card">
          <Empty icon={CalendarClock} title="No deadlines coming up" text="Add the due dates everyone needs to know about." />
        </div>
      )}
      {dueTasks.length > 0 && (
        <p className="sm dim" style={{ margin: '12px 2px' }}>
          Plus {dueTasks.length} open {dueTasks.length === 1 ? 'task' : 'tasks'} with a due date in Tasks.
        </p>
      )}
      {past.length > 0 && (
        <details className="grp-past">
          <summary className="sm dim">Past deadlines ({past.length})</summary>
          <div className="ig" style={{ marginTop: 8 }}>
            {past.map(row)}
          </div>
        </details>
      )}
    </>
  )
}

/* ---------- members ---------- */
function GroupMembers({ group, me, onChanged, onGone }: { group: Group; me: GroupUser | null; onChanged: (g: Group) => void; onGone: () => void }) {
  const toast = useToast()
  const owner = group.role === 'owner'
  const [q, setQ] = useState('')
  const [found, setFound] = useState<GroupUser[]>([])
  const [name, setName] = useState(group.name)
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null)

  useEffect(() => {
    const term = q.trim().replace(/^@/, '')
    if (term.length < 2) return setFound([])
    const t = setTimeout(() => {
      groupCall<{ users: GroupUser[] }>('GET', `/users/search?q=${encodeURIComponent(term)}`)
        .then((r) => setFound(r.users.filter((u) => !group.members.some((m) => m.username === u.username))))
        .catch(() => setFound([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, group.members])

  const invite = async (username: string) => {
    try {
      await groupCall('POST', `/groups/${gid(group.id)}/invites`, { username })
      toast(`Invite sent to @${username}`)
      setQ('')
    } catch (e) {
      toast(msg(e))
    }
  }
  const act = async (fn: () => Promise<{ group?: Group }>, done?: string) => {
    try {
      const r = await fn()
      if (r.group) onChanged(r.group)
      if (done) toast(done)
    } catch (e) {
      toast(msg(e))
    }
  }
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast('Copied'))
  }

  return (
    <div className="grp-members">
      <div className="ig">
        {group.members.map((m) => (
          <div key={m.username} className="ig-row">
            <Avatar user={m} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ig-title trunc row" style={{ gap: 6 }}>
                {m.displayName}
                {m.verified && (
                  <span className="grp-verified" title="Email verified">
                    <Check size={10} strokeWidth={3} />
                  </span>
                )}
                {m.username === me?.username && <span className="pill">You</span>}
              </div>
              <div className="ig-sub">
                @{m.username} · joined {format(m.joinedAt, 'd MMM yyyy')}
              </div>
            </div>
            {m.role === 'owner' && (
              <span className="pill accent row" style={{ gap: 4 }}>
                <Crown size={11} /> Owner
              </span>
            )}
            {owner && m.username !== me?.username && (
              <button
                className="btn ghost sm"
                onClick={() =>
                  act(async () => {
                    await groupCall('DELETE', `/groups/${gid(group.id)}/members/${encodeURIComponent(m.username)}`)
                    return groupCall('GET', `/groups/${gid(group.id)}`)
                  }, `Removed @${m.username}`)
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <label className="field-label" htmlFor="grp-invite">
          <UserPlus size={13} style={{ verticalAlign: '-2px' }} /> Invite by @username
        </label>
        <input id="grp-invite" placeholder="@username" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {found.length > 0 && (
          <div className="ig grp-found">
            {found.map((u) => (
              <div key={u.username} className="ig-row">
                <Avatar user={u} />
                <div className="grow">
                  <div className="ig-title">{u.displayName}</div>
                  <div className="ig-sub">@{u.username}</div>
                </div>
                <button className="btn sm" onClick={() => invite(u.username)}>
                  Invite
                </button>
              </div>
            ))}
          </div>
        )}
        {q.trim().replace(/^@/, '').length >= 2 && !found.length && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="sm dim grow">No match yet. People show up here after they open Group work once.</span>
            <button className="btn sec sm" onClick={() => invite(q.trim().replace(/^@/, ''))}>
              Invite @{q.trim().replace(/^@/, '')}
            </button>
          </div>
        )}
      </div>

      {owner && group.inviteCode && (
        <div className="card">
          <label className="field-label">Join code</label>
          <div className="row">
            <code className="grp-code">{group.inviteCode}</code>
            <button className="btn sec sm" onClick={() => copy(group.inviteCode!)}>
              <Copy size={14} /> Copy
            </button>
            <button className="btn ghost sm" onClick={() => act(() => groupCall('POST', `/groups/${gid(group.id)}/code`), 'New code made. The old one stops working.')}>
              <RefreshCw size={14} /> New code
            </button>
          </div>
          <p className="xs dim" style={{ marginTop: 8 }}>
            Anyone with a Veyra account and this code can join. Make a new code if it got passed around too far.
          </p>
        </div>
      )}

      {owner && (
        <div className="card">
          <label className="field-label" htmlFor="grp-name">
            Group name and colour
          </label>
          <div className="row">
            <input id="grp-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button className="btn sec sm" disabled={!name.trim() || name.trim() === group.name} onClick={() => act(() => groupCall('PATCH', `/groups/${gid(group.id)}`, { name: name.trim() }), 'Renamed')}>
              Rename
            </button>
          </div>
          <div className="row grp-colors" style={{ marginTop: 10 }}>
            {GROUP_COLORS.map((c) => (
              <button key={c} className="swatch" aria-label={`Colour ${c}`} role="radio" aria-checked={group.color === c} style={{ background: c }} onClick={() => act(() => groupCall('PATCH', `/groups/${gid(group.id)}`, { color: c }))} />
            ))}
          </div>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={() => setConfirm('leave')}>
          <LogOut size={15} /> Leave group
        </button>
        {owner && (
          <button className="btn ghost" onClick={() => setConfirm('delete')}>
            <Trash2 size={15} /> Delete group
          </button>
        )}
      </div>

      {confirm && (
        <Dialog title={confirm === 'leave' ? `Leave ${group.name}?` : `Delete ${group.name}?`} onClose={() => setConfirm(null)} width={420}>
          <p className="sm dim">
            {confirm === 'delete'
              ? 'Its tasks, chat, notes and deadlines are deleted for everyone. This can’t be undone.'
              : owner && group.members.length > 1
                ? `You’re the owner, so @${group.members.find((m) => m.username !== me?.username)?.username} becomes the owner.`
                : owner
                  ? 'You’re the only member, so the group is deleted.'
                  : 'You can come back with the join code or a new invite.'}
          </p>
          <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn sec" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn dan"
              onClick={async () => {
                try {
                  if (confirm === 'delete') await groupCall('DELETE', `/groups/${gid(group.id)}`)
                  else await groupCall('POST', `/groups/${gid(group.id)}/leave`)
                  setConfirm(null)
                  onGone()
                } catch (e) {
                  toast(msg(e))
                }
              }}
            >
              {confirm === 'delete' ? 'Delete group' : 'Leave'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/* ---------- making and joining ---------- */
function NewGroupDialog({ onClose, onMade }: { onClose: () => void; onMade: (g: Group) => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)])
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="New group" onClose={onClose} width={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          setBusy(true)
          try {
            const r = await groupCall<{ group: Group }>('POST', '/groups', { name: name.trim(), color })
            onMade(r.group)
            onClose()
          } catch (err) {
            toast(msg(err))
            setBusy(false)
          }
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="ng-name">
            Name
          </label>
          <input id="ng-name" autoFocus placeholder="e.g. Chem 101 lab group" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">Colour</label>
          <div className="row grp-colors">
            {GROUP_COLORS.map((c) => (
              <button type="button" key={c} className="swatch" aria-label={`Colour ${c}`} role="radio" aria-checked={color === c} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!name.trim() || busy}>
            Make group
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function JoinDialog({ onClose, onJoined }: { onClose: () => void; onJoined: (g: Group) => void }) {
  const [code, setCode] = useState('')
  const [preview, setPreview] = useState<GroupPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const clean = useMemo(() => code.toUpperCase().replace(/[^A-Z0-9]/g, ''), [code])

  const look = async () => {
    setBusy(true)
    setError('')
    try {
      setPreview((await groupCall<{ preview: GroupPreview }>('GET', `/join/${clean}`)).preview)
    } catch (e) {
      setError(msg(e))
    }
    setBusy(false)
  }
  const join = async () => {
    setBusy(true)
    try {
      const r = await groupCall<{ group: Group }>('POST', `/join/${clean}`)
      onJoined(r.group)
      onClose()
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title="Join a group" onClose={onClose} width={420}>
      {preview ? (
        <>
          <div className="row grp-preview">
            <span className="grp-swatch lg" style={{ background: preview.color }}>
              {preview.name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <b>{preview.name}</b>
              <div className="sm dim">
                Run by {preview.owner?.displayName} (@{preview.owner?.username}) · {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
              </div>
            </div>
          </div>
          {preview.alreadyIn && <p className="sm dim">You’re already in this group.</p>}
          {error && <p className="welcome-err">{error}</p>}
          <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn sec" onClick={() => setPreview(null)}>
              Back
            </button>
            <button className="btn" disabled={busy} onClick={join}>
              {preview.alreadyIn ? 'Open group' : 'Join group'}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (clean.length >= 6) void look()
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="join-code">
              Join code
            </label>
            <input id="join-code" autoFocus className="grp-code-input" placeholder="ABC234" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} />
          </div>
          <p className="xs dim">Ask the group’s owner for it. You’ll see the group before you join.</p>
          {error && <p className="welcome-err">{error}</p>}
          <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn sec" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={clean.length < 6 || busy}>
              Look up
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
