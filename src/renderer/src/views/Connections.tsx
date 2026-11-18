import { useEffect, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ServerHoursBanner } from '../components/ServerHours'
import { BadgeCheck, Bot, CalendarDays, Check, Copy, ExternalLink, HardDrive, KeyRound, Link2, LogOut, Mail, Plus, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { backupNow, backupStatus, onBackupStatus, useDrive } from '../data/drive'
import type { AccountState, GoogleState, McpState, SyncStatus } from '@shared/types'
import { useSettings } from '../data/settings'
import { Avatar, useAccount, Welcome } from '../components/account'
import { Dialog, useToast } from '../components/ui'
import { IS_DEV } from '@shared/channel'

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function AccountSection() {
  const { state, apply } = useAccount()
  const [signingIn, setSigningIn] = useState<null | 'signin' | 'signup'>(null)
  const [busy, setBusy] = useState(false)
  const u = state.user

  return (
    <div className="card">
      {signingIn && <Welcome initial={signingIn} onDone={apply} onCancel={() => setSigningIn(null)} />}
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
                Veyra account · the same one as IronLog and Cashline.
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
      ) : null}
      {u && <EmailAndPassword />}
      {u && <SyncRow />}
      {u ? null : (
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

/**
 * The account's email (add it, confirm it with the emailed code) and password (change it). A verified
 * email is what lets a forgotten password be reset from the sign-in screen.
 */
function EmailAndPassword() {
  const { state, update } = useAccount()
  const toast = useToast()
  const [open, setOpen] = useState<null | 'email' | 'verify' | 'password'>(null)
  const u = state.user!
  if (state.ended) return null
  return (
    <div className="acct-rows">
      <div className="acct-row">
        <Mail size={16} className="dim" />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="sm" style={{ fontWeight: 600 }}>
            Email
          </div>
          <div className="xs dim trunc">
            {!u.email ? 'None yet. Add one so you can reset your password if you forget it.' : u.emailVerified ? u.email : `${u.email} · not confirmed yet, so it can’t be used to reset your password`}
          </div>
        </div>
        {!u.email ? (
          <button className="btn sec sm" onClick={() => setOpen('email')}>
            Add email
          </button>
        ) : u.emailVerified ? (
          <span className="acct-ok xs">
            <BadgeCheck size={14} /> Confirmed
          </span>
        ) : (
          <button className="btn sm" onClick={() => setOpen('verify')}>
            Confirm email
          </button>
        )}
      </div>
      <div className="acct-row">
        <KeyRound size={16} className="dim" />
        <div className="grow">
          <div className="sm" style={{ fontWeight: 600 }}>
            Password
          </div>
          <div className="xs dim">Changing it signs you out on your other devices, and in IronLog and Cashline.</div>
        </div>
        <button className="btn sec sm" onClick={() => setOpen('password')}>
          Change password
        </button>
      </div>
      {open === 'email' && (
        <AddEmailDialog
          onClose={() => setOpen(null)}
          onAdded={(s) => {
            update(s)
            setOpen('verify')
          }}
        />
      )}
      {open === 'verify' && (
        <VerifyEmailDialog
          email={u.email}
          onClose={() => setOpen(null)}
          onOtherEmail={() => setOpen('email')}
          onVerified={(s) => {
            update(s)
            setOpen(null)
            toast('Email confirmed. You can now reset your password with it.')
          }}
        />
      )}
      {open === 'password' && (
        <ChangePasswordDialog
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null)
            toast('Password changed. Your other devices were signed out.')
          }}
        />
      )}
    </div>
  )
}

function AddEmailDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (s: AccountState) => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <Dialog title="Add your email" onClose={onClose} width={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy || !email.trim()) return
          setBusy(true)
          setErr('')
          try {
            onAdded(await window.veyra.account.setEmail(email.trim()))
          } catch (ex) {
            setErr(clean(ex))
            setBusy(false)
          }
        }}
      >
        <p className="sm dim" style={{ marginTop: 0 }}>
          We’ll send a code to confirm it. It’s used to reset your password, and for IronLog’s social features.
        </p>
        <div className="field">
          <input type="email" autoFocus autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
        </div>
        {err && <p className="sm" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
        <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!email.trim() || busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function VerifyEmailDialog({ email, onClose, onVerified, onOtherEmail }: { email: string; onClose: () => void; onVerified: (s: AccountState) => void; onOtherEmail: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState(`Enter the 6-digit code we emailed to ${email}. No email? Check spam, or send a new code.`)
  return (
    <Dialog title="Confirm your email" onClose={onClose} width={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          if (!/^\d{6}$/.test(code.trim())) return setErr('Enter the 6-digit code from your email.')
          setBusy(true)
          setErr('')
          try {
            onVerified(await window.veyra.account.verifyEmail(code.trim()))
          } catch (ex) {
            setErr(clean(ex))
            setBusy(false)
          }
        }}
      >
        <p className="sm dim" style={{ marginTop: 0 }}>
          {note}
        </p>
        <div className="field">
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Code from the email" />
        </div>
        {err && <p className="sm" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
        <div className="row" style={{ gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="linkbtn"
            disabled={busy}
            onClick={async () => {
              setErr('')
              try {
                const r = await window.veyra.account.resendVerification()
                if (r.alreadyVerified) return onVerified(await window.veyra.account.state())
                setNote(r.sentTo ? `A new code is on its way to ${r.sentTo}.` : 'A new code is on its way.')
              } catch (ex) {
                setErr(clean(ex))
              }
            }}
          >
            Send a new code
          </button>
          <button type="button" className="linkbtn" onClick={onOtherEmail}>
            Use a different email
          </button>
        </div>
        <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn sec" onClick={onClose}>
            Later
          </button>
          <button className="btn" disabled={code.trim().length !== 6 || busy}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ChangePasswordDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <Dialog title="Change password" onClose={onClose} width={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          if (next.length < 8) return setErr('Use a new password of at least 8 characters.')
          setBusy(true)
          setErr('')
          try {
            await window.veyra.account.changePassword(current, next)
            onChanged()
          } catch (ex) {
            setErr(clean(ex))
            setBusy(false)
          }
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="cp-current">
            Current password
          </label>
          <input id="cp-current" type={show ? 'text' : 'password'} autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cp-next">
            New password
          </label>
          <input id="cp-next" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 8 characters" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: -2 }}>
          <button type="button" className="linkbtn sm" aria-pressed={show} onClick={() => setShow(!show)}>
            {show ? 'Hide passwords' : 'Show passwords'}
          </button>
        </div>
        <p className="xs dim">Forgot your current one? Sign out, then use “Forgot password?” on the sign-in screen.</p>
        {err && <p className="sm" style={{ color: 'var(--bad)' }} role="alert">{err}</p>}
        <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!current || !next || busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function GoogleSection() {
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

/* ---------- Google Drive ---------- */
export function DriveSection() {
  const toast = useToast()
  const { state: d, run } = useDrive()
  const [busy, setBusy] = useState<'' | 'connect' | 'backup'>('')
  const [err, setErr] = useState('')
  const [status, setStatus] = useState(backupStatus())
  useEffect(() => onBackupStatus(() => setStatus(backupStatus())), [])
  if (!d) return null

  const connect = async () => {
    setErr('')
    setBusy('connect')
    try {
      await run(() => window.veyra.drive.connect())
      toast('Google Drive connected')
      void backupNow()
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy('')
    }
  }
  const backup = async () => {
    setBusy('backup')
    const r = await backupNow()
    setBusy('')
    if (r) toast(r.uploaded || r.removed ? `Backed up ${r.uploaded} note${r.uploaded === 1 ? '' : 's'}${r.removed ? `, removed ${r.removed}` : ''}` : 'Your Drive backup is up to date')
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div className="avatar lg" style={{ background: 'var(--panel-2)', color: '#1f9d55' }}>
          <HardDrive size={20} />
        </div>
        <div className="grow">
          <div className="between">
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>Google Drive</div>
              <div className="sm dim">
                {d.connected
                  ? `Connected${d.email ? ` as ${d.email}` : ''}`
                  : 'Back up your notes to Drive, and save notes as Google Docs. Veyra only sees files it makes or ones you pick.'}
              </div>
            </div>
            {d.connected ? (
              <button className="btn ghost sm" onClick={() => run(() => window.veyra.drive.disconnect())}>
                Disconnect
              </button>
            ) : (
              d.builtIn && (
                <button className="btn" disabled={!!busy} onClick={connect}>
                  {busy === 'connect' ? 'Finish in your browser…' : 'Connect'}
                </button>
              )
            )}
          </div>
          {d.error && <p className="welcome-err" style={{ textAlign: 'left' }}>{d.error}</p>}
          {!d.connected && err && <p className="welcome-err" style={{ textAlign: 'left' }}>{err}</p>}
          {!d.builtIn && <p className="sm dim" style={{ marginTop: 10 }}>This copy of Veyra has no built-in Google client, so Drive can’t connect.</p>}

          {d.connected && (
            <div style={{ marginTop: 16 }}>
              <label className="toggle-row">
                <span>
                  <b>Back up my notes to Drive</b>
                  <span className="sm dim">
                    Every note as a Markdown file in “Veyra Study / Notes backup”, updated a little after you edit it. Attached files stay on this computer.
                  </span>
                </span>
                <input type="checkbox" className="switch" checked={d.backup} onChange={(e) => { const on = e.target.checked; void run(() => window.veyra.drive.setBackup(on)).then(() => { if (on) void backupNow() }) }} />
              </label>
              {d.backup && (
                <div className="between" style={{ marginTop: 10 }}>
                  <span className="sm dim">
                    {status.running || busy === 'backup'
                      ? 'Backing up…'
                      : d.lastBackup
                        ? `${d.backedUp} note${d.backedUp === 1 ? '' : 's'} backed up · last ${formatDistanceToNowStrict(d.lastBackup, { addSuffix: true })}`
                        : 'Not backed up yet'}
                  </span>
                  <button className="btn sec sm" disabled={!!busy || status.running} onClick={backup}>
                    <RefreshCw size={14} className={busy === 'backup' ? 'spin' : ''} /> Back up now
                  </button>
                </div>
              )}
              {status.error && <p className="welcome-err" style={{ textAlign: 'left' }}>{status.error}</p>}
              <label className="toggle-row" style={{ marginTop: 14 }}>
                <span>
                  <b>Let the Assistant use my Drive</b>
                  <span className="sm dim">
                    {d.canRead
                      ? 'The Assistant in notes can search and read your Drive files, and make Google Docs (it asks first). It only looks when you ask it something.'
                      : 'The Assistant in notes could search and read your Drive files, and make Google Docs. Turning this on asks Google for permission to read your Drive.'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={!!d.assistant}
                  disabled={!!busy}
                  onChange={async (e) => {
                    const on = e.target.checked
                    setErr('')
                    if (!on || d.canRead) return void run(() => window.veyra.drive.setAssistant(on))
                    setBusy('connect')
                    try {
                      await run(() => window.veyra.drive.connect(true))
                      toast('The Assistant can use your Google Drive')
                    } catch (er) {
                      setErr(clean(er))
                      void run(() => window.veyra.drive.state())
                    } finally {
                      setBusy('')
                    }
                  }}
                />
              </label>
              {busy === 'connect' && <p className="sm dim">Finish in your browser…</p>}
              {err && <p className="welcome-err" style={{ textAlign: 'left' }}>{err}</p>}
              <p className="sm dim" style={{ marginTop: 12 }}>
                To save one note as a Google Doc, open it and choose <b>Save to Google Docs</b> from its ••• menu.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------- sync across your computers ---------- */
function SyncRow() {
  const toast = useToast()
  const [s, setS] = useState<SyncStatus | null>(null)
  useEffect(() => {
    window.veyra.sync.status().then(setS)
    return window.veyra.sync.onStatus(setS)
  }, [])
  if (!s) return null
  return (
    <div className="sync-row">
      <label className="toggle-row">
        <span>
          <b>Sync across my computers</b>
          <span className="sm dim">
            Your tasks, notes, subjects and study time on every computer you sign in to, through your Veyra server. Settings and attached files stay on each computer.
          </span>
        </span>
        <input type="checkbox" className="switch" checked={s.enabled} onChange={async (e) => setS(await window.veyra.sync.setEnabled(e.target.checked))} />
      </label>
      {/* Veyra Study Dev: keep test builds from changing your real data, while still seeing it. */}
      {s.enabled && (
        <label className="toggle-row" style={{ marginTop: 12 }}>
          <span>
            <b>Sync note history</b>
            <span className="sm dim">
              {s.history
                ? 'On: earlier versions of your notes are on all your devices.'
                : 'Off: versions made on this device stay on it (other devices’ history still arrives here).'}
            </span>
          </span>
          <input type="checkbox" className="switch" checked={s.history} onChange={async (e) => setS(await window.veyra.sync.setHistory(e.target.checked))} />
        </label>
      )}
      {IS_DEV && s.enabled && (
        <label className="toggle-row" style={{ marginTop: 12 }}>
          <span>
            <b>
              Send this device's changes <span className="dev-pill">DEV</span>
            </b>
            <span className="sm dim">
              {s.sending
                ? 'On: what you change here goes to your other devices, as in the real app.'
                : 'Off: this device still gets every change from your other devices, but sends none of its own. What you change here stays here, even if you turn this back on.'}
            </span>
          </span>
          <input type="checkbox" className="switch" checked={s.sending} onChange={async (e) => setS(await window.veyra.sync.setSending(e.target.checked))} />
        </label>
      )}
      {s.enabled && <ServerHoursBanner what="Syncing" />}
      {s.enabled && (
        <div className="between" style={{ marginTop: 8 }}>
          <span className={`sm ${s.state === 'error' ? '' : 'dim'}`} style={s.state === 'error' ? { color: 'var(--bad)' } : undefined}>
            {s.state === 'syncing' ? 'Syncing…' : s.state === 'error' ? s.error : s.lastSync ? `${s.sending ? 'Synced' : 'Received changes'} ${formatDistanceToNowStrict(s.lastSync, { addSuffix: true })}` : 'Not synced yet'}
          </span>
          <button
            className="btn sec sm"
            disabled={s.state === 'syncing'}
            onClick={async () => {
              const r = await window.veyra.sync.now()
              setS(r)
              if (r.state === 'idle') toast('Up to date')
            }}
          >
            <RefreshCw size={14} className={s.state === 'syncing' ? 'spin' : ''} /> Sync now
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- AI apps (MCP) ---------- */
export function AiAppsSection() {
  const toast = useToast()
  const { s, set } = useSettings()
  const [m, setM] = useState<McpState | null>(null)
  const [busy, setBusy] = useState('')
  useEffect(() => {
    void window.veyra.mcp.state().then(setM)
  }, [])
  // Start or stop it once the switch is saved.
  useEffect(() => {
    const t = setTimeout(() => void window.veyra.mcp.apply().then(setM), 700)
    return () => clearTimeout(t)
  }, [s.mcpEnabled])
  if (!m) return null

  const add = async (client: 'claude' | 'gemini', label: string) => {
    setBusy(client)
    try {
      const r = await window.veyra.mcp.add(client)
      setM(r)
      toast(`Added to ${label}. Restart ${label} to use it.`)
    } catch (e) {
      toast(clean(e))
    } finally {
      setBusy('')
    }
  }
  const q = (v: string) => (/\s/.test(v) ? `"${v}"` : v)
  const claudeCode = `claude mcp add veyra-study --scope user --env ELECTRON_RUN_AS_NODE=1 -- ${q(m.command)} ${m.args.map(q).join(' ')}`
  const codex = `[mcp_servers.veyra-study]\ncommand = '${m.command}'\nargs = [${m.args.map((a) => `'${a}'`).join(', ')}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }`
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast('Copied'))

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <div className="avatar lg" style={{ background: 'var(--panel-2)', color: '#7a4f9a' }}>
          <Bot size={20} />
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>AI apps (MCP)</div>
          <div className="sm dim">
            Let Claude, Gemini or ChatGPT on this computer see your tasks, notes and study time, using your own subscription. Veyra only answers apps on this computer.
          </div>
          <label className="toggle-row" style={{ marginTop: 14 }}>
            <span>
              <b>Let AI apps use Veyra</b>
              <span className="sm dim">Works while Veyra is open (or in the tray).</span>
            </span>
            <input type="checkbox" className="switch" checked={s.mcpEnabled} onChange={(e) => set({ mcpEnabled: e.target.checked })} />
          </label>
          {s.mcpEnabled && (
            <>
              <label className="toggle-row" style={{ marginTop: 10 }}>
                <span>
                  <b>Allow changes</b>
                  <span className="sm dim">AI apps can add and update tasks and write notes. Off: they can only read.</span>
                </span>
                <input type="checkbox" className="switch" checked={s.mcpAllowWrites} onChange={(e) => set({ mcpAllowWrites: e.target.checked })} />
              </label>
              {m.error && <p className="welcome-err" style={{ textAlign: 'left' }}>{m.error}</p>}
              <h2 style={{ marginTop: 18 }}>Connect an app</h2>
              <div className="ig mcp-apps">
                <div className="ig-row">
                  <div className="grow">
                    <div className="ig-title">Claude Desktop</div>
                    <div className="ig-sub">{m.claude.added ? 'Added. Restart Claude if you haven’t.' : 'Adds Veyra to Claude’s settings (keeping a backup).'}</div>
                  </div>
                  <button className={`btn sm ${m.claude.added ? 'sec' : ''}`} disabled={!!busy || !m.running} onClick={() => add('claude', 'Claude Desktop')}>
                    {m.claude.added ? 'Update' : 'Add to Claude'}
                  </button>
                </div>
                <div className="ig-row">
                  <div className="grow">
                    <div className="ig-title">Gemini CLI</div>
                    <div className="ig-sub">{m.gemini.added ? 'Added.' : 'Adds Veyra to ~/.gemini/settings.json (keeping a backup).'}</div>
                  </div>
                  <button className={`btn sm ${m.gemini.added ? 'sec' : ''}`} disabled={!!busy || !m.running} onClick={() => add('gemini', 'Gemini CLI')}>
                    {m.gemini.added ? 'Update' : 'Add to Gemini'}
                  </button>
                </div>
                <div className="ig-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title">Claude Code</div>
                    <div className="ig-sub">Run this once in a terminal.</div>
                    <code className="mcp-code">{claudeCode}</code>
                  </div>
                  <button className="btn sec sm" onClick={() => copy(claudeCode)}>
                    <Copy size={13} /> Copy
                  </button>
                </div>
                <div className="ig-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title">ChatGPT desktop and Codex</div>
                    <div className="ig-sub">Add it in ChatGPT’s settings under MCP servers, or paste into ~/.codex/config.toml. The ChatGPT website can’t reach apps on your computer.</div>
                    <code className="mcp-code">{codex}</code>
                  </div>
                  <button className="btn sec sm" onClick={() => copy(codex)}>
                    <Copy size={13} /> Copy
                  </button>
                </div>
              </div>
              <p className="xs dim" style={{ marginTop: 10 }}>
                {m.running ? `Running on this computer only (127.0.0.1:${m.port}), with a private key.` : 'Starting…'} Try asking: “What’s due this week in Veyra?”
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
