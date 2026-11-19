import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  LogOut,
  MessageCircle,
  MessageSquarePlus,
  Phone,
  RefreshCw,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
  WifiOff,
  X
} from 'lucide-react'
import type { FriendCard, Group, GroupInvite, GroupItem, GroupUser } from '@shared/types'
import {
  dmInvitePeer,
  dmPeer,
  findDmWith,
  isDmGroup,
  normalizeHandle,
  searchDmMessages,
  type DmPeer
} from '@shared/dm'
import { isDmGroupAllowed, isDmInviteAllowed } from '@shared/privacy'
import { Avatar, useAccount } from '../components/account'
import { FriendsPanel } from '../components/FriendsPanel'
import { ServerHoursBanner } from '../components/ServerHours'
import { Dialog, Empty, Seg, useToast } from '../components/ui'
import { VoiceBadge, VoiceRoom } from '../components/Voice'
import { useFriends } from '../data/friends'
import {
  addItem,
  deleteItem,
  gid,
  groupCall,
  useGroupItems,
  useGroupStatus,
  useGroups,
  useMultiGroupMessages
} from '../data/groups'
import { markDmRead, openOrCreateDm, unreadCountFor, useDmReadMap } from '../data/dm-read'
import { useSettings } from '../data/settings'
import { transition } from '../lib/motion'
import { usePhone } from '../lib/phone'
import { useNav } from '../nav'
import '../groups.css'
import '../messages.css'

type MessagesMode = 'chats' | 'friends'
type Filter = 'all' | 'unread' | 'requests'
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.')

function formatClock(ts: number, fmt: '12h' | '24h'): string {
  return format(ts, fmt === '24h' ? 'HH:mm' : 'h:mm a')
}

function formatListTime(ts: number, fmt: '12h' | '24h'): string {
  const d = new Date(ts)
  if (isToday(d)) return formatClock(ts, fmt)
  if (isYesterday(d)) return 'Yesterday'
  const diffDays = (Date.now() - ts) / 86_400_000
  if (diffDays < 6) return format(d, 'EEE')
  return format(d, 'd MMM')
}

function formatDayDivider(ts: number): string {
  const d = new Date(ts)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'EEEE d MMMM')
}

/** Splits text and highlights any case-insensitive occurrence of `terms`. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean)
  if (!escaped.length) return <>{text}</>
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="dm-mark">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}

/** Renders message text with clickable links and optional search term highlights. */
function MessageText({ text, terms }: { text: string; terms: string[] }) {
  const urlRe = /(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g
  const parts = text.split(urlRe)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            onClick={(e) => {
              e.preventDefault()
              void window.veyra.open(part)
            }}
          >
            <Highlight text={part} terms={terms} />
          </a>
        ) : (
          <Highlight key={i} text={part} terms={terms} />
        )
      )}
    </>
  )
}

function messageSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 96 || !terms.length) return flat
  const lower = flat.toLowerCase()
  const idx = lower.indexOf(terms[0])
  if (idx <= 28) return `${flat.slice(0, 96)}…`
  const start = Math.max(0, idx - 24)
  return `…${flat.slice(start, start + 92)}${start + 92 < flat.length ? '…' : ''}`
}

