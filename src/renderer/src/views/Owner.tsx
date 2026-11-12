import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Ban, ChevronLeft, MessageSquare, NotebookPen, RefreshCw, Search, ShieldCheck, Trash2, UserMinus, CalendarClock, ListTodo } from 'lucide-react'
import { groupCall, gid } from '../data/groups'
import { Avatar } from '../components/account'
import { Dialog, Seg, useToast } from '../components/ui'

/**
 * Settings → Owner: only for the owner of Veyra Study (the group server
 * decides who that is, and refuses everyone else). Who uses Group work and
 * sync, what's in each group, and moderation: delete a message, note, task or
 * deadline; remove someone from a group; delete a group; block or unblock
 * someone from Group work and sync.
 */

type Overview = {
  version: string
  startedAt: number
  users: number
  activeWeek: number
  newWeek: number
  blocked: number
  groups: number
  items: { tasks: number; messages: number; notes: number; deadlines: number }
  synced: { records: number; bytes: number }
  dbBytes: number
}
type AdminUser = {
  username: string
  displayName: string
  photoUrl: string
  verified: boolean
  createdAt: number
  seenAt: number
  groups: number
  records: number
  bytes: number
  devices: number
  owner: boolean
  blocked: { at: number; reason: string } | null
}
type AdminGroup = { id: string; name: string; color: string; owner: string; createdAt: number; members: number; tasks: number; messages: number; notes: number; deadlines: number; lastActive: number }
type GroupDetail = {
  group: { id: string; name: string; color: string; owner: string; createdAt: number }
  members: { username: string; displayName: string; photoUrl: string; role: string; joinedAt: number }[]
  items: { id: string; kind: 'task' | 'message' | 'note' | 'event'; text: string; createdBy: string; createdAt: number; updatedAt: number }[]
}

/** True when the group server says you're an owner (so Settings shows the section). */
let ownerCache: boolean | null = null
export function useIsOwner(signedIn: boolean): boolean {
  const [owner, setOwner] = useState(ownerCache ?? false)
  useEffect(() => {
    if (!signedIn || ownerCache !== null) return
    let live = true
    groupCall<{ owner?: boolean }>('GET', '/me')
      .then((r) => {
        ownerCache = !!r.owner
        if (live) setOwner(ownerCache)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [signedIn])
  return owner
}

const ago = (t: number) => formatDistanceToNowStrict(t, { addSuffix: true })
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function OwnerSection() {
  const [tab, setTab] = useState<'overview' | 'users' | 'groups'>('overview')
  return (
    <div className="owner">
      <div className="owner-head">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            ['overview', 'Overview'],
            ['users', 'Users'],
            ['groups', 'Groups']
          ]}
        />
      </div>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'groups' && <GroupsTab />}
    </div>
  )
}

/** Loads something from the server, with "Try again" when it can't. */
function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    if (!path) return
    setBusy(true)
    setError('')
    groupCall<T>('GET', path)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Couldn’t reach the group server.'))
      .finally(() => setBusy(false))
  }, [path])
  useEffect(load, [load])
  return { data, error, busy, load }
}

function Problem({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="card owner-problem">
      <span className="grow">{error}</span>
      <button className="btn sec sm" onClick={retry}>
        <RefreshCw size={14} /> Try again
      </button>
    </div>
  )
}

/* ---------- overview ---------- */
function OverviewTab() {
  const { data: o, error, load } = useLoad<Overview>('/admin/overview')
  const [downloads, setDownloads] = useState<{ total: number; latest: string; latestCount: number } | null>(null)
  useEffect(() => {
    // Installer and APK downloads, from GitHub (public numbers).
    fetch('https://api.github.com/repos/carrotsz19/veyra-study/releases?per_page=100')
      .then((r) => (r.ok ? r.json() : null))
      .then((rels: { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; download_count: number }[] }[] | null) => {
        if (!rels) return
        const count = (r: (typeof rels)[number]) => r.assets.filter((a) => /\.(exe|apk)$/.test(a.name)).reduce((s, a) => s + a.download_count, 0)
        const latest = rels.find((r) => !r.draft && !r.prerelease)
        setDownloads({ total: rels.reduce((s, r) => s + count(r), 0), latest: latest?.tag_name ?? '', latestCount: latest ? count(latest) : 0 })
      })
      .catch(() => {})
  }, [])
  if (error) return <Problem error={error} retry={load} />
  if (!o) return <div className="dim sm owner-loading">Loading…</div>
  const tiles: [string, string | number, string?][] = [
    ['People', o.users, `${o.newWeek} new this week`],
    ['Active this week', o.activeWeek, `of ${o.users}`],
    ['Groups', o.groups],
    ['Blocked', o.blocked],
    ['Messages', o.items.messages],
    ['Group notes', o.items.notes],
    ['Group tasks', o.items.tasks],
    ['Deadlines', o.items.deadlines],
    ['Synced items', o.synced.records, size(o.synced.bytes)],
    ['Server data', size(o.dbBytes), `server ${o.version}, up ${formatDistanceToNowStrict(o.startedAt)}`],
    ...(downloads ? ([['Downloads', downloads.total, downloads.latest ? `${downloads.latestCount} of ${downloads.latest}` : undefined]] as [string, number, string?][]) : [])
  ]
  return (
    <>
      <div className="owner-tiles">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="card owner-tile">
            <span className="owner-tile-label">{label}</span>
            <b className="num">{value}</b>
            {sub && <span className="xs dim">{sub}</span>}
          </div>
        ))}
      </div>
      <p className="xs tert" style={{ marginTop: 12 }}>
        Counts people who have used Group work or sync. Veyra accounts themselves are run by the main Veyra service.
      </p>
    </>
  )
}

