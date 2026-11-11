import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { GraduationCap } from 'lucide-react'
import type { AccountState } from '@shared/types'

const api = window.veyra.account

interface AccountCtx {
  state: AccountState
  /** Apply a new state; switching who is signed in reloads the app on their data. */
  apply: (s: AccountState) => void
}
const Ctx = createContext<AccountCtx | null>(null)
export const useAccount = () => useContext(Ctx)!

/** Loads who is using the app, shows the welcome screen when nobody has chosen yet. */
export function AccountGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState | null>(null)

  useEffect(() => {
    api.state().then((s) => {
      setState(s)
      // Check the saved sign-in with the server in the background.
      if (s.mode === 'account') api.refresh().then((r) => (r.mode !== 'account' ? location.reload() : setState(r)))
    })
  }, [])

  const apply = useCallback((s: AccountState) => {
    if (s.notice === 'moved') sessionStorage.setItem('veyra.moved', '1')
    // Every screen reads from the newly opened database.
    location.reload()
    setState(s)
  }, [])

  if (!state) return null
  if (state.mode === 'none') return <Welcome notice={state.notice} onDone={apply} />
  return <Ctx.Provider value={{ state, apply }}>{children}</Ctx.Provider>
}

type Mode = 'start' | 'signin' | 'signup'

export function Welcome({ notice, onDone, initial = 'start', onCancel }: { notice?: string; onDone: (s: AccountState) => void; initial?: Mode; onCancel?: () => void }) {
  const [mode, setMode] = useState<Mode>(initial)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accept, setAccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(notice && notice !== 'moved' ? notice : '')
  const [legal, setLegal] = useState<{ terms: string; privacy: string; terms2: string; privacy2: string } | null>(null)

  useEffect(() => {
    if (mode === 'signup' && !legal) api.legalUrls().then(setLegal)
  }, [mode, legal])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setErr('')
    if (!username.trim() || !password) return setErr('Enter your username and password.')
    if (mode === 'signup' && password.length < 8) return setErr('Use a password of at least 8 characters.')
    if (mode === 'signup' && !accept) return setErr('Tick the box to agree to the Terms and Privacy Policy.')
    setBusy(true)
    try {
      const s =
        mode === 'signup'
          ? await api.signUp({ username: username.trim(), email: email.trim(), password, acceptLegal: accept })
          : await api.signIn(username.trim(), password)
      setPassword('')
      onDone(s)
    } catch (ex) {
      setErr(String((ex as Error).message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  const link = (href: string | undefined, text: string) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.veyra.open(href)
      }}
    >
      {text}
    </a>
  )

  return (
    <div className="welcome">
      <div className="welcome-card view">
        <div className="welcome-mark">
          <GraduationCap size={28} />
        </div>
        <h1>{mode === 'signup' ? 'Create your Veyra account' : mode === 'signin' ? 'Sign in to Veyra' : 'Welcome to Veyra Study'}</h1>
        <p className="dim welcome-lead">
          {mode === 'start'
            ? 'Tasks, notes, deadlines and focus time for your studies. Use your Veyra account, the same one as IronLog and Cashline.'
            : mode === 'signin'
              ? 'Use the username and password you use for IronLog or Cashline.'
              : 'One account for every Veyra app.'}
        </p>

        {mode === 'start' ? (
          <div className="stack" style={{ marginTop: 22 }}>
            <button className="btn lg" style={{ width: '100%' }} onClick={() => setMode('signin')}>
              Sign in
            </button>
            <button className="btn sec lg" style={{ width: '100%' }} onClick={() => setMode('signup')}>
              Create an account
            </button>
            <button className="btn ghost" style={{ width: '100%', border: 0 }} onClick={() => api.continueAsGuest().then(onDone)}>
              Use without an account
            </button>
            {err && <p className="welcome-err">{err}</p>}
          </div>
        ) : (
          <form onSubmit={submit} style={{ marginTop: 20 }} noValidate>
            <div className="field-group">
              <input aria-label="Username" placeholder="Username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
              {mode === 'signup' && (
                <input aria-label="Email (optional)" placeholder="Email (optional, for password resets)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
              <input aria-label="Password" placeholder="Password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {mode === 'signup' && (
              <label className="consent">
                <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                <span>
                  I agree to the Veyra Terms of Service and Privacy Policy for IronLog ({link(legal?.terms, 'Terms')}, {link(legal?.privacy, 'Privacy')}) and Cashline ({link(legal?.terms2, 'Terms')},{' '}
                  {link(legal?.privacy2, 'Privacy')}). One Veyra account covers both.
                </span>
              </label>
            )}
            {err && <p className="welcome-err">{err}</p>}
            <button className="btn lg" type="submit" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
              {busy ? (mode === 'signup' ? 'Creating your account…' : 'Signing in…') : mode === 'signup' ? 'Create account' : 'Sign in'}
            </button>
            <div className="between sm" style={{ marginTop: 14 }}>
              <button type="button" className="linkbtn" onClick={() => (onCancel && initial !== 'start' ? onCancel() : setMode('start'))}>
                ← Back
              </button>
              <button type="button" className="linkbtn" onClick={() => { setErr(''); setMode(mode === 'signin' ? 'signup' : 'signin') }}>
                {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
              </button>
            </div>
            {mode === 'signin' && <p className="xs tert" style={{ textAlign: 'center', marginTop: 14 }}>Forgot your password? Reset it from the IronLog or Cashline sign-in page.</p>}
          </form>
        )}
      </div>
    </div>
  )
}
