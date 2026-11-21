import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ChevronLeft, Copy, MailOpen, RefreshCw, Trash2, Zap } from 'lucide-react'
import { groupCall, gid } from '../data/groups'
import { Dialog, Seg, useToast } from '../components/ui'

/**
 * Settings → Owner → Diagnostics: the technical reports people sent, newest first,
 * grouped by app version so a bad release stands out. Unread until opened;
 * automatic ones (sent by the app after a crash) are marked, with what set them off
 * and, once the person answers, what they were doing. Reports go after 90 days.
 */

export type DiagCard = {
  id: string
  username: string
  at: number
  version: string
  platform: string
  auto: boolean
  trigger: string
  note: string
  noteAt: number | null
  read: boolean
  size: number
}
type DiagReport = DiagCard & { log: string }

const ago = (t: number) => formatDistanceToNowStrict(t, { addSuffix: true })
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`)

/** Plain words for what made an app send a report by itself. */
export const TRIGGER: Record<string, string> = {
  'screen process gone': 'A screen crashed',
  'helper process gone': 'A helper process crashed',
  'main error': 'Error in the app’s core',
  'window not responding': 'Window stopped responding',
  'rebuilding window': 'Window went missing (rebuilt)',
  'last run ended unexpectedly': 'Closed unexpectedly',
  'couldn’t open': 'Couldn’t open'
}
const triggerText = (t: string) => TRIGGER[t] ?? t

export function OwnerDiagnosticsTab({ onCount }: { onCount?: (unread: number) => void }) {
  const toast = useToast()
  const [data, setData] = useState<{ reports: DiagCard[] } | null>(null)
  const [error, setError] = useState('')
  const [show, setShow] = useState<'all' | 'unread' | 'auto'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => {
    setError('')
    groupCall<{ reports: DiagCard[]; unread: number }>('GET', '/admin/diagnostics')
      .then((r) => {
        setData(r)
        onCount?.(r.unread)
      })
      .catch((e) => setError(e instanceof Error && !/not found/i.test(e.message) ? e.message : 'The group server doesn’t take diagnostic reports yet. Update it to 1.17.0 or newer.'))
  }, [onCount])
  useEffect(load, [load])

  const groups = useMemo(() => {
    const list = (data?.reports ?? []).filter((r) => show === 'all' || (show === 'unread' ? !r.read : r.auto))
    const by = new Map<string, DiagCard[]>()
    for (const r of list) by.set(r.version || 'Unknown version', [...(by.get(r.version || 'Unknown version') ?? []), r])
    // Newest version first (by its newest report).
    return [...by.entries()].sort((a, b) => b[1][0].at - a[1][0].at)
  }, [data, show])

  if (open) return <ReportView id={open} onBack={() => (setOpen(null), load())} toast={toast} />
  if (error)
    return (
      <div className="card owner-problem">
        <span className="grow">{error}</span>
        <button className="btn sec sm" onClick={load}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    )
  if (!data) return <div className="dim sm owner-loading">Loading…</div>
  const unread = data.reports.filter((r) => !r.read).length
  return (
    <>
      <div className="owner-tools">
        <Seg
          value={show}
          onChange={setShow}
          options={[
            ['all', `All (${data.reports.length})`],
            ['unread', `Unread (${unread})`],
            ['auto', 'Automatic']
          ]}
        />
        <button className="btn ghost sm" onClick={load} aria-label="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>
      {!groups.length && <div className="ig"><div className="ig-row dim sm">{data.reports.length ? 'Nothing here.' : 'No reports yet. They’re kept for 90 days.'}</div></div>}
      {groups.map(([version, reports]) => {
        const autos = reports.filter((r) => r.auto).length
        return (
          <section key={version} className="diag-version">
            <h2 className="diag-version-head">
              {version}
              <span className="dim">
                {' '}
                · {reports.length} report{reports.length === 1 ? '' : 's'}
                {autos ? ` · ${autos} automatic` : ''}
              </span>
            </h2>
            <div className="ig">
              {reports.map((r) => (
                <button key={r.id} className={`ig-row tap diag-row ${r.read ? '' : 'unread'}`} onClick={() => setOpen(r.id)}>
                  <span className="diag-dot" aria-label={r.read ? undefined : 'Unread'} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ig-title trunc">
                      @{r.username}
                      {r.auto && (
                        <span className="pill accent" style={{ marginLeft: 6 }}>
                          <Zap size={11} /> {triggerText(r.trigger)}
                        </span>
                      )}
                    </div>
                    <div className="ig-sub trunc">
                      {ago(r.at)} · {r.platform || 'unknown system'} · {kb(r.size)} · {r.note ? `“${r.note}”` : r.auto ? 'No description yet' : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

function ReportView({ id, onBack, toast }: { id: string; onBack: () => void; toast: (t: string) => void }) {
  const [r, setR] = useState<DiagReport | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    let live = true
    groupCall<{ report: DiagReport }>('GET', `/admin/diagnostics/${gid(id)}`)
      .then(async ({ report }) => {
        if (!live) return
        setR(report)
        // Opening it reads it.
        if (!report.read) await groupCall('PATCH', `/admin/diagnostics/${gid(id)}`, { read: true }).catch(() => {})
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Couldn’t load the report.'))
    return () => {
      live = false
    }
  }, [id])
  const markUnread = async () => {
    await groupCall('PATCH', `/admin/diagnostics/${gid(id)}`, { read: false }).catch(() => {})
    toast('Marked unread')
    onBack()
  }
  const remove = async () => {
    try {
      await groupCall('DELETE', `/admin/diagnostics/${gid(id)}`)
      toast('Report deleted')
      onBack()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t delete it.')
    }
  }
  return (
    <>
      <div className="owner-tools">
        <button className="btn ghost sm" onClick={onBack}>
          <ChevronLeft size={15} /> All reports
        </button>
        <span className="grow" />
        {r && (
          <>
            <button className="btn ghost sm" onClick={() => void navigator.clipboard.writeText(r.log).then(() => toast('Log copied'))}>
              <Copy size={14} /> Copy log
            </button>
            <button className="btn ghost sm" onClick={() => void markUnread()}>
              <MailOpen size={14} /> Mark unread
            </button>
            <button className="btn ghost sm" onClick={() => setConfirm(true)}>
              <Trash2 size={14} /> Delete
            </button>
          </>
        )}
      </div>
      {error && <div className="card owner-problem">{error}</div>}
      {!r && !error && <div className="dim sm owner-loading">Loading…</div>}
      {r && (
        <div className="card diag-detail">
          <div className="ig-title">
            @{r.username} <span className="dim">· {r.version} · {r.platform}</span>
          </div>
          <div className="ig-sub">
            {new Date(r.at).toLocaleString()} · {r.auto ? `Sent automatically: ${triggerText(r.trigger)}` : 'Sent by hand'}
          </div>
          <div className="diag-what">
            <b>What happened</b>
            <p>{r.note || (r.auto ? 'They haven’t said yet. The app asks them; their answer appears here.' : '—')}</p>
          </div>
          <textarea className="diag-log" readOnly value={r.log} aria-label="The log" style={{ height: 380 }} />
        </div>
      )}
      {confirm && (
        <Dialog title="Delete this report?" onClose={() => setConfirm(false)}>
          <p className="dim" style={{ marginTop: 0 }}>
            It’s removed from the server for good.
          </p>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn dan" onClick={() => void remove()}>
              <Trash2 size={15} /> Delete
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