/* ---------- users ---------- */
function UsersTab() {
  const toast = useToast()
  const { data, error, load } = useLoad<{ users: AdminUser[] }>('/admin/users')
  const [q, setQ] = useState('')
  const [blocking, setBlocking] = useState<AdminUser | null>(null)
  const [reason, setReason] = useState('')
  const users = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^@/, '')
    return (data?.users ?? []).filter((u) => !t || u.username.includes(t) || u.displayName.toLowerCase().includes(t))
  }, [data, q])
  if (error) return <Problem error={error} retry={load} />
  if (!data) return <div className="dim sm owner-loading">Loading…</div>

  const unblock = async (u: AdminUser) => {
    try {
      await groupCall('DELETE', `/admin/users/${gid(u.username)}/block`)
      toast(`@${u.username} can use Group work and sync again`)
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work.')
    }
  }
  const block = async () => {
    if (!blocking) return
    try {
      await groupCall('POST', `/admin/users/${gid(blocking.username)}/block`, { reason: reason.trim() })
      toast(`@${blocking.username} is blocked`)
      setBlocking(null)
      setReason('')
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work.')
    }
  }

  return (
    <>
      <div className="owner-tools">
        <label className="owner-search">
          <Search size={15} className="dim" />
          <input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        </label>
        <span className="xs dim">{users.length === 1 ? '1 person' : `${users.length} people`}</span>
      </div>
      <div className="ig">
        {users.map((u) => (
          <div key={u.username} className={`ig-row owner-user ${u.blocked ? 'is-blocked' : ''}`}>
            <Avatar user={u} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ig-title trunc">
                {u.displayName} <span className="dim">@{u.username}</span>
                {u.owner && (
                  <span className="pill accent" style={{ marginLeft: 6 }}>
                    <ShieldCheck size={11} /> Owner
                  </span>
                )}
                {u.blocked && <span className="pill bad" style={{ marginLeft: 6 }}>Blocked</span>}
              </div>
              <div className="ig-sub trunc">
                Joined {ago(u.createdAt)} · seen {ago(u.seenAt)} · {plural(u.groups, 'group')} · {plural(u.records, 'synced item')} ({size(u.bytes)}) · {plural(u.devices, 'device')}
                {u.blocked?.reason ? ` · blocked: ${u.blocked.reason}` : ''}
              </div>
            </div>
            {!u.owner &&
              (u.blocked ? (
                <button className="btn sec sm" onClick={() => void unblock(u)}>
                  Unblock
                </button>
              ) : (
                <button className="btn ghost sm" onClick={() => setBlocking(u)}>
                  <Ban size={14} /> Block
                </button>
              ))}
          </div>
        ))}
        {!users.length && <div className="ig-row dim sm">No one matches.</div>}
      </div>
      {blocking && (
        <Dialog title={`Block @${blocking.username}?`} onClose={() => setBlocking(null)}>
          <p className="dim" style={{ marginTop: 0 }}>
            They're signed out of Group work and sync on every device straight away, and can't sign in to them again until you unblock them. Their Veyra account and the rest of the app aren't
            touched, and nothing is deleted.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="block-reason">
              Reason (only you see it)
            </label>
            <input id="block-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" maxLength={300} />
          </div>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setBlocking(null)}>
              Cancel
            </button>
            <button className="btn dan" onClick={() => void block()}>
              <Ban size={15} /> Block
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}

/* ---------- groups ---------- */
function GroupsTab() {
  const { data, error, load } = useLoad<{ groups: AdminGroup[] }>('/admin/groups')
  const [open, setOpen] = useState<string | null>(null)
  if (open) return <GroupDetailView id={open} onBack={() => (setOpen(null), load())} />
  if (error) return <Problem error={error} retry={load} />
  if (!data) return <div className="dim sm owner-loading">Loading…</div>
  return (
    <div className="ig">
      {data.groups.map((g) => (
        <button key={g.id} className="ig-row tap" onClick={() => setOpen(g.id)}>
          <span className="grp-swatch" style={{ background: g.color }}>
            {g.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ig-title trunc">{g.name}</div>
            <div className="ig-sub trunc">
              @{g.owner} · {plural(g.members, 'member')} · {plural(g.messages, 'message')} · {plural(g.tasks, 'task')} · {plural(g.notes, 'note')} · active {ago(g.lastActive)}
            </div>
          </div>
        </button>
      ))}
      {!data.groups.length && <div className="ig-row dim sm">No groups yet.</div>}
    </div>
  )
}

const KIND: Record<GroupDetail['items'][number]['kind'], [string, typeof ListTodo]> = {
  message: ['Messages', MessageSquare],
  note: ['Notes', NotebookPen],
  task: ['Tasks', ListTodo],
  event: ['Deadlines', CalendarClock]
}

function GroupDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast()
  const { data, error, load } = useLoad<GroupDetail>(`/admin/groups/${gid(id)}`)
  const [confirm, setConfirm] = useState<{ title: string; text: string; run: () => Promise<void> } | null>(null)
  const act = (title: string, text: string, path: string, done: string, after?: () => void) =>
    setConfirm({
      title,
      text,
      run: async () => {
        try {
          await groupCall('DELETE', path)
          toast(done)
          setConfirm(null)
          if (after) after()
          else load()
        } catch (e) {
          toast(e instanceof Error ? e.message : 'That didn’t work.')
        }
      }
    })
  if (error) return <Problem error={error} retry={load} />
  if (!data) return <div className="dim sm owner-loading">Loading…</div>
  const g = data.group
  return (
    <>
      <div className="owner-tools">
        <button className="btn ghost sm" onClick={onBack}>
          <ChevronLeft size={15} /> All groups
        </button>
        <span className="grow" />
        <button
          className="btn ghost sm danger-text"
          onClick={() => act(`Delete “${g.name}”?`, 'Its tasks, chat, notes and deadlines are deleted for everyone in it. This can’t be undone.', `/admin/groups/${gid(g.id)}`, 'Group deleted', onBack)}
        >
          <Trash2 size={14} /> Delete group
        </button>
      </div>
      <h2 className="owner-group-name">
        <span className="grp-swatch" style={{ background: g.color }}>
          {g.name.slice(0, 1).toUpperCase()}
        </span>
        {g.name}
      </h2>

      <h3 className="owner-sub">Members</h3>
      <div className="ig">
        {data.members.map((m) => (
          <div key={m.username} className="ig-row">
            <Avatar user={m} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ig-title trunc">
                {m.displayName} <span className="dim">@{m.username}</span>
                {m.role === 'owner' && <span className="pill" style={{ marginLeft: 6 }}>Group owner</span>}
              </div>
              <div className="ig-sub">Joined {ago(m.joinedAt)}</div>
            </div>
            <button
              className="btn ghost sm"
              onClick={() =>
                act(
                  `Remove @${m.username}?`,
                  m.role === 'owner' ? 'They own this group: the longest-standing member takes it over (or, if no one else is in it, the group is deleted).' : 'They lose access to this group. What they posted stays.',
                  `/admin/groups/${gid(g.id)}/members/${gid(m.username)}`,
                  `@${m.username} removed`
                )
              }
            >
              <UserMinus size={14} /> Remove
            </button>
          </div>
        ))}
      </div>

      {(Object.keys(KIND) as (keyof typeof KIND)[]).map((kind) => {
        const list = data.items.filter((i) => i.kind === kind)
        if (!list.length) return null
        const [label, Icon] = KIND[kind]
        return (
          <div key={kind}>
            <h3 className="owner-sub">
              <Icon size={14} /> {label} <span className="dim">{list.length}</span>
            </h3>
            <div className="ig">
              {list.map((it) => (
                <div key={it.id} className="ig-row owner-item">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="owner-item-text">{it.text || <span className="tert">(empty)</span>}</div>
                    <div className="ig-sub">
                      @{it.createdBy} · {ago(it.createdAt)}
                    </div>
                  </div>
                  <button
                    className="iconbtn plain"
                    aria-label="Delete"
                    title="Delete for everyone"
                    onClick={() => act('Delete this for everyone?', `“${it.text.slice(0, 120)}” by @${it.createdBy} is removed from the group.`, `/admin/groups/${gid(g.id)}/items/${gid(it.id)}`, 'Deleted')}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {confirm && (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="dim" style={{ marginTop: 0 }}>
            {confirm.text}
          </p>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn dan" onClick={() => void confirm.run()}>
              <Trash2 size={15} /> {confirm.title.replace(/\?$/, '').split(' ')[0]}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
