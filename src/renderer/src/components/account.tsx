import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import './auth.css'
import { deviceWord } from '../lib/phone'
import type { AccountState } from '@shared/types'
import { IS_DEV } from '@shared/channel'
import { LegalDialog, type LegalWhich } from './Legal'
import { setChatOwner } from '../data/agent'
import { chatSyncAfterSignIn, startChatSync } from '../data/chat-sync'

const api = window.veyra.account

interface AccountCtx {
  state: AccountState
  /** Apply a new state; switching who is signed in reloads the app on their data. */
  apply: (s: AccountState) => void
  /** The same person with new details (email added or verified): no reload. */
  update: (s: AccountState) => void
}
const Ctx = createContext<AccountCtx | null>(null)
export const useAccount = () => useContext(Ctx)!

/** Loads who is using the app, shows the welcome screen when nobody has chosen yet. */
export function AccountGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState | null>(null)

  useEffect(() => {
    api.state().then((s) => {
      // Whose AI chats these are, before any screen reads them.
      setChatOwner(s.mode === 'account' ? (s.user?.username ?? null) : null)
      setState(s)
      // Check the saved sign-in with the server in the background.
      if (s.mode === 'account') api.refresh().then((r) => (r.mode !== 'account' ? location.reload() : setState(r)))
    })
  }, [])

  // AI chats sync (end-to-end encrypted) while you're signed in.
  const syncAs = state?.mode === 'account' && !state.ended ? (state.user?.username ?? null) : null
  useEffect(() => (syncAs ? startChatSync(syncAs) : undefined), [syncAs])

  const apply = useCallback((s: AccountState) => {
    if (s.notice === 'moved') sessionStorage.setItem('veyra.moved', '1')
    // Every screen reads from the newly opened database.
    location.reload()
    setState(s)
  }, [])

  if (!state) return null
  if (state.mode === 'none') return <Welcome notice={state.notice} onDone={apply} />
  return (
    <Ctx.Provider value={{ state, apply, update: setState }}>
      {children}
      {state.ended && <SignInAgain onDone={apply} />}
    </Ctx.Provider>
  )
}

/**
 * Veyra ended this sign-in (it checked several times first). You stay in your account with all
 * your data; this asks you to sign in again so syncing, Group work and Veyra AI carry on.
 */
function SignInAgain({ onDone }: { onDone: (s: AccountState) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="signin-again" role="status">
        <span className="grow">Your Veyra sign-in has ended. Your notes and tasks are all here; sign in again to keep syncing.</span>
        <button className="btn sm" onClick={() => setOpen(true)}>
          Sign in again
        </button>
      </div>
      {open && <Welcome onDone={onDone} onCancel={() => setOpen(false)} />}
    </>
  )
}

type Mode = 'signin' | 'signup'

