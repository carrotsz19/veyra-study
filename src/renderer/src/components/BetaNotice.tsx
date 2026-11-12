import { useState } from 'react'
import { Bug, Mail, X } from 'lucide-react'

/**
 * "Veyra Study is still being built": shown once at the top of the app, so
 * people know bugs can turn up and how to tell the owner. After "Got it" it
 * stays in Settings → Software update (BetaNote) and the Help menu.
 */
export const FEEDBACK = {
  owner: '@carrotsz19',
  email: 'igreenrobotz@gmail.com',
  issues: 'https://github.com/carrotsz19/veyra-study/issues/new'
}
export const reportBug = () => void window.veyra.open(FEEDBACK.issues)
export const emailOwner = () =>
  void window.veyra.open(`mailto:${FEEDBACK.email}?subject=${encodeURIComponent(`Veyra Study ${__APP_VERSION__}: `)}`)

const KEY = 'veyra.betaNoticeSeen'

/** The card at the top of the app, until it's dismissed. */
export function BetaNotice() {
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  if (seen) return null
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable: it just shows again next time */
    }
    setSeen(true)
  }
  return (
    <div className="beta-notice" role="note">
      <span className="beta-icon">
        <Bug size={16} />
      </span>
      <div className="beta-text">
        <b>Veyra Study is still being built.</b> You may run into bugs. If something goes wrong, let the owner ({FEEDBACK.owner}) know: email{' '}
        <button className="linkbtn" onClick={emailOwner}>
          {FEEDBACK.email}
        </button>{' '}
        or open a bug report on GitHub.
      </div>
      <div className="beta-actions">
        <button className="btn sec sm" onClick={reportBug}>
          <Bug size={14} /> Report a bug
        </button>
        <button className="btn sec sm" onClick={emailOwner}>
          <Mail size={14} /> Email
        </button>
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

/** The same message, kept in Settings → Software update. */
export function BetaNote() {
  return (
    <p className="beta-note">
      <Bug size={14} /> Veyra Study is still being built, so you may run into bugs. Tell the owner ({FEEDBACK.owner}): email{' '}
      <button className="linkbtn" onClick={emailOwner}>
        {FEEDBACK.email}
      </button>{' '}
      or{' '}
      <button className="linkbtn" onClick={reportBug}>
        open a bug report
      </button>
      .
    </p>
  )
}