export function Messages({ initialDmId }: { initialDmId?: string }) {
  const account = useAccount().state
  const { go } = useNav()
  const { s } = useSettings()
  const toast = useToast()
  const phone = usePhone()

  const { status, retry } = useGroupStatus()
  const online = status?.state === 'online'
  const { groups, invites, reload } = useGroups(online)
  const friendsState = useFriends(account.mode === 'account' && !account.ended)
  const readMap = useDmReadMap()

  const meUsername = status?.me?.username ?? account.user?.username ?? ''

  const [mode, setMode] = useState<MessagesMode>(() => {
    if (initialDmId) return 'chats'
    try {
      return sessionStorage.getItem('veyra.messagesMode') === 'friends' ? 'friends' : 'chats'
    } catch {
      return 'chats'
    }
  })
  const [openId, setOpenId] = useState<string | null>(() => {
    if (initialDmId) return initialDmId
    try {
      return localStorage.getItem('veyra.dm') || null
    } catch {
      return null
    }
  })
  const [phoneOpen, setPhoneOpen] = useState(!!initialDmId)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [newDmOpen, setNewDmOpen] = useState(false)
  const [jumpTarget, setJumpTarget] = useState<{ dmId: string; msgId: string; query: string } | null>(null)
  const [openVoiceFor, setOpenVoiceFor] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem('veyra.messagesMode', mode)
    } catch {
      /* storage unavailable */
    }
  }, [mode])

  useEffect(() => {
    if (initialDmId) {
      setMode('chats')
      setOpenId(initialDmId)
      if (phone) setPhoneOpen(true)
    }
  }, [initialDmId, phone])

  useEffect(() => {
    try {
      if (openId) localStorage.setItem('veyra.dm', openId)
    } catch {
      /* storage unavailable */
    }
  }, [openId])

  // Open a specific DM from a desktop notification click or the call dock.
  useEffect(() => {
    const onOpenDm = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!id) return
      setMode('chats')
      setOpenId(id)
      if (phone) setPhoneOpen(true)
    }
    const onOpenVoice = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!id) return
      setMode('chats')
      setOpenId(id)
      setOpenVoiceFor(id)
      if (phone) setPhoneOpen(true)
    }
    window.addEventListener('veyra:open-dm', onOpenDm)
    window.addEventListener('veyra:open-dm-voice', onOpenVoice)
    return () => {
      window.removeEventListener('veyra:open-dm', onOpenDm)
      window.removeEventListener('veyra:open-dm-voice', onOpenVoice)
    }
  }, [phone])

  const rawDmGroups = useMemo(() => (groups ?? []).filter(isDmGroup), [groups])
  const dmGroups = useMemo(
    () => rawDmGroups.filter((g) => isDmGroupAllowed(g, meUsername, s, friendsState.data.friends)),
    [rawDmGroups, meUsername, s, friendsState.data.friends]
  )
  const hiddenDmCount = rawDmGroups.length - dmGroups.length

  const studyGroups = useMemo(() => (groups ?? []).filter((g) => !isDmGroup(g)), [groups])
  const rawDmInvites = useMemo(() => invites.filter((inv) => isDmGroup(inv.group)), [invites])
  const dmInvites = useMemo(
    () => rawDmInvites.filter((inv) => isDmInviteAllowed(inv, meUsername, s, friendsState.data.friends)),
    [rawDmInvites, meUsername, s, friendsState.data.friends]
  )
  const hiddenReqCount = rawDmInvites.length - dmInvites.length

  const dmIds = useMemo(() => dmGroups.map((g) => g.id), [dmGroups])
  const msgsByDm = useMultiGroupMessages(dmIds)

  const conversations = useMemo(() => {
    const friends = friendsState.data.friends
    return dmGroups
      .map((group) => {
        const peer = dmPeer(group, meUsername, friends)
        const messages = msgsByDm.get(group.id) ?? []
        const last = messages[messages.length - 1] ?? null
        const activityAt = last ? last.createdAt : group.createdAt
        const unread = unreadCountFor(messages, meUsername, readMap[group.id] ?? 0)
        return { group, peer, messages, last, activityAt, unread }
      })
      .sort((a, b) => b.activityAt - a.activityAt)
  }, [dmGroups, meUsername, friendsState.data.friends, msgsByDm, readMap])

  const unreadDmCount = useMemo(() => conversations.filter((c) => c.unread > 0).length, [conversations])

  const activeConv = useMemo(() => {
    if (!openId) return null
    return conversations.find((c) => c.group.id === openId) ?? null
  }, [conversations, openId])

  const queryTerms = useMemo(
    () =>
      q
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    [q]
  )
  const isSearching = queryTerms.length > 0

  const matchedChats = useMemo(() => {
    if (!isSearching) return conversations
    return conversations.filter((c) => {
      const hay = `${c.peer.displayName} @${c.peer.username}`.toLowerCase()
      return queryTerms.every((t) => hay.includes(t))
    })
  }, [conversations, isSearching, queryTerms])

  const matchedMessages = useMemo(() => {
    if (!isSearching) return []
    return searchDmMessages(
      conversations.map((c) => ({ group: c.group, peer: c.peer, messages: c.messages })),
      q
    )
  }, [conversations, isSearching, q])

  const matchedNewFriends = useMemo(() => {
    if (!isSearching) return []
    return friendsState.data.friends.filter((f) => {
      if (findDmWith(dmGroups, meUsername, f.username)) return false
      const hay = `${f.displayName} @${f.username}`.toLowerCase()
      return queryTerms.every((t) => hay.includes(t))
    })
  }, [friendsState.data.friends, dmGroups, meUsername, isSearching, queryTerms])

  const visibleConversations = useMemo(() => {
    if (filter === 'unread') return conversations.filter((c) => c.unread > 0)
    if (filter === 'requests') return []
    return conversations
  }, [conversations, filter])

  const openPrivacySettings = () => {
    sessionStorage.setItem('veyra.settingsSection', 'messages')
    go({ name: 'settings' })
    window.dispatchEvent(new CustomEvent('veyra:settings-section', { detail: 'messages' }))
  }

  const openFriends = () => {
    setNewDmOpen(false)
    setMode('friends')
  }

  const selectDm = (id: string, opts?: { jumpMsgId?: string; query?: string }) => {
    setMode('chats')
    const conv = conversations.find((c) => c.group.id === id)
    if (conv) {
      const latest = conv.last?.createdAt ?? Date.now()
      markDmRead(id, Math.max(Date.now(), latest))
    }
    if (opts?.jumpMsgId) {
      setJumpTarget({ dmId: id, msgId: opts.jumpMsgId, query: opts.query ?? '' })
    } else {
      setJumpTarget(null)
    }
    if (phone) {
      transition(() => {
        setOpenId(id)
        setPhoneOpen(true)
      }, 'push')
    } else {
      setOpenId(id)
    }
  }

  const startDmWith = async (friend: Pick<FriendCard, 'username' | 'displayName'>) => {
    if (!meUsername) return
    setBusyKey(`dm:${friend.username.toLowerCase()}`)
    try {
      const res = await openOrCreateDm({
        otherUsername: friend.username,
        meUsername,
        groups: groups ?? [],
        invites,
        reload
      })
      setNewDmOpen(false)
      setQ('')
      selectDm(res.groupId)
      if (res.status === 'created') toast(`Chat started — invite sent to @${friend.username}`)
      else if (res.status === 'accepted') toast(`Accepted message request from @${friend.username}`)
    } catch (e) {
      toast(errMsg(e))
    } finally {
      setBusyKey(null)
    }
  }

  const answerRequest = async (inv: GroupInvite, action: 'accept' | 'decline') => {
    setBusyKey(`inv:${inv.id}`)
    try {
      const r = await groupCall<{ group?: Group }>('POST', `/invites/${gid(inv.id)}/${action}`)
      await reload()
      if (action === 'accept' && r.group) {
        selectDm(r.group.id)
        const peer = dmInvitePeer(inv, meUsername, friendsState.data.friends)
        toast(`Now chatting with ${peer.displayName}`)
      }
    } catch (e) {
      toast(errMsg(e))
    } finally {
      setBusyKey(null)
    }
  }

  const inviteToStudyGroup = async (groupId: string, username: string) => {
    await groupCall('POST', `/groups/${gid(groupId)}/invites`, { username })
  }

  if (account.mode !== 'account') {
    return (
      <div className="inner view">
        <div className="topbar">
          <div>
            <h1>Messages</h1>
            <p className="dim">Direct messages and friends.</p>
          </div>
        </div>
        <div className="card">
          <Empty
            icon={MessageCircle}
            title="Sign in to message your friends"
            text="Direct messages use your Veyra account and friends list (shared with Veyra IronLog)."
            action={
              <button className="btn" onClick={() => go({ name: 'settings' })}>
                Sign in
              </button>
            }
          />
        </div>
      </div>
    )
  }

  const incomingFriendReqs = friendsState.data.incoming.length
  const connecting = !groups && (!status || status.state === 'connecting' || status.state === 'idle' || online)
  const hiddenTotal = hiddenDmCount + hiddenReqCount

  return (
    <div className={`dm-root view ${mode === 'chats' && phone && phoneOpen && activeConv ? 'dm-phone-open' : ''}`}>
      <header className="dm-topbar">
        <div className="dm-topbar-left">
          <h1>Messages</h1>
          <Seg<MessagesMode>
            value={mode}
            onChange={(next) => {
              setMode(next)
              if (next === 'friends') setPhoneOpen(false)
            }}
            options={[
              ['chats', 'Chats'],
              ['friends', incomingFriendReqs > 0 ? `Friends (${incomingFriendReqs})` : 'Friends']
            ]}
          />
        </div>
        <div className="dm-topbar-actions">
          {mode === 'chats' && groups && (
            <button className="btn sm" onClick={() => setNewDmOpen(true)}>
              <MessageSquarePlus size={15} /> New message
            </button>
          )}
        </div>
      </header>

      {mode === 'friends' ? (
        <div className="dm-friends-wrap">
          <div className="dm-friends-inner">
            <FriendsPanel
              friendsState={friendsState}
              emailVerified={!!account.user?.emailVerified}
              onOpenSettings={() => go({ name: 'settings' })}
              groups={studyGroups}
              groupOnline={online}
              onInviteToGroup={inviteToStudyGroup}
              onMessageFriend={startDmWith}
            />
          </div>
        </div>
      ) : !groups ? (
        <div className="dm-friends-wrap">
          <div className="dm-friends-inner">
            <ServerHoursBanner />
            {connecting ? (
              <div className="card grp-status">
                <RefreshCw size={16} className="spin" /> Connecting to messages…
              </div>
            ) : (
              <div className="card grp-status grp-offline">
                <WifiOff size={18} />
                <div className="grow">
                  <b>Can’t reach the messaging server</b>
                  <div className="sm dim">{status?.error || 'It may be switched off or restarting. Your Friends tab still works.'}</div>
                </div>
                <button className="btn sec" onClick={retry}>
                  <RefreshCw size={15} /> Try again
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="dm-shell">
          {/* ---------- LEFT PANE: chats, requests, global search ---------- */}
          <aside className="dm-side" aria-label="Conversations">
            <div className="dm-search-bar">
              <div className="dm-search-box">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  placeholder="Search chats, messages, or friends…"
                  aria-label="Search chats, messages, or friends"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && q) setQ('')
                  }}
                />
                {q && (
                  <button className="dm-search-clear" aria-label="Clear search" onClick={() => setQ('')}>
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {!isSearching && (
              <div className="dm-filters" role="group" aria-label="Filter conversations">
                <button className="dm-pill" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                  All
                </button>
                <button className="dm-pill" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>
                  Unread
                  {unreadDmCount > 0 && <span className="dm-pill-count">{unreadDmCount}</span>}
                </button>
                <button className="dm-pill" aria-pressed={filter === 'requests'} onClick={() => setFilter('requests')}>
                  Requests
                  {dmInvites.length > 0 && <span className="dm-pill-count">{dmInvites.length}</span>}
                </button>
              </div>
            )}

            {status && status.state !== 'online' && (
              <div className="dm-offline-strip">
                {status.state === 'connecting' ? <RefreshCw size={13} className="spin" /> : <WifiOff size={13} />}
                <span className="grow trunc">{status.state === 'connecting' ? 'Reconnecting…' : 'Offline — showing cached chats'}</span>
                {status.state !== 'connecting' && (
                  <button className="btn ghost sm" onClick={retry}>
                    Retry
                  </button>
                )}
              </div>
            )}

            <div className="dm-list">
              {isSearching ? (
                <>
                  {matchedChats.length > 0 && (
                    <>
                      <div className="dm-sec-label">Chats</div>
                      {matchedChats.map((c) => (
                        <DmRow
                          key={c.group.id}
                          peer={c.peer}
                          last={c.last}
                          activityAt={c.activityAt}
                          unread={c.unread}
                          active={!phone && activeConv?.group.id === c.group.id}
                          groupId={c.group.id}
                          meUsername={meUsername}
                          timeFormat={s.timeFormat}
                          highlight={queryTerms}
                          onClick={() => selectDm(c.group.id)}
                        />
                      ))}
                    </>
                  )}

                  {matchedMessages.length > 0 && (
                    <>
                      <div className="dm-sec-label">Messages ({matchedMessages.length})</div>
                      {matchedMessages.map((hit) => (
                        <button
                          key={`${hit.groupId}:${hit.messageId}`}
                          className="dm-row"
                          onClick={() => selectDm(hit.groupId, { jumpMsgId: hit.messageId, query: q.trim() })}
                        >
                          <div className="dm-row-av">
                            <Avatar user={hit.peer} />
                          </div>
                          <div className="dm-row-body">
                            <div className="dm-row-top">
                              <span className="dm-row-name trunc">{hit.peer.displayName}</span>
                              <span className="dm-row-time">{formatListTime(hit.createdAt, s.timeFormat)}</span>
                            </div>
                            <div className="dm-row-preview trunc">
                              {normalizeHandle(hit.createdBy) === normalizeHandle(meUsername) ? 'You: ' : ''}
                              <Highlight text={messageSnippet(hit.text, queryTerms)} terms={queryTerms} />
                            </div>
                          </div>
                        </button>
                      ))}
                    </>
                  )}

                  {matchedNewFriends.length > 0 && (
                    <>
                      <div className="dm-sec-label">Start a chat</div>
                      {matchedNewFriends.map((f) => (
                        <button
                          key={f.id}
                          className="dm-row"
                          disabled={busyKey === `dm:${f.username.toLowerCase()}`}
                          onClick={() => void startDmWith(f)}
                        >
                          <div className="dm-row-av">
                            <Avatar user={f} />
                          </div>
                          <div className="dm-row-body">
                            <div className="dm-row-name trunc">
                              <Highlight text={f.displayName || f.username} terms={queryTerms} />
                            </div>
                            <div className="dm-row-preview trunc">
                              @<Highlight text={f.username} terms={queryTerms} /> · Tap to message
                            </div>
                          </div>
                        </button>
                      ))}
                    </>
                  )}

                  {matchedChats.length === 0 && matchedMessages.length === 0 && matchedNewFriends.length === 0 && (
                    <div className="dm-empty-side">
                      <Search size={24} />
                      <div className="sm">No chats, messages, or friends match “{q.trim()}”.</div>
                      <button className="btn sec sm" onClick={openFriends}>
                        <UserPlus size={14} /> Find people in Friends
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {(filter === 'all' || filter === 'requests') && dmInvites.length > 0 && (
                    <>
                      <div className="dm-sec-label">Message requests</div>
                      {dmInvites.map((inv) => {
                        const peer = dmInvitePeer(inv, meUsername, friendsState.data.friends)
                        const busy = busyKey === `inv:${inv.id}`
                        return (
                          <div key={inv.id} className="dm-req-card">
                            <Avatar user={peer} />
                            <div className="grow" style={{ minWidth: 0 }}>
                              <div className="dm-row-name trunc">{peer.displayName}</div>
                              <div className="xs dim trunc">@{peer.username} wants to message you</div>
                            </div>
                            <div className="dm-req-actions">
                              <button
                                className="iconbtn plain"
                                title="Decline"
                                aria-label={`Decline request from ${peer.displayName}`}
                                disabled={busy}
                                onClick={() => void answerRequest(inv, 'decline')}
                              >
                                <X size={15} />
                              </button>
                              <button
                                className="btn sm"
                                disabled={busy}
                                onClick={() => void answerRequest(inv, 'accept')}
                              >
                                <Check size={13} /> Accept
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </>
                  )}

                  {visibleConversations.length > 0 ? (
                    visibleConversations.map((c) => (
                      <DmRow
                        key={c.group.id}
                        peer={c.peer}
                        last={c.last}
                        activityAt={c.activityAt}
                        unread={c.unread}
                        active={!phone && activeConv?.group.id === c.group.id}
                        groupId={c.group.id}
                        meUsername={meUsername}
                        timeFormat={s.timeFormat}
                        onClick={() => selectDm(c.group.id)}
                      />
                    ))
                  ) : filter === 'unread' ? (
                    <div className="dm-empty-side">
                      <Check size={24} />
                      <div className="sm">You’re all caught up — no unread messages.</div>
                    </div>
                  ) : filter === 'requests' ? (
                    dmInvites.length === 0 ? (
                      <div className="dm-empty-side">
                        <MessageCircle size={24} />
                        <div className="sm">
                          {s.dmWhoCanRequest === 'nobody'
                            ? 'Message requests are turned off in Messages & privacy.'
                            : 'No pending message requests.'}
                        </div>
                        {s.dmWhoCanRequest === 'nobody' && (
                          <button className="btn sec sm" onClick={openPrivacySettings}>
                            Open Messages &amp; privacy
                          </button>
                        )}
                      </div>
                    ) : null
                  ) : s.dmWhoCanMessage === 'nobody' ? (
                    <div className="dm-empty-side">
                      <MessageCircle size={26} />
                      <b style={{ color: 'var(--ink)' }}>Direct messages are muted</b>
                      <div className="sm">“Who can text you” is set to Nobody in Messages &amp; privacy.</div>
                      <button className="btn sec sm" onClick={openPrivacySettings}>
                        Open Messages &amp; privacy
                      </button>
                    </div>
                  ) : (
                    <div className="dm-empty-side">
                      <MessageCircle size={28} />
                      <b style={{ color: 'var(--ink)' }}>No direct messages yet</b>
                      <div className="sm">Start a 1-on-1 chat with any friend from Veyra Study or IronLog.</div>
                      <div className="row" style={{ marginTop: 4 }}>
                        <button className="btn sm" onClick={() => setNewDmOpen(true)}>
                          <MessageSquarePlus size={14} /> New message
                        </button>
                        <button className="btn sec sm" onClick={openFriends}>
                          <UserPlus size={14} /> Friends
                        </button>
                      </div>
                      {friendsState.data.friends.length > 0 && (
                        <div className="dm-quick-friends">
                          <div className="dm-sec-label">Your friends</div>
                          {friendsState.data.friends.slice(0, 6).map((f) => (
                            <button
                              key={f.id}
                              className="dm-row"
                              disabled={busyKey === `dm:${f.username.toLowerCase()}`}
                              onClick={() => void startDmWith(f)}
                            >
                              <div className="dm-row-av">
                                <Avatar user={f} />
                              </div>
                              <div className="dm-row-body">
                                <div className="dm-row-name trunc">{f.displayName || f.username}</div>
                                <div className="dm-row-preview trunc">@{f.username}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {hiddenTotal > 0 && (
                    <div className="dm-privacy-strip">
                      <span>
                        {hiddenTotal} {hiddenTotal === 1 ? 'item' : 'items'} hidden by privacy settings.
                      </span>
                      <button className="linkbtn sm" onClick={openPrivacySettings}>
                        Settings
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </aside>

          {/* ---------- RIGHT PANE: active conversation ---------- */}
          <section className="dm-stage" aria-label="Conversation">
            {activeConv ? (
              <DmConversation
                key={activeConv.group.id}
                group={activeConv.group}
                peer={activeConv.peer}
                me={status?.me ?? null}
                meUsername={meUsername}
                timeFormat={s.timeFormat}
                jumpTarget={jumpTarget && jumpTarget.dmId === activeConv.group.id ? jumpTarget : null}
                onClearJump={() => setJumpTarget(null)}
                initialVoiceOpen={openVoiceFor === activeConv.group.id}
                onBack={phone ? () => transition(() => setPhoneOpen(false), 'pop') : undefined}
                onGone={() => {
                  setOpenId(null)
                  setPhoneOpen(false)
                  void reload()
                }}
              />
            ) : (
              <div className="dm-welcome">
                <div className="dm-welcome-ic">
                  <MessageCircle size={26} />
                </div>
                <h2>Your direct messages</h2>
                <p>Pick a conversation on the left, search across every message you’ve sent or received, or start a new chat with a friend.</p>
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="btn" onClick={() => setNewDmOpen(true)}>
                    <MessageSquarePlus size={15} /> New message
                  </button>
                  <button className="btn sec" onClick={openFriends}>
                    <Users size={15} /> Friends{incomingFriendReqs > 0 ? ` (${incomingFriendReqs})` : ''}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {newDmOpen && (
        <NewDmDialog
          friends={friendsState.data.friends}
          dmGroups={rawDmGroups}
          meUsername={meUsername}
          busyKey={busyKey}
          onPick={(f) => void startDmWith(f)}
          onOpenFriends={openFriends}
          onClose={() => setNewDmOpen(false)}
        />
      )}
    </div>
  )
}

/* ---------- one row in the left list ---------- */
function DmRow({
  peer,
  last,
  activityAt,
  unread,
  active,
  groupId,
  meUsername,
  timeFormat,
  highlight,
  onClick
}: {
  peer: DmPeer
  last: GroupItem<'message'> | null
  activityAt: number
  unread: number
  active: boolean
  groupId: string
  meUsername: string
  timeFormat: '12h' | '24h'
  highlight?: string[]
  onClick: () => void
}) {
  const mineLast = last && normalizeHandle(last.createdBy) === normalizeHandle(meUsername)
  const preview = last
    ? `${mineLast ? 'You: ' : ''}${last.data.text.replace(/\s+/g, ' ').trim()}`
    : peer.joined
      ? 'No messages yet'
      : 'Invite sent · waiting to join'

  return (
    <button className={`dm-row ${unread > 0 ? 'unread' : ''}`} aria-current={active || undefined} onClick={onClick}>
      <div className="dm-row-av">
        <Avatar user={peer} />
      </div>
      <div className="dm-row-body">
        <div className="dm-row-top">
          <span className="dm-row-name trunc">
            {highlight?.length ? <Highlight text={peer.displayName} terms={highlight} /> : peer.displayName}
          </span>
          <span className="dm-row-time">{formatListTime(activityAt, timeFormat)}</span>
        </div>
        <div className="dm-row-sub">
          <span className="dm-row-preview trunc">{preview}</span>
          <div className="row" style={{ gap: 4, flexShrink: 0 }}>
            <VoiceBadge groupId={groupId} />
            {!peer.joined && <span className="dm-pending-tag">Pending</span>}
            {unread > 0 && <span className="dm-unread-pill">{unread > 99 ? '99+' : unread}</span>}
          </div>
        </div>
      </div>
    </button>
  )
}

/* ---------- active 1-on-1 conversation ---------- */
function DmConversation({
  group,
  peer,
  me,
  meUsername,
  timeFormat,
  jumpTarget,
  onClearJump,
  initialVoiceOpen,
  onBack,
  onGone
}: {
  group: Group
  peer: DmPeer
  me: GroupUser | null
  meUsername: string
  timeFormat: '12h' | '24h'
  jumpTarget: { dmId: string; msgId: string; query: string } | null
  onClearJump: () => void
  initialVoiceOpen: boolean
  onBack?: () => void
  onGone: () => void
}) {
  const toast = useToast()
  const items = useGroupItems(group.id)
  const messages = useMemo(() => items.list('message').sort((a, b) => a.createdAt - b.createdAt), [items])

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [findOpen, setFindOpen] = useState(!!jumpTarget?.query)
  const [findQ, setFindQ] = useState(jumpTarget?.query ?? '')
  const [matchIdx, setMatchIdx] = useState(0)
  const [voiceOpen, setVoiceOpen] = useState(initialVoiceOpen)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [flashMsgId, setFlashMsgId] = useState<string | null>(jumpTarget?.msgId ?? null)

  const streamRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const msgNodes = useRef(new Map<string, HTMLDivElement>())
  const stuck = useRef(true)
  const inFlight = useRef(false)

  // Mark messages read while this chat is visible.
  const lastMsgAt = messages[messages.length - 1]?.createdAt ?? 0
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState === 'visible') markDmRead(group.id, Math.max(Date.now(), lastMsgAt))
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [group.id, lastMsgAt])

  // Ctrl+F inside a chat toggles in-chat search (WhatsApp style).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
        setTimeout(() => findInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Handle jump-to-message from left-pane global message search.
  useEffect(() => {
    if (!jumpTarget) return
    if (jumpTarget.query) {
      setFindOpen(true)
      setFindQ(jumpTarget.query)
    }
    setFlashMsgId(jumpTarget.msgId)
    stuck.current = false
    const tryScroll = () => {
      const node = msgNodes.current.get(jumpTarget.msgId)
      if (node) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        onClearJump()
        return true
      }
      return false
    }
    if (!tryScroll()) {
      const t = setTimeout(tryScroll, 120)
      return () => clearTimeout(t)
    }
    return undefined
  }, [jumpTarget, messages.length, onClearJump])

  // Clear flash highlight after a few seconds if not actively searching.
  useEffect(() => {
    if (!flashMsgId) return
    const t = setTimeout(() => setFlashMsgId(null), 3200)
    return () => clearTimeout(t)
  }, [flashMsgId])

  const findTerms = useMemo(
    () =>
      findOpen
        ? findQ
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
        : [],
    [findOpen, findQ]
  )

  const matchIds = useMemo(() => {
    if (!findTerms.length) return []
    return messages
      .filter((m) => {
        const lower = (m.data?.text ?? '').toLowerCase()
        return findTerms.every((t) => lower.includes(t))
      })
      .map((m) => m.id)
  }, [messages, findTerms])

  // Default to the newest match when search query changes.
  useEffect(() => {
    if (!matchIds.length) {
      setMatchIdx(0)
      return
    }
    if (jumpTarget && matchIds.includes(jumpTarget.msgId)) {
      setMatchIdx(matchIds.indexOf(jumpTarget.msgId))
      return
    }
    setMatchIdx(matchIds.length - 1)
  }, [matchIds.join('\0')]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeMatchId = matchIds[matchIdx] ?? null
  useEffect(() => {
    if (!activeMatchId) return
    const node = msgNodes.current.get(activeMatchId)
    if (node) {
      stuck.current = false
      node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [activeMatchId, matchIdx])

  // Auto-scroll to bottom on new messages when near the bottom.
  const lastId = messages[messages.length - 1]?.id
  useEffect(() => {
    if (stuck.current && !jumpTarget) endRef.current?.scrollIntoView({ block: 'end' })
  }, [lastId, jumpTarget])

  const send = async () => {
    const t = text.trim()
    if (!t || inFlight.current) return
    inFlight.current = true
    setSending(true)
    setText('')
    try {
      const sent = await addItem(group.id, 'message', { text: t })
      items.apply(sent)
      markDmRead(group.id, Math.max(Date.now(), sent.createdAt))
      stuck.current = true
      setScrolledUp(false)
      setTimeout(() => endRef.current?.scrollIntoView({ block: 'end' }), 0)
    } catch (e) {
      setText((cur) => cur || t)
      toast(errMsg(e))
    } finally {
      inFlight.current = false
      setSending(false)
      composeRef.current?.focus()
    }
  }

  const removeMsg = async (m: GroupItem<'message'>) => {
    try {
      await deleteItem(group.id, m.id)
      items.apply({ id: m.id, deleted: true })
    } catch (e) {
      toast(errMsg(e))
    }
  }

  const copyMsg = (t: string) => {
    void navigator.clipboard?.writeText(t).then(
      () => toast('Copied message'),
      () => toast('Could not copy')
    )
  }

  const leaveOrDelete = async () => {
    setLeaving(true)
    try {
      if (group.role === 'owner' && group.members.length <= 1) {
        await groupCall('DELETE', `/groups/${gid(group.id)}`)
        toast('Conversation deleted')
      } else {
        await groupCall('POST', `/groups/${gid(group.id)}/leave`)
        toast('Left conversation')
      }
      setConfirmLeave(false)
      onGone()
    } catch (e) {
      toast(errMsg(e))
    } finally {
      setLeaving(false)
    }
  }

  const stepMatch = (delta: number) => {
    if (!matchIds.length) return
    setMatchIdx((i) => (i + delta + matchIds.length) % matchIds.length)
  }

  return (
    <>
      <header className="dm-head">
        <div className="dm-head-who">
          {onBack && (
            <button className="iconbtn plain" aria-label="Back to messages" onClick={onBack}>
              <ChevronLeft size={20} />
            </button>
          )}
          <Avatar user={peer} />
          <div style={{ minWidth: 0 }}>
            <div className="dm-head-name trunc">{peer.displayName}</div>
            <div className="dm-head-sub trunc">
              <span>@{peer.username}</span>
              {!peer.joined && <span>· Waiting to accept invite</span>}
            </div>
          </div>
        </div>
        <div className="dm-head-actions">
          <VoiceBadge groupId={group.id} />
          <button
            className="iconbtn plain"
            aria-label="Search in conversation"
            title="Search in conversation (Ctrl+F)"
            aria-pressed={findOpen}
            onClick={() => {
              const next = !findOpen
              setFindOpen(next)
              if (next) setTimeout(() => findInputRef.current?.focus(), 0)
              else setFindQ('')
            }}
          >
            <Search size={17} />
          </button>
          <button
            className="iconbtn plain"
            aria-label="Voice call"
            title="Voice call"
            aria-pressed={voiceOpen}
            onClick={() => setVoiceOpen((v) => !v)}
          >
            <Phone size={17} />
          </button>
          <button
            className="iconbtn plain"
            aria-label="Leave or delete conversation"
            title="Leave conversation"
            onClick={() => setConfirmLeave(true)}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>

      {findOpen && (
        <div className="dm-find" role="search" aria-label="Find in conversation">
          <div className="dm-find-input">
            <Search size={14} className="dim" aria-hidden="true" />
            <input
              ref={findInputRef}
              placeholder="Find in chat…"
              value={findQ}
              onChange={(e) => setFindQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setFindOpen(false)
                  setFindQ('')
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  stepMatch(e.shiftKey ? -1 : 1)
                }
              }}
            />
          </div>
          {findQ.trim() && (
            <span className="dm-find-count">
              {matchIds.length > 0 ? `${matchIdx + 1} of ${matchIds.length}` : 'No matches'}
            </span>
          )}
          <button
            className="iconbtn plain"
            aria-label="Previous match"
            title="Older match"
            disabled={matchIds.length < 2}
            onClick={() => stepMatch(-1)}
          >
            <ChevronUp size={16} />
          </button>
          <button
            className="iconbtn plain"
            aria-label="Next match"
            title="Newer match"
            disabled={matchIds.length < 2}
            onClick={() => stepMatch(1)}
          >
            <ChevronDown size={16} />
          </button>
          <button
            className="iconbtn plain"
            aria-label="Close search"
            onClick={() => {
              setFindOpen(false)
              setFindQ('')
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {voiceOpen && (
        <div className="dm-voice-box">
          <div className="dm-voice-head">
            <span className="xs dim" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Voice call with {peer.displayName}
            </span>
            <button className="iconbtn plain" aria-label="Hide voice panel" onClick={() => setVoiceOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <VoiceRoom group={{ ...group, name: peer.displayName }} me={me?.username ?? meUsername} />
        </div>
      )}

      <div className="dm-stream-wrap">
        <div
          className="dm-stream"
          ref={streamRef}
          onScroll={(e) => {
            const el = e.currentTarget
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight
            stuck.current = dist < 60
            setScrolledUp(dist > 140)
          }}
        >
          {items.error && !items.loaded ? (
            <div className="card grp-status grp-offline" style={{ margin: 'auto' }}>
              <WifiOff size={18} />
              <span className="grow">{items.error}</span>
              <button className="btn sec sm" onClick={() => void items.reload()}>
                Try again
              </button>
            </div>
          ) : !items.loaded ? (
            <div className="card grp-status" style={{ margin: 'auto' }}>
              <RefreshCw size={16} className="spin" /> Loading messages…
            </div>
          ) : messages.length === 0 ? (
            <div style={{ margin: 'auto' }}>
              <Empty
                icon={MessageCircle}
                title={`Say hi to ${peer.displayName}`}
                text={
                  peer.joined
                    ? `This is the start of your direct messages with @${peer.username}.`
                    : `Invite sent to @${peer.username}. You can send a message now — they’ll see it as soon as they accept.`
                }
              />
            </div>
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1]
              const next = messages[i + 1]
              const samePrev = !!prev && prev.createdBy === m.createdBy && m.createdAt - prev.createdAt <= 5 * 60_000
              const sameNext = !!next && next.createdBy === m.createdBy && next.createdAt - m.createdAt <= 5 * 60_000
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
              const mine = normalizeHandle(m.createdBy) === normalizeHandle(meUsername)
              const highlighted = m.id === activeMatchId || m.id === flashMsgId

              return (
                <Fragment key={m.id}>
                  {newDay && <div className="dm-day">{formatDayDivider(m.createdAt)}</div>}
                  <div
                    ref={(el) => {
                      if (el) msgNodes.current.set(m.id, el)
                      else msgNodes.current.delete(m.id)
                    }}
                    className={`dm-msg ${mine ? 'mine' : ''} ${!samePrev || newDay ? 'first' : ''} ${!sameNext ? 'last' : ''} ${highlighted ? 'hit-active' : ''}`}
                  >
                    <div className="dm-bubble">
                      <MessageText text={m.data.text} terms={findTerms} />
                      <span className="dm-bubble-meta">{formatClock(m.createdAt, timeFormat)}</span>
                    </div>
                    <div className="dm-msg-tools">
                      <button
                        className="iconbtn plain"
                        aria-label="Copy message"
                        title="Copy"
                        onClick={() => copyMsg(m.data.text)}
                      >
                        <Copy size={13} />
                      </button>
                      {(mine || group.role === 'owner') && (
                        <button
                          className="iconbtn plain"
                          aria-label="Delete message"
                          title="Delete"
                          onClick={() => void removeMsg(m)}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </Fragment>
              )
            })
          )}
          <div ref={endRef} />
        </div>

        {scrolledUp && (
          <button
            className="dm-scroll-btn"
            aria-label="Jump to latest messages"
            title="Jump to latest"
            onClick={() => {
              stuck.current = true
              setScrolledUp(false)
              endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
            }}
          >
            <ChevronDown size={18} />
          </button>
        )}
      </div>

      <form
        className="dm-compose"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={composeRef}
          rows={1}
          placeholder={`Message ${peer.displayName}…`}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          aria-label={`Message ${peer.displayName}`}
        />
        <button className="btn dm-send-btn" disabled={!text.trim() || sending} aria-label="Send message">
          <Send size={16} />
        </button>
      </form>

      {confirmLeave && (
        <Dialog title={`Leave chat with ${peer.displayName}?`} onClose={() => setConfirmLeave(false)} width={420}>
          <p className="sm dim">
            {group.role === 'owner' && group.members.length <= 1
              ? 'This will delete this conversation and its messages.'
              : 'You’ll leave this direct message conversation. You can start a new chat with them anytime.'}
          </p>
          <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn sec" onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
            <button className="btn dan" disabled={leaving} onClick={() => void leaveOrDelete()}>
              {group.role === 'owner' && group.members.length <= 1 ? 'Delete chat' : 'Leave chat'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}

/* ---------- New chat dialog ---------- */
function NewDmDialog({
  friends,
  dmGroups,
  meUsername,
  busyKey,
  onPick,
  onOpenFriends,
  onClose
}: {
  friends: FriendCard[]
  dmGroups: Group[]
  meUsername: string
  busyKey: string | null
  onPick: (friend: FriendCard) => void
  onOpenFriends: () => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState('')
  const clean = filter.trim().toLowerCase()
  const shown = friends.filter((f) => {
    if (!clean) return true
    return `${f.displayName} @${f.username}`.toLowerCase().includes(clean)
  })

  return (
    <Dialog title="New message" onClose={onClose} width={440}>
      <div className="dm-search-box" style={{ marginBottom: 6 }}>
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          placeholder="Filter your friends…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="dm-search-clear" aria-label="Clear" onClick={() => setFilter('')}>
            <X size={13} />
          </button>
        )}
      </div>

      {friends.length === 0 ? (
        <Empty
          icon={Users}
          title="No friends yet"
          text="Add classmates or friends from Veyra Study or IronLog to start messaging."
          action={
            <button className="btn sm" onClick={onOpenFriends}>
              <UserPlus size={14} /> Add friends
            </button>
          }
        />
      ) : shown.length === 0 ? (
        <div className="dm-empty-side">
          <div className="sm">No friends match “{filter.trim()}”.</div>
          <button className="btn sec sm" onClick={onOpenFriends}>
            <UserPlus size={14} /> Search all Veyra accounts
          </button>
        </div>
      ) : (
        <div className="ig dm-new-list">
          {shown.map((f) => {
            const hasDm = !!findDmWith(dmGroups, meUsername, f.username)
            return (
              <div key={f.id} className="ig-row">
                <Avatar user={f} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ig-title trunc">{f.displayName || f.username}</div>
                  <div className="ig-sub trunc">@{f.username}</div>
                </div>
                <button
                  className={hasDm ? 'btn sec sm' : 'btn sm'}
                  disabled={busyKey === `dm:${f.username.toLowerCase()}`}
                  onClick={() => onPick(f)}
                >
                  {hasDm ? 'Open' : 'Message'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="between" style={{ marginTop: 14 }}>
        <button className="btn ghost sm" onClick={onOpenFriends}>
          <UserPlus size={14} /> Manage friends
        </button>
        <button className="btn sec sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
