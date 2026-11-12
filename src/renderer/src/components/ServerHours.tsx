import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Moon, X } from 'lucide-react'
import { useAccount } from './account'
import { BETA_SEEN_EVENT, betaNoticeSeen } from './BetaNotice'

/**
 * For now the Veyra server (groups and sync) sleeps overnight: roughly 12 am to
 * 8 am in the owner's time zone (UTC+8). People hear about it once, and pages
 * that need the server warn from 11:30 pm and while it's asleep.
 */
const SERVER_OFFSET = 8 // hours ahead of UTC
const SLEEP_FROM = 0 // 12 am, server time
const WAKE_AT = 8 // 8 am, server time
const WARN_FROM = 23.5 // 11:30 pm, server time

const KEY = 'veyra.serverHoursSeen'

/** The hour of day (with fractions) at the server. */
function serverHour(d = new Date()): number {
  return (d.getUTCHours() + SERVER_OFFSET + 24) % 24 + d.getUTCMinutes() / 60
}

/** A server-time hour shown in this computer's time, e.g. "12 am". */
function local(hour: number): string {
  const d = new Date()
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - SERVER_OFFSET))
  return format(at, at.getMinutes() ? 'h:mm aaa' : 'h aaa')
}

export type ServerPhase = 'soon' | 'asleep' | null
export function serverPhase(d = new Date()): ServerPhase {
  const h = serverHour(d)
  if (h >= WARN_FROM) return 'soon'
  if (h >= SLEEP_FROM && h < WAKE_AT) return 'asleep'
  return null
}

/** Re-checks every 30 seconds. */
export function useServerPhase(): ServerPhase {
  const [phase, setPhase] = useState(() => serverPhase())
  useEffect(() => {
    const t = setInterval(() => setPhase(serverPhase()), 30_000)
    return () => clearInterval(t)
  }, [])
  return phase
}

export const sleepHours = () => `${local(SLEEP_FROM)} to ${local(WAKE_AT)}`

/** The once-only card (after the "still being built" one), for people signed in to a Veyra account. */
export function ServerHoursNotice() {
  const account = useAccount()?.state
  const [beta, setBeta] = useState(betaNoticeSeen)
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    const on = () => setBeta(true)
    window.addEventListener(BETA_SEEN_EVENT, on)
    return () => window.removeEventListener(BETA_SEEN_EVENT, on)
  }, [])
  if (seen || !beta || account?.mode !== 'account') return null
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable: it just shows again next time */
    }
    setSeen(true)
  }
  return (
    <div className="beta-notice srv-notice" role="note">
      <span className="beta-icon srv-icon">
        <Moon size={16} />
      </span>
      <div className="beta-text">
        <b>The Veyra server sleeps at night, from about {sleepHours()}.</b> During those hours group work and syncing between your devices pause.
        Everything on this device keeps working, and your changes sync when the server is back.
      </div>
      <div className="beta-actions">
        <button className="btn sm" onClick={dismiss}>
          Got it
        </button>
      </div>
      <button className="iconbtn plain beta-close" aria-label="Close" onClick={dismiss}>
        <X size={15} />
      </button>
    </div>
  )
}

/** A line on pages that need the server: from 11:30 pm, and while it's asleep. */
export function ServerHoursBanner({ what = 'Group work' }: { what?: string }) {
  const phase = useServerPhase()
  if (!phase) return null
  return (
    <div className="srv-banner" role="status">
      <Moon size={15} />
      <span>
        {phase === 'soon' ? (
          <>
            <b>The server goes to sleep at about {local(SLEEP_FROM)}</b> and is back around {local(WAKE_AT)}. {what} pauses until then.
          </>
        ) : (
          <>
            <b>The server is asleep until about {local(WAKE_AT)}.</b> {what} pauses until then. Everything on this device still works.
          </>
        )}
      </span>
    </div>
  )
}