/** The Veyra mark (live/index.html #v-mark): two offset chevrons, green under clay. */
export function VeyraMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M15 16 L32 50 L49 16" fill="none" stroke="#6fae82" strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round" transform="translate(2.5 2.5)" />
      <path d="M15 16 L32 50 L49 16" fill="none" stroke="#d9633e" strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Sign in / create account, mirroring Veyra home's auth screen
 * (carrotsz19/veyra live/index.html #v-auth): the brand panel on the left
 * on wide windows, and the card with the Log in / Create account switch.
 */
export function Welcome({
  notice,
  onDone,
  initial = 'signin',
  onCancel
}: {
  notice?: string
  onDone: (s: AccountState) => void
  initial?: Mode | 'start'
  onCancel?: () => void
}) {
  const [mode, setMode] = useState<Mode>(initial === 'signup' ? 'signup' : 'signin')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(notice && notice !== 'moved' ? notice : '')
  const [legal, setLegal] = useState<{ legal: string } | null>(null)
  const [legalPage, setLegalPage] = useState<LegalWhich | null>(null)
  // Forgot password, or confirming the email of a new account (it's signed in by then: pending).
  const [pane, setPane] = useState<null | 'reset' | 'verify'>(null)
  const [pending, setPending] = useState<AccountState | null>(null)
  const [info, setInfo] = useState('')
  const titleRef = useRef<HTMLHeadingElement>(null)
  const up = mode === 'signup'

  useEffect(() => {
    api.legalUrls().then(setLegal)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const switchTo = (m: Mode) => {
    setMode(m)
    setErr('')
    setInfo('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setErr('')
    // Top to bottom, as the form reads (same checks and words as Veyra home).
    if (!username.trim() || !password) return setErr('Enter your username and password.')
    if (up && (password.length < 8 || password.length > 200)) return setErr('Use a password of at least 8 characters.')
    if (up && !accept) return setErr('Tick the box to agree to the Terms and Privacy Policy.')
    setBusy(true)
    try {
      const s = up
        ? await api.signUp({ username: username.trim(), email: email.trim(), password, acceptLegal: accept })
        : await api.signIn(username.trim(), password)
      // AI chat sync: switched on (or unlocked) with the password just typed. Never holds sign-in up for long.
      if (s.mode === 'account' && s.user) await Promise.race([chatSyncAfterSignIn(s.user.username, password), new Promise((r) => setTimeout(r, 12_000))])
      setPassword('')
      // A new account with an email: confirm it now (it's how a forgotten password is reset).
      if (up && email.trim() && s.user && !s.user.emailVerified) {
        setPending(s)
        setPane('verify')
        return
      }
      onDone(s)
    } catch (ex) {
      setErr(String((ex as Error).message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const open = (url?: string) => url && window.veyra.open(url)
  const [showPw, setShowPw] = useState(false)

  return (
    <div className={`vauth ${onCancel ? 'overlay' : ''}`}>
      <aside className="wide-brand" aria-hidden="true">
        <span className="wb-mark">
          <VeyraMark size={30} />
          Veyra
        </span>
        <div>
          <h2>Your studies, your training and your money, in one place.</h2>
          <p>One Veyra account opens Veyra Study, IronLog and Cashline, on your phone and on your computer.</p>
          <div className="wb-apps">
            <span className="wb-app">
              <i style={{ background: '#2f5f8a' }}>S</i>
              <span>
                <b>Veyra Study</b>
                <small>Tasks, notes and focus</small>
              </span>
            </span>
            <span className="wb-app">
              <i style={{ background: '#d9633e' }}>I</i>
              <span>
                <b>IronLog</b>
                <small>Workouts and progress</small>
              </span>
            </span>
            <span className="wb-app">
              <i style={{ background: '#4f8a60' }}>C</i>
              <span>
                <b>Cashline</b>
                <small>Budgets, bills and goals</small>
              </span>
            </span>
          </div>
        </div>
        <span className="wb-foot">Veyra</span>
      </aside>

      <section className="view" aria-labelledby="auth-title">
        <div className="col">
          {onCancel && (
            <button type="button" className="close" aria-label="Close" onClick={onCancel}>
              ×
            </button>
          )}
          <div className="brand">
            <VeyraMark />
            Veyra
          </div>
          {pane === 'reset' ? (
            <ResetPassword
              start={username.trim()}
              onBack={(changedFor) => {
                setPane(null)
                setMode('signin')
                setErr('')
                if (changedFor) {
                  if (!changedFor.includes('@')) setUsername(changedFor)
                  setInfo('Password changed. Log in with the new one.')
                }
              }}
            />
          ) : pane === 'verify' && pending ? (
            <VerifyEmail email={pending.user?.email ?? ''} onVerified={onDone} onLater={() => onDone(pending)} />
          ) : (
          <>
          <div
            className="seg"
            role="tablist"
            aria-label="Log in or create an account"
            data-mode={mode}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                switchTo(up ? 'signin' : 'signup')
              }
            }}
          >
            <span className="pillbg" aria-hidden="true" />
            <button type="button" role="tab" aria-selected={!up} aria-controls="auth-form" onClick={() => switchTo('signin')}>
              Log in
            </button>
            <button type="button" role="tab" aria-selected={up} aria-controls="auth-form" onClick={() => switchTo('signup')}>
              Create account
            </button>
          </div>
          <h1 className="title" id="auth-title" ref={titleRef}>
            {up ? 'Create your Veyra account' : 'Welcome back'}
          </h1>
          <p className="lede">{info || (up ? 'One account for Veyra Study, IronLog and Cashline.' : 'Log in to open Veyra Study.')}</p>
          {IS_DEV && (
            <p className="dev-warn">
              <b>This is Veyra Study Dev, a test build.</b> Signing in uses your real account: anything a test build changes syncs to
              your other devices and your groups.
            </p>
          )}
          <form id="auth-form" onSubmit={submit} noValidate>
            <div className="fields">
              <div className="field">
                <label className="sr-only" htmlFor="auth-user">Username</label>
                <input id="auth-user" aria-label="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              {up && (
                <div className="field">
                  <label className="sr-only" htmlFor="auth-email">Email (optional)</label>
                  <input id="auth-email" type="email" autoComplete="email" autoCapitalize="none" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <span className="opt" aria-hidden="true">Optional</span>
                </div>
              )}
              <div className="field">
                <label className="sr-only" htmlFor="auth-pass">Password</label>
                <input id="auth-pass" aria-label="Password" type={showPw ? 'text' : 'password'} autoComplete={up ? 'new-password' : 'current-password'} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="pw-toggle" aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} onClick={() => setShowPw(!showPw)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          </form>
          {up && <p className="hint">At least 8 characters. Add an email to reset your password if you forget it, and to use IronLog&apos;s social features.</p>}
          {up && (
            <label className="check">
              <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
              <span>
                I&apos;m 16 or over, and I agree to Veyra Study&apos;s{' '}
                <a
                  href="#terms"
                  onClick={(e) => {
                    e.preventDefault()
                    setLegalPage('terms')
                  }}
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="#privacy"
                  onClick={(e) => {
                    e.preventDefault()
                    setLegalPage('privacy')
                  }}
                >
                  Privacy Policy
                </a>
                , and to the Veyra account{' '}
                <a
                  href={legal?.legal}
                  onClick={(e) => {
                    e.preventDefault()
                    open(legal?.legal)
                  }}
                >
                  Terms and Privacy Policy
                </a>{' '}
                shared with IronLog and Cashline. I understand IronLog isn&apos;t medical or fitness advice, and Cashline isn&apos;t financial advice.
              </span>
            </label>
          )}
          {legalPage && <LegalDialog which={legalPage} onClose={() => setLegalPage(null)} />}
          <p className="err" role="alert">
            {err}
          </p>
          <div className="push-down" />
          <button type="submit" form="auth-form" className="btn btn-primary" aria-disabled={busy || undefined}>
            {busy ? (up ? 'Creating your account…' : 'Logging in…') : up ? 'Create account' : 'Log in'}
          </button>
          {!up && (
            <button
              type="button"
              className="btn btn-plain"
              onClick={() => {
                setErr('')
                setInfo('')
                setPane('reset')
              }}
            >
              Forgot password?
            </button>
          )}
          {!onCancel && (
            <>
              <button type="button" className="btn btn-plain dim" onClick={() => api.continueAsGuest().then(onDone)}>
                Use Veyra Study without an account
              </button>
              <p className="guest-note">Everything stays on this {deviceWord()}. You can sign in later and keep it all.</p>
            </>
          )}
          </>
          )}
        </div>
      </section>
    </div>
  )
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Forgot password, in the app: Veyra emails a code to the account's verified email, and the code
 * with a new password sets it (as on Veyra's own pages). Every sign-in of the account then ends.
 */
function ResetPassword({ start, onBack }: { start: string; onBack: (changedFor?: string) => void }) {
  const [id, setId] = useState(start)
  const [stage, setStage] = useState<'ask' | 'code'>('ask')
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lede, setLede] = useState('Enter your username or email. We’ll email a code to the address on your account.')

  const send = async () => {
    if (!id.trim()) return setErr('Enter your username or email.')
    setBusy(true)
    setErr('')
    try {
      const r = await api.requestReset(id.trim())
      setStage('code')
      setLede(r.sentTo ? `A code is on its way to ${r.sentTo}. Enter it with a new password.` : 'If that account has a verified email, a code is on its way. Enter it with a new password.')
    } catch (ex) {
      setErr(clean(ex))
    } finally {
      setBusy(false)
    }
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (stage === 'ask') return send()
    if (!/^\d{6}$/.test(code.trim())) return setErr('Enter the 6-digit code from your email.')
    if (pw.length < 8 || pw.length > 200) return setErr('Use a password of at least 8 characters.')
    setBusy(true)
    setErr('')
    try {
      await api.resetPassword(id.trim(), code.trim(), pw)
      onBack(id.trim())
    } catch (ex) {
      setErr(clean(ex))
      setBusy(false)
    }
  }

  return (
    <>
      <h1 className="title" id="auth-title">
        Reset your password
      </h1>
      <p className="lede">{lede}</p>
      <form id="reset-form" onSubmit={submit} noValidate>
        <div className="fields">
          <div className="field">
            <input aria-label="Username or email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Username or email" autoFocus={stage === 'ask'} readOnly={stage === 'code'} value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          {stage === 'code' && (
            <>
              <div className="field">
                <input aria-label="Code from the email" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className="field">
                <input aria-label="New password" type={showPw ? 'text' : 'password'} autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
                <button type="button" className="pw-toggle" aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw} onClick={() => setShowPw(!showPw)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </>
          )}
        </div>
      </form>
      {stage === 'code' ? (
        <p className="hint">At least 8 characters. Changing it signs your account out everywhere, including IronLog and Cashline.</p>
      ) : (
        <p className="hint">This works when your account has a verified email. It’s the same Veyra account as IronLog and Cashline.</p>
      )}
      <p className="err" role="alert">
        {err}
      </p>
      <div className="push-down" />
      <button type="submit" form="reset-form" className="btn btn-primary" aria-disabled={busy || undefined}>
        {busy ? (stage === 'ask' ? 'Sending…' : 'Saving…') : stage === 'ask' ? 'Send code' : 'Set new password'}
      </button>
      {stage === 'code' && (
        <button type="button" className="btn btn-plain" disabled={busy} onClick={() => void send()}>
          Send a new code
        </button>
      )}
      <button type="button" className="btn btn-plain dim" onClick={() => onBack()}>
        Back to log in
      </button>
    </>
  )
}

/** A new account's email: the code Veyra sent to it (or later, from Settings → Account). */
function VerifyEmail({ email, onVerified, onLater }: { email: string; onVerified: (s: AccountState) => void; onLater: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lede, setLede] = useState(`We sent a 6-digit code to ${email}. Enter it to confirm your email, so you can reset your password if you ever forget it.`)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!/^\d{6}$/.test(code.trim())) return setErr('Enter the 6-digit code from your email.')
    setBusy(true)
    setErr('')
    try {
      onVerified(await api.verifyEmail(code.trim()))
    } catch (ex) {
      setErr(clean(ex))
      setBusy(false)
    }
  }
  return (
    <>
      <h1 className="title" id="auth-title">
        Check your email
      </h1>
      <p className="lede">{lede}</p>
      <form id="verify-form" onSubmit={submit} noValidate>
        <div className="fields">
          <div className="field">
            <input aria-label="Code from the email" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
      </form>
      <p className="err" role="alert">
        {err}
      </p>
      <div className="push-down" />
      <button type="submit" form="verify-form" className="btn btn-primary" aria-disabled={busy || undefined}>
        {busy ? 'Checking…' : 'Confirm email'}
      </button>
      <button
        type="button"
        className="btn btn-plain"
        disabled={busy}
        onClick={async () => {
          setErr('')
          try {
            const r = await api.resendVerification()
            if (r.alreadyVerified) return onVerified(await api.state())
            setLede(r.sentTo ? `A new code is on its way to ${r.sentTo}.` : 'A new code is on its way.')
          } catch (ex) {
            setErr(clean(ex))
          }
        }}
      >
        Send a new code
      </button>
      <button type="button" className="btn btn-plain dim" onClick={onLater}>
        Later (Settings → Account)
      </button>
    </>
  )
}

/** Profile photo, or the first letter of the name if there is none or it fails to load. */
export function Avatar({ user, large }: { user: { displayName: string; username: string; photoUrl?: string }; large?: boolean }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={`avatar ${large ? 'lg' : ''}`}>
      {user.photoUrl && !broken ? (
        <img src={user.photoUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        (user.displayName || user.username).slice(0, 1).toUpperCase()
      )}
    </span>
  )
}
