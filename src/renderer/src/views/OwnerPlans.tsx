import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { AlertTriangle, FlaskConical, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { groupCall } from '../data/groups'
import { Dialog, useToast } from '../components/ui'

/**
 * Settings → Owner → Plans: paid plans through Stripe (server/billing.mjs). The plans themselves
 * (products and prices) are made in the Stripe Dashboard; here each one gets a name, how its price
 * reads, its Stripe price id, and the Veyra AI limits it gives. Plans stay owner-only until
 * "Open plans to everyone" is on, like the Veyra AI tab.
 */

type AiLimits = { fiveHour: number | null; week: number | null; month: number | null }
type PlanDef = { id: string; name: string; blurb: string; price: string; priceId: string; ai: AiLimits | null; available?: boolean; visible?: boolean }
type Settings = { open: boolean; plans: PlanDef[]; returnUrl: string }
type Sub = { username: string; planName: string; status: string; active: boolean; periodEnd: number | null; cancelAtEnd: boolean; customerId: string; updatedAt: number }
type Admin = { mode: 'off' | 'test' | 'live'; configured: boolean; settings: Settings; subscribers: Sub[]; customers: number }

const blank = (): PlanDef => ({ id: '', name: '', blurb: '', price: '', priceId: '', ai: { fiveHour: null, week: null, month: null }, available: true, visible: true })

/** Keeps the raw text while typing so decimal points like "0." aren't eaten by Number(). */
function DecimalInput({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  const fmt = (v: number | null) => (v !== null && Number.isFinite(v) ? String(v) : '')
  const [text, setText] = useState(() => fmt(value))
  useEffect(() => {
    const parsed = text.trim() === '' ? null : Number(text)
    if (parsed !== value) setText(fmt(value))
  }, [value])
  return (
    <input
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
        setText(raw)
        if (raw === '') return onChange(null)
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setText(fmt(value))}
    />
  )
}

export function OwnerPlansTab() {
  const toast = useToast()
  const [data, setData] = useState<Admin | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const load = useCallback(() => {
    setError('')
    groupCall<Admin>('GET', '/admin/billing')
      .then((d) => {
        setData(d)
        setDraft(d.settings)
      })
      .catch((e) => setError(e instanceof Error && !/not found/i.test(e.message) ? e.message : 'Plans need group server 1.18.0 or newer.'))
  }, [])
  useEffect(load, [load])

  const save = async (next: Settings) => {
    setSaving(true)
    try {
      const r = await groupCall<{ settings: Settings }>('PUT', '/admin/billing', next)
      setDraft(r.settings)
      setData((d) => (d ? { ...d, settings: r.settings } : d))
      toast('Plans saved')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t save.')
    } finally {
      setSaving(false)
    }
  }
  const sync = async () => {
    try {
      const r = await groupCall<{ synced: number }>('POST', '/admin/billing/sync')
      toast(`Checked ${r.synced} with Stripe`)
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t reach Stripe.')
    }
  }

  if (error)
    return (
      <div className="card owner-problem">
        <span className="grow">{error}</span>
        <button className="btn sec sm" onClick={load}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    )
  if (!data || !draft) return <div className="dim sm owner-loading">Loading…</div>
  const setPlan = (i: number, p: Partial<PlanDef>) => setDraft({ ...draft, plans: draft.plans.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  const setAi = (i: number, k: keyof AiLimits, v: number | null) => setPlan(i, { ai: { ...(draft.plans[i].ai ?? { fiveHour: null, week: null, month: null }), [k]: v } })
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings)

  const modeTone = !data.configured ? 'warn' : data.mode === 'live' ? 'live' : 'test'
  const ModeIcon = !data.configured ? AlertTriangle : data.mode === 'live' ? ShieldAlert : FlaskConical

  return (
    <>
      <div className={`card billing-mode tone-${modeTone}`}>
        <span className="billing-mode-icon" aria-hidden="true">
          <ModeIcon size={16} />
        </span>
        <div className="billing-mode-copy">
          {!data.configured ? (
            <>
              <div className="billing-mode-head">
                <b>Stripe isn’t set up</b>
                <span className="pill">Not configured</span>
              </div>
              <p>Add STRIPE_SECRET_KEY to the group server’s .env (a restricted rk_ key is best), then restart it.</p>
            </>
          ) : (
            <>
              <div className="billing-mode-head">
                <b>Stripe</b>
                <span className={`pill ${data.mode === 'live' ? 'bad' : 'accent'}`}>{data.mode === 'live' ? 'Live mode · real payments' : 'Test mode'}</span>
              </div>
              <p>
                {data.customers} customer{data.customers === 1 ? '' : 's'}. The server checks Stripe every hour, and when people come back from paying.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="card billing-open">
        <div className="grow">
          <div className="ig-title">Open plans to everyone</div>
          <div className="ig-sub">{data.settings.open ? 'Everyone signed in sees plans in Settings → Plan & billing.' : 'Off: only you see plans. Everyone else sees “Coming soon”.'}</div>
        </div>
        <button className={`btn sm ${data.settings.open ? 'sec' : 'btn-primary'}`} disabled={saving || dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => (data.settings.open ? void save({ ...data.settings, open: false }) : setConfirmOpen(true))}>
          {data.settings.open ? 'Close to everyone' : 'Open to everyone…'}
        </button>
      </div>

      <h2 className="diag-version-head" style={{ marginTop: 18 }}>
        Plans
      </h2>
      {draft.plans.map((p, i) => {
        const available = p.available !== false
        const visible = p.visible !== false
        const status = !visible ? 'Hidden' : available ? 'Live' : 'Shown as unavailable'
        return (
        <div key={i} className={`card billing-edit ${!visible || !available ? 'muted' : ''}`}>
          <div className="billing-edit-bar">
            <span className={`pill ${visible && available ? 'accent' : ''}`}>{status}</span>
            <div className="billing-edit-toggles">
              <label className="billing-toggle">
                <span>Available</span>
                <input type="checkbox" className="switch" role="switch" checked={available} onChange={(e) => setPlan(i, { available: e.target.checked })} />
              </label>
              <label className="billing-toggle">
                <span>Show</span>
                <input type="checkbox" className="switch" role="switch" checked={visible} onChange={(e) => setPlan(i, { visible: e.target.checked })} />
              </label>
            </div>
          </div>
          <div className="billing-edit-grid">
            <label>
              Id
              <input value={p.id} placeholder="plus" onChange={(e) => setPlan(i, { id: e.target.value })} />
            </label>
            <label>
              Name
              <input value={p.name} placeholder="Plus" onChange={(e) => setPlan(i, { name: e.target.value })} />
            </label>
            <label>
              Price, as shown
              <input value={p.price} placeholder="$4 a month" onChange={(e) => setPlan(i, { price: e.target.value })} />
            </label>
            <label>
              Stripe price id
              <input value={p.priceId} placeholder="price_…" onChange={(e) => setPlan(i, { priceId: e.target.value.trim() })} />
            </label>
            <label className="wide">
              Description (put each highlight on a new line for a checklist)
              <textarea rows={2} value={p.blurb} placeholder="More Veyra AI, every model" onChange={(e) => setPlan(i, { blurb: e.target.value })} />
            </label>
            <label>
              AI limit per 5 hours ($)
              <DecimalInput value={p.ai?.fiveHour ?? null} placeholder="none" onChange={(v) => setAi(i, 'fiveHour', v)} />
            </label>
            <label>
              AI limit per week ($)
              <DecimalInput value={p.ai?.week ?? null} placeholder="none" onChange={(v) => setAi(i, 'week', v)} />
            </label>
            <label>
              AI limit per month ($)
              <DecimalInput value={p.ai?.month ?? null} placeholder="none" onChange={(v) => setAi(i, 'month', v)} />
            </label>
          </div>
          <button className="btn ghost sm" onClick={() => setDraft({ ...draft, plans: draft.plans.filter((_, j) => j !== i) })}>
            <Trash2 size={14} /> Remove
          </button>
        </div>
        )
      })}
      <p className="xs tert" style={{ margin: '4px 0 10px' }}>
        Make the product and its price in the Stripe Dashboard, then paste the price id here. AI limits are Veyra AI dollars, like Owner → AI; while someone’s plan is active they replace that person’s limits, and their earlier limits come back when it ends. Leave all three empty to leave Veyra AI as it is.
      </p>
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={() => setDraft({ ...draft, plans: [...draft.plans, blank()] })}>
          <Plus size={14} /> Add a plan
        </button>
      </div>

      <label className="billing-return">
        Where Stripe sends people back to (https)
        <input value={draft.returnUrl} placeholder="The Veyra Study website" onChange={(e) => setDraft({ ...draft, returnUrl: e.target.value })} />
      </label>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', margin: '10px 0 22px' }}>
        <button className="btn ghost sm" disabled={!dirty || saving} onClick={() => setDraft(data.settings)}>
          Undo changes
        </button>
        <button className="btn btn-primary sm" disabled={!dirty || saving} onClick={() => void save(draft)}>
          {saving ? 'Saving…' : 'Save plans'}
        </button>
      </div>

      <div className="owner-tools">
        <h2 className="diag-version-head grow" style={{ margin: 0 }}>
          Subscribers
        </h2>
        <button className="btn ghost sm" onClick={() => void sync()} disabled={!data.configured}>
          <RefreshCw size={14} /> Check Stripe now
        </button>
      </div>
      <div className="ig">
        {data.subscribers.map((s) => (
          <div key={s.username} className="ig-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ig-title trunc">
                @{s.username} <span className={`pill ${s.active ? 'accent' : ''}`}>{s.planName}: {s.status}</span>
              </div>
              <div className="ig-sub trunc">
                {s.periodEnd ? `${s.cancelAtEnd ? 'ends' : 'renews'} ${new Date(s.periodEnd).toLocaleDateString()} · ` : ''}checked {formatDistanceToNowStrict(s.updatedAt, { addSuffix: true })} · {s.customerId}
              </div>
            </div>
          </div>
        ))}
        {!data.subscribers.length && <div className="ig-row dim sm">No subscriptions yet.</div>}
      </div>

      {confirmOpen && (
        <Dialog title="Open plans to everyone?" onClose={() => setConfirmOpen(false)}>
          <p className="dim" style={{ marginTop: 0 }}>
            Everyone signed in will see Settings → Plan & billing and can subscribe{data.mode === 'live' ? ', paying real money' : ' (Stripe is in test mode, so no real payments)'}. Before opening with live payments, add payment, renewal and refund terms to the Terms of Service.
          </p>
          <div className="actions">
            <button className="btn sec" autoFocus onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setConfirmOpen(false)
                void save({ ...data.settings, open: true })
              }}
            >
              Open to everyone
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}
