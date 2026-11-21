import { useEffect, useState } from 'react'
import { Dialog, useToast } from './ui'

type Ask = { id: string; trigger: string; at: number }

/** Plain words for what made the app send a report by itself. */
const WHAT: Record<string, string> = {
  'screen process gone': 'part of Veyra crashed',
  'helper process gone': 'part of Veyra crashed',
  'main error': 'Veyra hit an error',
  'window not responding': 'the window stopped responding',
  'rebuilding window': 'the window went missing and had to be rebuilt',
  'last run ended unexpectedly': 'Veyra closed unexpectedly last time',
  'couldn’t open': 'Veyra couldn’t open properly'
}

/**
 * After the app sent a diagnostics report by itself (Settings → Data & privacy →
 * Diagnostics → Send reports automatically), asks the person what happened, and
 * adds their answer to that report. Mounted once in the app; desktop only.
 */
export function DiagAsk() {
  const app = window.veyra.app
  const toast = useToast()
  const [ask, setAsk] = useState<Ask | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!app.diagAsk) return
    let live = true
    void app.diagAsk().then((a) => live && a && setAsk(a))
    const off = app.onDiagAsk?.((a) => setAsk(a))
    return () => {
      live = false
      off?.()
    }
  }, [app])
  if (!ask) return null
  const skip = () => {
    void app.diagDismiss?.()
    setAsk(null)
    setNote('')
  }
  const send = async () => {
    if (!note.trim() || !app.diagAnswer) return
    setBusy(true)
    try {
      const r = await app.diagAnswer(ask.id, note)
      if (r.ok) {
        toast('Added to the report. Thank you!')
        setAsk(null)
        setNote('')
      } else toast(r.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Veyra ran into a problem" onClose={() => setAsk(null)} width={460}>
      <p className="sm" style={{ margin: '0 0 12px', color: 'var(--dim)', lineHeight: 1.5 }}>
        {WHAT[ask.trigger] ? `Earlier, ${WHAT[ask.trigger]}.` : 'Something went wrong earlier.'} Veyra sent a technical report to the owner, as you chose in Settings → Data &amp; privacy. What were you doing when it happened? Even a sentence helps get it fixed.
      </p>
      <textarea
        className="set-input diag-note"
        rows={4}
        autoFocus
        placeholder="For example: I was typing in a note and the window went blank."
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        aria-label="What happened"
      />
      <div className="actions">
        <button className="btn ghost left" onClick={skip}>
          Don’t add anything
        </button>
        <button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Add to report'}
        </button>
      </div>
    </Dialog>
  )
}
