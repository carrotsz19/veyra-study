import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { CalendarDays, Check, ExternalLink, LogOut, RefreshCw, UserRound } from 'lucide-react'
import type { GoogleState } from '@shared/types'
import { useAccount, Welcome } from '../components/account'
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
            <div className="avatar lg">{u.photoUrl ? <img src={u.photoUrl} alt="" /> : (u.displayName || u.username).slice(0, 1).toUpperCase()}</div>
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
  const [busy, setBusy] = useState<'' | 'connect' | 'sync'>('')
  const [err, setErr] = useState('')
  const [help, setHelp] = useState(false)

  useEffect(() => {
    window.veyra.google.state().then((s) => {
      setG(s)
      setClientId(s.clientId)
      setHelp(!s.clientId)
    })
  }, [])
  if (!g) return null

  const connect = async () => {
    setErr('')
    setBusy('connect')
    try {
      const s = await window.veyra.google.connect(clientId, secret)
      setG(s)
      setSecret('')
      toast('Google Calendar connected')
    } catch (e) {
      setErr(clean(e))
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

  return (
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
            {g.connected && (
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
            )}
          </div>

          {g.error && <p className="welcome-err" style={{ textAlign: 'left' }}>{g.error}</p>}

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
            <div style={{ marginTop: 16 }}>
              <button className="linkbtn sm" onClick={() => setHelp(!help)}>
                {help ? 'Hide setup steps' : 'How do I get a client ID?'}
              </button>
              {help && (
                <ol className="steps sm">
                  <li>
                    Open the{' '}
                    <a href="#" onClick={(e) => { e.preventDefault(); window.veyra.open('https://console.cloud.google.com/projectcreate') }}>
                      Google Cloud console <ExternalLink size={11} />
                    </a>{' '}
                    and create a project (any name, e.g. “Veyra Study”).
                  </li>
                  <li>
                    In <b>APIs &amp; Services → Library</b>, turn on the <b>Google Calendar API</b>.
                  </li>
                  <li>
                    In <b>Google Auth Platform</b> (OAuth consent screen), choose <b>External</b>, fill in the app name and your email, and add yourself as a test user. Then set
                    the publishing status to <b>In production</b>, otherwise Google signs you out every 7 days. The “unverified app” warning is fine for personal use.
                  </li>
                  <li>
                    In <b>Clients</b>, create a client of type <b>Desktop app</b>. Copy its <b>Client ID</b> and <b>Client secret</b> here.
                  </li>
                </ol>
              )}
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
              {err && <p className="welcome-err" style={{ textAlign: 'left' }}>{err}</p>}
              <button className="btn" style={{ marginTop: 14 }} disabled={!clientId.trim() || !!busy} onClick={connect}>
                {busy === 'connect' ? 'Waiting for Google… (finish in your browser)' : 'Connect Google Calendar'}
              </button>
              <p className="xs tert" style={{ marginTop: 8 }}>
                Veyra asks to see your calendars and events, and to manage only the calendar it creates. Your Google sign-in is stored encrypted on this computer.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
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
