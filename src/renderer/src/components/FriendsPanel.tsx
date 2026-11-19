import { useEffect, useState } from 'react'
import { Check, MessageSquare, RefreshCw, Search, UserCheck, UserMinus, UserPlus, Users, X } from 'lucide-react'
import type { FriendCard, FriendSearchCard, Group } from '@shared/types'
import { Avatar } from './account'
import { Dialog, Empty, useToast } from './ui'
import type { useFriends } from '../data/friends'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.')

export interface FriendsPanelProps {
  friendsState: ReturnType<typeof useFriends>
  emailVerified: boolean
  onOpenSettings: () => void
  groups: Group[]
  groupOnline: boolean
  onInviteToGroup: (groupId: string, username: string) => Promise<void>
  onMessageFriend: (friend: FriendCard) => Promise<void>
}

export function FriendsPanel({
  friendsState,
  emailVerified,
  onOpenSettings,
  groups,
  groupOnline,
  onInviteToGroup,
  onMessageFriend
}: FriendsPanelProps) {
  const { data, loaded, loading, error, reload, send, respond, remove, search } = friendsState
  const toast = useToast()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<FriendSearchCard[]>([])
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [unfriend, setUnfriend] = useState<FriendCard | null>(null)
  const [inviteFriend, setInviteFriend] = useState<FriendCard | null>(null)

  const cleanQuery = q.trim().replace(/^@/, '')

  useEffect(() => {
    if (cleanQuery.length < 2) {
      setResults([])
      setSearchErr('')
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    setSearchErr('')
    const t = setTimeout(() => {
      search(cleanQuery)
        .then((list) => {
          if (!alive) return
          setResults(list)
          setSearching(false)
        })
        .catch((e) => {
          if (!alive) return
          setResults([])
          setSearchErr(errMsg(e))
          setSearching(false)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [cleanQuery, search])

  // Keep search card statuses fresh when friendships change locally.
  const statusOf = (u: FriendSearchCard): FriendSearchCard['friendshipStatus'] => {
    if (data.friends.some((f) => f.id === u.id)) return 'friends'
    if (data.incoming.some((f) => f.id === u.id)) return 'incoming'
    if (data.outgoing.some((f) => f.id === u.id)) return 'outgoing'
    return u.friendshipStatus === 'self' ? 'self' : 'none'
  }

  const runAction = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusyId(key)
    try {
      await fn()
      if (okMsg) toast(okMsg)
    } catch (e) {
      toast(errMsg(e))
    } finally {
      setBusyId(null)
    }
  }

  const sendTo = async (username: string) => {
    const clean = username.trim().replace(/^@/, '')
    if (!clean) return
    await runAction(
      `send:${clean.toLowerCase()}`,
      async () => {
        await send(clean)
        setQ('')
        setResults([])
      },
      `Friend request sent to @${clean}`
    )
  }

  const exactInResults = results.some((r) => r.username.toLowerCase() === cleanQuery.toLowerCase())
  const exactInLists =
    data.friends.some((r) => r.username.toLowerCase() === cleanQuery.toLowerCase()) ||
    data.incoming.some((r) => r.username.toLowerCase() === cleanQuery.toLowerCase()) ||
    data.outgoing.some((r) => r.username.toLowerCase() === cleanQuery.toLowerCase())

  const invitableGroups = (friend: FriendCard) =>
    groups.filter((g) => !g.members.some((m) => m.username.toLowerCase() === friend.username.toLowerCase()))

  return (
    <div className="fr-view">
      <div className="between fr-bar">
        <span className="xs dim">Shared with Veyra IronLog — friends stay synced across both apps.</span>
        <button className="btn ghost sm" disabled={loading} onClick={() => void reload()}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>

      {!emailVerified && (
        <div className="card fr-note">
          <span className="sm grow">Confirm your email in Settings → Account to send new friend requests.</span>
          <button className="btn sec sm" onClick={onOpenSettings}>
            Account settings
          </button>
        </div>
      )}

      {error && (
        <div className="card grp-status grp-offline">
          <span className="grow sm">{error}</span>
          <button className="btn sec sm" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      )}

      <div className="card fr-search-card">
        <label className="field-label" htmlFor="fr-search">
          <UserPlus size={13} style={{ verticalAlign: '-2px' }} /> Add a friend
        </label>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (cleanQuery.length >= 2 && !exactInLists) void sendTo(cleanQuery)
          }}
        >
          <div className="fr-search-wrap grow">
            <Search size={14} className="fr-search-ic" aria-hidden="true" />
            <input
              id="fr-search"
              placeholder="Search Veyra accounts by name or @username…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
            />
          </div>
          {cleanQuery && (
            <button type="button" className="iconbtn plain" aria-label="Clear search" onClick={() => setQ('')}>
              <X size={14} />
            </button>
          )}
        </form>

        {searching && (
          <div className="xs dim" style={{ marginTop: 8 }}>
            Searching…
          </div>
        )}
        {searchErr && (
          <div className="xs dim" style={{ marginTop: 8 }}>
            {searchErr}
          </div>
        )}

        {results.length > 0 && (
          <div className="ig grp-found">
            {results.map((u) => {
              const st = statusOf(u)
              return (
                <div key={u.id} className="ig-row">
                  <Avatar user={u} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title trunc">{u.displayName || u.username}</div>
                    <div className="ig-sub trunc">
                      @{u.username}
                      {u.about ? ` · ${u.about}` : ''}
                    </div>
                  </div>
                  {st === 'friends' ? (
                    <span className="pill row" style={{ gap: 4 }}>
                      <UserCheck size={12} /> Friends
                    </span>
                  ) : st === 'outgoing' ? (
                    <button
                      className="btn ghost sm"
                      disabled={busyId === `rm:${u.id}`}
                      onClick={() => void runAction(`rm:${u.id}`, () => remove(u.id), `Cancelled request to @${u.username}`)}
                    >
                      Cancel
                    </button>
                  ) : st === 'incoming' ? (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn ghost sm"
                        disabled={busyId === `resp:${u.id}`}
                        onClick={() => void runAction(`resp:${u.id}`, () => respond(u.id, false), 'Request declined')}
                      >
                        Decline
                      </button>
                      <button
                        className="btn sm"
                        disabled={busyId === `resp:${u.id}`}
                        onClick={() => void runAction(`resp:${u.id}`, () => respond(u.id, true), `You and @${u.username} are friends now`)}
                      >
                        Accept
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn sm"
                      disabled={busyId === `send:${u.username.toLowerCase()}`}
                      onClick={() => void sendTo(u.username)}
                    >
                      <UserPlus size={13} /> Add
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {cleanQuery.length >= 2 && !searching && !exactInResults && !exactInLists && (
          <div className="row fr-exact">
            <span className="xs dim grow">
              {results.length === 0
                ? 'No public accounts matched. Private accounts can still be added by exact @username.'
                : 'Looking for a private account? Send a request by exact username.'}
            </span>
            <button
              className="btn sec sm"
              disabled={busyId === `send:${cleanQuery.toLowerCase()}`}
              onClick={() => void sendTo(cleanQuery)}
            >
              Send request to @{cleanQuery}
            </button>
          </div>
        )}
      </div>

      {data.incoming.length > 0 && (
        <section className="fr-section">
          <div className="fr-section-head">
            <span>Incoming requests</span>
            <span className="pill accent">{data.incoming.length}</span>
          </div>
          <div className="ig grp-invites">
            {data.incoming.map((u) => (
              <div key={u.id} className="ig-row">
                <Avatar user={u} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ig-title trunc">{u.displayName || u.username}</div>
                  <div className="ig-sub trunc">
                    @{u.username}
                    {u.about ? ` · ${u.about}` : ''}
                  </div>
                </div>
                <button
                  className="btn ghost sm"
                  disabled={busyId === `resp:${u.id}`}
                  onClick={() => void runAction(`resp:${u.id}`, () => respond(u.id, false), 'Request declined')}
                >
                  Decline
                </button>
                <button
                  className="btn sm"
                  disabled={busyId === `resp:${u.id}`}
                  onClick={() => void runAction(`resp:${u.id}`, () => respond(u.id, true), `You and @${u.username} are friends now`)}
                >
                  <Check size={13} /> Accept
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="fr-section">
        <div className="fr-section-head">
          <span>Your friends</span>
          {loaded && <span className="pill">{data.friends.length}</span>}
        </div>
        {!loaded && loading ? (
          <div className="card grp-status">
            <RefreshCw size={15} className="spin" /> Loading friends…
          </div>
        ) : data.friends.length === 0 ? (
          <div className="card">
            <Empty
              icon={Users}
              title="No friends yet"
              text="Search for classmates or friends by name or @username above. Friends you add in Veyra IronLog show up here too."
            />
          </div>
        ) : (
          <div className="ig">
            {data.friends.map((f) => {
              const joinable = groupOnline ? invitableGroups(f) : []
              return (
                <div key={f.id} className="ig-row">
                  <Avatar user={f} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title trunc">{f.displayName || f.username}</div>
                    <div className="ig-sub trunc">
                      @{f.username}
                      {f.about ? ` · ${f.about}` : ''}
                    </div>
                  </div>
                  {groupOnline && (
                    <button
                      className="btn sec sm"
                      disabled={busyId === `dm:${f.id}`}
                      onClick={() => void runAction(`dm:${f.id}`, () => onMessageFriend(f))}
                    >
                      <MessageSquare size={13} /> Message
                    </button>
                  )}
                  {joinable.length > 0 && (
                    <button className="btn ghost sm" onClick={() => setInviteFriend(f)}>
                      Invite to group
                    </button>
                  )}
                  <button
                    className="iconbtn plain"
                    aria-label={`Remove ${f.displayName || f.username}`}
                    title="Remove friend"
                    onClick={() => setUnfriend(f)}
                  >
                    <UserMinus size={14} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {data.outgoing.length > 0 && (
        <section className="fr-section">
          <div className="fr-section-head">
            <span>Sent requests</span>
            <span className="pill">{data.outgoing.length}</span>
          </div>
          <div className="ig">
            {data.outgoing.map((u) => (
              <div key={u.id} className="ig-row">
                <Avatar user={u} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ig-title trunc">{u.displayName || u.username}</div>
                  <div className="ig-sub trunc">@{u.username} · Pending</div>
                </div>
                <button
                  className="btn ghost sm"
                  disabled={busyId === `rm:${u.id}`}
                  onClick={() => void runAction(`rm:${u.id}`, () => remove(u.id), `Cancelled request to @${u.username}`)}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {inviteFriend && (
        <Dialog title={`Invite @${inviteFriend.username} to a group`} onClose={() => setInviteFriend(null)} width={420}>
          {invitableGroups(inviteFriend).length === 0 ? (
            <p className="sm dim">@{inviteFriend.username} is already in all of your groups.</p>
          ) : (
            <div className="ig">
              {invitableGroups(inviteFriend).map((g) => (
                <div key={g.id} className="ig-row">
                  <span className="grp-swatch" style={{ background: g.color }}>
                    {g.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title trunc">{g.name}</div>
                    <div className="ig-sub">
                      {g.members.length} {g.members.length === 1 ? 'member' : 'members'}
                    </div>
                  </div>
                  <button
                    className="btn sm"
                    disabled={busyId === `inv:${g.id}:${inviteFriend.id}`}
                    onClick={() =>
                      void runAction(
                        `inv:${g.id}:${inviteFriend.id}`,
                        async () => {
                          await onInviteToGroup(g.id, inviteFriend.username)
                          setInviteFriend(null)
                        },
                        `Invited @${inviteFriend.username} to ${g.name}`
                      )
                    }
                  >
                    Invite
                  </button>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}

      {unfriend && (
        <Dialog title={`Remove ${unfriend.displayName || '@' + unfriend.username}?`} onClose={() => setUnfriend(null)} width={420}>
          <p className="sm dim">
            This also removes them from your friends list in Veyra IronLog. You can send a new friend request anytime.
          </p>
          <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn sec" onClick={() => setUnfriend(null)}>
              Cancel
            </button>
            <button
              className="btn dan"
              disabled={busyId === `rm:${unfriend.id}`}
              onClick={() =>
                void runAction(
                  `rm:${unfriend.id}`,
                  async () => {
                    await remove(unfriend.id)
                    setUnfriend(null)
                  },
                  `Removed @${unfriend.username}`
                )
              }
            >
              Remove friend
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
