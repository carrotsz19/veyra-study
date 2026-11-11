import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { CalendarDays, Check, ExternalLink, Link2, LogOut, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import type { GoogleState } from '@shared/types'
import { Avatar, useAccount, Welcome } from '../components/account'
import { useToast } from '../components/ui'

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function AccountSection() {
  const { state, apply } = useAccount()
  const [signingIn, setSigningIn] = useState<null | 'signin' | 'signup'>(null)
  const [busy, setBusy] = useState(false)
  const u = state.user

  if (signingIn) {
    return (
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <Welcome initial={signingIn} onDone={apply} onCancel={() => setSigningIn(null)} />
      </div>
    )
  }
  return (
    <div className="card">
      {u ? (
        <div className="between">
          <div className="row" style={{ gap: 14 }}>
            <Avatar user={u} large />
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{u.displayName}</div>
              <div className="sm dim">
                @{u.username}
                {u.email ? ` · ${u.email}` : ''}
              </div>
              <div className="xs tert" style={{ marginTop: 2 }}>
                Veyra account · the same one as IronLog and Cashline. Your study data is kept for this account on this computer.
              </div>
            </div>
          </div>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              apply(await window.veyra.account.signOut())
            }}
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      ) : (
        <div className="between">
          <div className="row" style={{ gap: 14 }}>
            <div className="avatar lg">
              <UserRound size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Not signed in</div>
              <div className="sm dim">Sign in with your Veyra account to keep your study data with it. What’s on this computer comes with you the first time.</div>
            </div>
          </div>
          <div className="row">
            <button className="btn sec" onClick={() => setSigningIn('signup')}>
              Create account
            </button>
            <button className="btn" onClick={() => setSigningIn('signin')}>
              Sign in
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function GoogleSection() {
  const toast = useToast()
  const [g, setG] = useState<GoogleState | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'' | 'connect' | 'sync' | 'feed'>('')
  const [err, setErr] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedName, setFeedName] = useState('')
  const [feedErr, setFeedErr] = useState('')
  const [addingFeed, setAddingFeed] = useState(false)

  useEffect(() => {
    window.veyra.google.state().then((s) => {
      setG(s)
      setClientId(s.clientId)
      setAdvanced(!s.builtIn || s.customClient)
    })
  }, [])
  if (!g) return null

  const connect = async (own: boolean) => {
    setErr('')
    setBusy('connect')
    try {
      const s = own ? await window.veyra.google.connect(clientId, secret) : await window.veyra.google.connect()
      setG(s)
      setSecret('')
      toast('Google Calendar connected')
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy('')
    }
  }
  const addFeed = async () => {
    setFeedErr('')
    setBusy('feed')
    try {
      setG(await window.veyra.google.addFeed(feedUrl, feedName))
      setFeedUrl('')
      setFeedName('')
      setAddingFeed(false)
      toast('Calendar added')
    } catch (e) {
      setFeedErr(clean(e))
    } finally {
      setBusy('')
    }
  }
  const shown = new Set(g.shown ?? g.calendars.filter((c) => c.selected).map((c) => c.id))
  const toggleCal = async (id: string) => {
    const next = new Set(shown)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setG(await window.veyra.google.setOptions({ shown: [...next] }))
  }
  const ext = (href: string, text: string) => (
    <a href="#" onClick={(e) => { e.preventDefault(); window.veyra.open(href) }}>
      {text} <ExternalLink size={11} />
    </a>
  )

  return (
    <>
      <div className="card">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <div className="avatar lg" style={{ background: 'var(--panel-2)', color: '#2f6fd6' }}>
            <CalendarDays size={20} />
          </div>
          <div className="grow">
            <div className="between">
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Google Calendar</div>
                <div className="sm dim">
                  {g.connected
                    ? `Connected${g.email ? ` as ${g.email}` : ''}${g.lastSync ? ` · synced ${formatDistanceToNowStrict(g.lastSync, { addSuffix: true })}` : ''}`
                    : 'See your Google events in Veyra, and put task deadlines in your Google Calendar.'}
                </div>
              </div>
              {g.connected ? (
                <div className="row">
                  <button
                    className="btn sec sm"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy('sync')
                      try {
                        const r = await window.veyra.google.syncNow()
                        toast(r.pushed ? `Sent ${r.pushed} deadline${r.pushed === 1 ? '' : 's'} to Google` : 'Google Calendar is up to date')
                        setG(await window.veyra.google.state())
                      } catch (e) {
                        toast(clean(e))
                      } finally {
                        setBusy('')
                      }
                    }}
                  >
                    <RefreshCw size={14} className={busy === 'sync' ? 'spin' : ''} /> Sync now
                  </button>
                  <button className="btn ghost sm" onClick={async () => setG(await window.veyra.google.disconnect())}>
                    Disconnect
                  </button>
                </div>
              ) : (
                g.builtIn &&
                !advanced && (
                  <button className="btn" disabled={!!busy} onClick={() => connect(false)}>
                    {busy === 'connect' ? 'Finish in your browser…' : 'Connect'}
                  </button>
                )
              )}
            </div>

            {g.error && <p className="welcome-err" style={{ textAlign: 'left' }}>{g.error}</p>}
            {!g.connected && err && <p className="welcome-err" style={{ textAlign: 'left' }}>{err}</p>}

            {g.connected ? (
              <div style={{ marginTop: 16 }}>
                <label className="toggle-row">
                  <span>
                    <b>Add task deadlines to Google Calendar</b>
                    <span className="sm dim">Each task with a due date becomes an all-day event in a “Veyra Study” calendar. Veyra only changes that calendar.</span>
                  </span>
                  <input type="checkbox" className="switch" checked={g.pushTasks} onChange={async (e) => setG(await window.veyra.google.setOptions({ pushTasks: e.target.checked }))} />
                </label>
                <h2 style={{ marginTop: 18 }}>Show these calendars in Veyra</h2>
                <div className="ig">
                  {g.calendars.map((c) => (
                    <label key={c.id} className="ig-row tap" style={{ cursor: 'pointer' }}>
                      <span className="cal-check" style={{ background: shown.has(c.id) ? c.color : 'transparent', borderColor: c.color }}>
                        {shown.has(c.id) && <Check size={12} strokeWidth={3} color="#fff" />}
                      </span>
                      <input type="checkbox" className="sr-only" checked={shown.has(c.id)} onChange={() => toggleCal(c.id)} />
                      <span className="grow trunc">{c.summary}</span>
                      {c.primary && <span className="pill">Main</span>}
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {g.builtIn && !advanced && (
                  <p className="xs tert" style={{ margin: '10px 0 0' }}>
                    Your browser opens Google to approve. Until Google reviews Veyra Study you’ll see “Google hasn’t verified this app”: choose <b>Advanced → Go to Veyra Study</b>.
                    Veyra can see your calendars and events, and change only the “Veyra Study” calendar it creates.
                  </p>
                )}
                {advanced && (
                  <div style={{ marginTop: 14 }}>
                    <p className="sm dim" style={{ margin: 0 }}>
                      Use your own Google OAuth client (type <b>Desktop app</b>) from the {ext('https://console.cloud.google.com/auth/clients', 'Google Cloud console')}, with the Google
                      Calendar API turned on and the app published <b>In production</b>.
                    </p>
                    <div className="grid g2" style={{ marginTop: 12 }}>
                      <div>
                        <label className="field-label" htmlFor="g-id">Client ID</label>
                        <input id="g-id" placeholder="…apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                      </div>
                      <div>
                        <label className="field-label" htmlFor="g-secret">Client secret</label>
                        <input id="g-secret" type="password" placeholder={g.hasSecret ? 'Saved' : 'GOCSPX-…'} value={secret} onChange={(e) => setSecret(e.target.value)} />
                      </div>
                    </div>
                    <button className="btn" style={{ marginTop: 12 }} disabled={!clientId.trim() || !!busy} onClick={() => connect(true)}>
                      {busy === 'connect' ? 'Finish in your browser…' : 'Connect with this client'}
                    </button>
                  </div>
                )}
                {g.builtIn && (
                  <button className="linkbtn xs" style={{ marginTop: 10 }} onClick={() => setAdvanced(!advanced)}>
                    {advanced ? 'Use Veyra’s Google connection instead' : 'Advanced: use your own Google client'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Calendars by link: no Google sign-in, read-only. */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <div className="avatar lg" style={{ background: 'var(--panel-2)', color: 'var(--dim)' }}>
            <Link2 size={20} />
          </div>
          <div className="grow">
            <div className="between">
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Calendars by link</div>
                <div className="sm dim">Show a calendar without signing in, using its iCal link. Read-only.</div>
              </div>
              {!addingFeed && (
                <button className="btn sec sm" onClick={() => setAddingFeed(true)}>
                  <Plus size={14} /> Add link
                </button>
              )}
            </div>
            {g.feeds.length > 0 && (
              <div className="ig" style={{ marginTop: 14 }}>
                {g.feeds.map((f) => (
                  <div key={f.id} className="ig-row">
                    <span style={{ width: 12, height: 12, borderRadius: 4, background: f.color, marginLeft: 4, flexShrink: 0 }} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="trunc" style={{ display: 'block' }}>{f.name}</span>
                      {f.error && <span className="xs" style={{ color: 'var(--bad)' }}>{f.error}</span>}
                    </span>
                    <button className="iconbtn plain" aria-label={`Remove ${f.name}`} title="Remove" onClick={async () => setG(await window.veyra.google.removeFeed(f.id))}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {addingFeed && (
              <div style={{ marginTop: 14 }}>
                <ol className="steps sm" style={{ marginTop: 0 }}>
                  <li>
                    In {ext('https://calendar.google.com/calendar/r/settings', 'Google Calendar settings')}, pick the calendar on the left under <b>Settings for my calendars</b>.
                  </li>
                  <li>
                    Under <b>Integrate calendar</b>, copy <b>Secret address in iCal format</b>. Keep it private: anyone with it can see the calendar.
                  </li>
                </ol>
                <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginTop: 10 }}>
                  <input aria-label="iCal link" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} />
                  <input aria-label="Name (optional)" placeholder="Name (optional)" value={feedName} onChange={(e) => setFeedName(e.target.value)} />
                </div>
                {feedErr && <p className="welcome-err" style={{ textAlign: 'left' }}>{feedErr}</p>}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" disabled={!feedUrl.trim() || !!busy} onClick={addFeed}>
                    {busy === 'feed' ? 'Checking the link…' : 'Add calendar'}
                  </button>
                  <button className="btn ghost" onClick={() => { setAddingFeed(false); setFeedErr('') }}>
                    Cancel
                  </button>
                </div>
                <p className="xs tert" style={{ marginTop: 8 }}>Works with any .ics link (Outlook, iCloud, school timetables). Links are stored encrypted on this computer.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export function Settings() {
  return (
    <div className="inner view" style={{ maxWidth: 860 }}>
      <div className="topbar">
        <h1>Settings</h1>
      </div>
      <h2>Account</h2>
      <AccountSection />
      <h2 style={{ marginTop: 26 }}>Connected calendars</h2>
      <GoogleSection />
    </div>
  )
}
