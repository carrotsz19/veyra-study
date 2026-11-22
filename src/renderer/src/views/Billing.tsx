import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, CreditCard, ExternalLink, FlaskConical, Lock, Moon, RefreshCw, ShieldAlert, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { groupCall } from '../data/groups'
import { useAccount } from '../components/account'
import { useToast } from '../components/ui'

/**
 * Settings → Plan & billing. Locked like the Veyra AI tab: until the owner opens plans to everyone
 * (Owner → Plans), only the owner sees them; everyone else sees "Coming soon". Payment happens on
 * Stripe's own pages in the browser (Checkout, and the customer portal to change or cancel); the
 * app never handles card details or Stripe keys. The server asks Stripe for the result.
 */

type Plan = { id: string; name: string; blurb: string; price: string; hasAi: boolean; available?: boolean }
type Current = { planId: string; planName: string; status: string; active: boolean; periodEnd: number | null; cancelAtEnd: boolean } | null
type Status = { open: boolean; owner: boolean; configured: boolean; mode?: 'off' | 'test' | 'live'; plans: Plan[]; current: Current }
type Tier = 'plus' | 'pro' | 'max' | 'default'

const STATUS: Record<string, { label: string; tone: 'ok' | 'accent' | 'bad' | 'neutral' }> = {
  active: { label: 'Active', tone: 'ok' },
  trialing: { label: 'Free trial', tone: 'accent' },
  past_due: { label: 'Payment failed: retrying', tone: 'bad' },
  canceled: { label: 'Ended', tone: 'neutral' },
  unpaid: { label: 'Unpaid', tone: 'bad' },
  incomplete: { label: 'Waiting for payment', tone: 'neutral' },
  incomplete_expired: { label: 'Payment didn’t go through', tone: 'bad' },
  paused: { label: 'Paused', tone: 'neutral' }
}
const day = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })

function planTier(p: Plan): Tier {
  const hay = `${p.id} ${p.name}`.toLowerCase()
  if (/\bmax\b/.test(hay)) return 'max'
  if (/\bpro\b/.test(hay)) return 'pro'
  if (/\bplus\b/.test(hay)) return 'plus'
  return 'default'
}

/** Splits a display price like "S$6.90 a month" or "$12 / mo" into amount + cadence. */
function splitPrice(price: string): { amount: string; cadence: string } {
  const raw = price.trim()
  const m = raw.match(/^(.+?)(?:(\s+(?:a|per)\s+\S+(?:\s+\S+)?)|(\s*\/\s*\S+))$/i)
  if (!m) return { amount: raw, cadence: '' }
  return { amount: m[1].trim(), cadence: (m[2] ?? m[3] ?? '').trim() }
}

/**
 * Turns a plan's description into clean summary text, checkable highlights, and any overnight
 * availability note. Supports both single-paragraph blurbs and multi-line bulleted lists.
 */
function parseBlurb(blurb: string, hasAi: boolean): { summary: string; points: string[]; note: string } {
  const raw = blurb.trim()
  if (!raw) return { summary: '', points: hasAi ? ['Built-in Veyra AI included'] : [], note: '' }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length > 1) {
    let summary = ''
    const points: string[] = []
    let note = ''
    for (const line of lines) {
      const cleaned = line.replace(/^[-•*✓✔]\s*/, '').trim()
      if (!cleaned) continue
      if (/\bunavailable from\b/i.test(cleaned)) {
        note = cleaned
      } else if (!summary && !/^[-•*✓✔]\s*/.test(line)) {
        summary = cleaned
      } else {
        points.push(cleaned)
      }
    }
    return { summary, points, note }
  }

  let text = raw
  let note = ''
  const points: string[] = []

  // Separate an overnight availability caveat so it reads cleanly instead of burying the features.
  const hoursRe = /\s*([^.!?]*\bunavailable from\b[^.!?]*[.!?]?)/i
  const hm = text.match(hoursRe)
  if (hm) {
    note = hm[1].trim().replace(/\.$/, '')
    text = text.replace(hoursRe, ' ').replace(/\s{2,}/g, ' ').trim()
  }

  // Pull a trailing "Cancel anytime." into a clean check row.
  const cancelRe = /\s*\bcancel\s+any\s*time[.!]?\s*$/i
  if (cancelRe.test(text)) {
    text = text.replace(cancelRe, '').trim()
    points.push('Cancel anytime')
  }

  if (hasAi && !/veyra\s*ai/i.test(raw)) {
    points.unshift('Includes built-in Veyra AI')
  }

  return { summary: text, points, note }
}

/** Small geometric tier mark inspired by Veyra's Plus / Pro / Max badges. */
function TierMark({ tier }: { tier: Tier }) {
  if (tier === 'plus') {
    return (
      <span className="billing-tier-icon tier-plus" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (tier === 'pro') {
    return (
      <span className="billing-tier-icon tier-pro" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5c.6 3.5 2 4.9 5.5 5.5-3.5.6-4.9 2-5.5 5.5-.6-3.5-2-4.9-5.5-5.5 3.5-.6 4.9-2 5.5-5.5Z" />
        </svg>
      </span>
    )
  }
  if (tier === 'max') {
    return (
      <span className="billing-tier-icon tier-max" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.6 3.2c.5 3 1.7 4.2 4.7 4.7-3 .5-4.2 1.7-4.7 4.7-.5-3-1.7-4.2-4.7-4.7 3-.5 4.2-1.7 4.7-4.7Z" />
          <path d="M12.3 1.3c.25 1.35.8 1.9 2.15 2.15-1.35.25-1.9.8-2.15 2.15-.25-1.35-.8-1.9-2.15-2.15 1.35-.25 1.9-.8 2.15-2.15Z" opacity="0.82" />
        </svg>
      </span>
    )
  }
  return (
    <span className="billing-tier-icon tier-default" aria-hidden="true">
      <CreditCard size={15} />
    </span>
  )
}

export function Billing({ onOpenOwnerPlans }: { onOpenOwnerPlans?: () => void }) {
  const toast = useToast()
  const signedIn = useAccount().state.mode === 'account'
  const [st, setSt] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [waiting, setWaiting] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    setError('')
    try {
      const s = await groupCall<Status>('GET', '/billing')
      // Ask Stripe for the latest once it's open (after checkout, a cancellation in the portal…).
      if (s.open && refresh) s.current = (await groupCall<{ current: Current }>('POST', '/billing/refresh').catch(() => ({ current: s.current }))).current
      setSt(s)
    } catch (e) {
      setError(e instanceof Error && !/not found/i.test(e.message) ? e.message : 'Plans need a newer group server.')
    }
  }, [])
  useEffect(() => {
    if (signedIn) void load(true)
  }, [signedIn, load])
  // Back from Stripe in the browser: see what happened.
  useEffect(() => {
    if (!waiting) return
    const back = () => {
      setWaiting(false)
      void load(true)
    }
    window.addEventListener('focus', back)
    return () => window.removeEventListener('focus', back)
  }, [waiting, load])

  const go = async (what: 'checkout' | 'portal', planId?: string) => {
    setBusy(planId ?? what)
    try {
      const r = await groupCall<{ url: string }>('POST', `/billing/${what}`, planId ? { planId } : {})
      setWaiting(true)
      void window.veyra.open(r.url)
      toast(what === 'checkout' ? 'Finish in your browser, then come back here.' : 'Opened billing in your browser.')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work. Try again.')
    } finally {
      setBusy('')
    }
  }

  if (!signedIn) {
    return (
      <div className="billing-page">
        <div className="card billing-empty">
          <div className="billing-empty-icon">
            <CreditCard size={20} />
          </div>
          <div>
            <b>Sign in to view plans</b>
            <p className="dim sm">Sign in to your Veyra account to see available plans and manage billing.</p>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="billing-page">
        <div className="card owner-problem">
          <span className="grow">{error}</span>
          <button className="btn sec sm" onClick={() => void load(true)}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      </div>
    )
  }

  if (!st) {
    return (
      <div className="billing-page" aria-busy="true" aria-label="Loading plans">
        <div className="billing-plans">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card billing-plan billing-skel">
              <div className="skel-line w-45" />
              <div className="skel-line lg w-60" />
              <div className="skel-line w-100" />
              <div className="skel-line w-80" />
              <div className="skel-btn" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!st.open) return <ComingSoon />

  const cur = st.current
  const curStatus = cur ? (STATUS[cur.status] ?? { label: cur.status, tone: 'neutral' as const }) : null
  const hasMultiple = st.plans.length >= 3
  const featuredId = !cur?.active && hasMultiple ? st.plans.find((p) => planTier(p) === 'pro')?.id : undefined

  const modeMeta = !st.configured
    ? {
        tone: 'warn' as const,
        icon: AlertTriangle,
        badge: 'Not configured',
        title: 'Owner preview',
        body: 'Only you can see this. Add STRIPE_SECRET_KEY on the group server to enable checkout.'
      }
    : st.mode === 'live'
      ? {
          tone: 'live' as const,
          icon: ShieldAlert,
          badge: 'Live mode',
          title: 'Owner preview',
          body: 'Hidden from everyone else until you open plans in Owner → Plans. Stripe is live: checkout charges a real card.'
        }
      : {
          tone: 'test' as const,
          icon: FlaskConical,
          badge: 'Test mode',
          title: 'Owner preview',
          body: 'Hidden from everyone else until you open plans in Owner → Plans. Use a Stripe test card such as 4242 4242 4242 4242.'
        }
  const ModeIcon = modeMeta.icon

  return (
    <div className="billing-page">
      {st.owner && (
        <div className={`card billing-mode tone-${modeMeta.tone}`}>
          <span className="billing-mode-icon" aria-hidden="true">
            <ModeIcon size={16} />
          </span>
          <div className="billing-mode-copy">
            <div className="billing-mode-head">
              <b>{modeMeta.title}</b>
              <span className={`pill ${modeMeta.tone === 'live' ? 'bad' : modeMeta.tone === 'test' ? 'accent' : ''}`}>{modeMeta.badge}</span>
            </div>
            <p>{modeMeta.body}</p>
          </div>
          {onOpenOwnerPlans && (
            <button className="btn ghost sm billing-mode-act" onClick={onOpenOwnerPlans}>
              <SlidersHorizontal size={13} /> Owner → Plans
            </button>
          )}
        </div>
      )}

      {cur && curStatus && (
        <div className="card billing-current">
          <TierMark tier={planTier({ id: cur.planId, name: cur.planName, blurb: '', price: '', hasAi: false })} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="billing-current-title">
              <b>{cur.planName}</b>
              <span className={`pill ${curStatus.tone === 'neutral' ? '' : curStatus.tone}`}>{curStatus.label}</span>
            </div>
            {cur.periodEnd && cur.active && <div className="ig-sub">{cur.cancelAtEnd ? `Ends on ${day(cur.periodEnd)}` : `Renews on ${day(cur.periodEnd)}`}</div>}
          </div>
          <button className="btn sec sm" disabled={!!busy} onClick={() => void go('portal')}>
            <ExternalLink size={14} /> Manage billing
          </button>
        </div>
      )}

      {st.plans.length === 0 ? (
        <div className="card billing-empty">
          <div className="billing-empty-icon">
            <CreditCard size={20} />
          </div>
          <div className="grow">
            <b>No plans set up yet</b>
            <p className="dim sm">{st.owner ? 'Add your plans in Owner → Plans to preview them here.' : 'Paid plans will appear here once they’re ready.'}</p>
          </div>
          {st.owner && onOpenOwnerPlans && (
            <button className="btn sm" onClick={onOpenOwnerPlans}>
              Owner → Plans
            </button>
          )}
        </div>
      ) : (
        <div className={`billing-plans count-${Math.min(st.plans.length, 3)}`}>
          {st.plans.map((p) => {
            const tier = planTier(p)
            const mine = Boolean(cur?.active && cur.planId === p.id)
            const available = p.available !== false
            const featured = Boolean(featuredId && p.id === featuredId)
            const price = splitPrice(p.price)
            const { summary, points, note } = parseBlurb(p.blurb, p.hasAi)

            return (
              <article
                key={p.id}
                className={`card billing-plan tier-${tier} ${mine ? 'mine' : ''} ${featured && available ? 'featured' : ''} ${!mine && !available ? 'unavailable' : ''}`}
              >
                <div className="billing-plan-head">
                  <div className="billing-plan-id">
                    <TierMark tier={tier} />
                    <h3 className="billing-plan-name">{p.name}</h3>
                  </div>
                  {mine ? (
                    <span className="pill ok billing-badge">
                      <Check size={11} strokeWidth={3} /> Your plan
                    </span>
                  ) : !available ? (
                    <span className="pill billing-badge muted">Unavailable</span>
                  ) : featured ? (
                    <span className="pill accent billing-badge">Popular</span>
                  ) : null}
                </div>

                {p.price && (
                  <div className="billing-plan-price">
                    <span className="billing-price-amt num">{price.amount}</span>
                    {price.cadence && <span className="billing-price-per">{price.cadence}</span>}
                  </div>
                )}

                <div className="billing-plan-sep" aria-hidden="true" />

                <div className="billing-plan-body">
                  {summary && <p className="billing-plan-summary">{summary}</p>}
                  {points.length > 0 && (
                    <ul className="billing-plan-points">
                      {points.map((pt, i) => (
                        <li key={i}>
                          <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                          <span>{pt}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {note && (
                    <div className="billing-plan-note">
                      <Moon size={12} aria-hidden="true" />
                      <span>{note}</span>
                    </div>
                  )}
                </div>

                <div className="billing-plan-foot">
                  {mine ? (
                    <button className="btn sec billing-cta" disabled={!!busy} onClick={() => void go('portal')}>
                      <ExternalLink size={14} /> Manage plan
                    </button>
                  ) : !available ? (
                    <button className="btn sec billing-cta is-unavail" disabled>
                      Product unavailable
                    </button>
                  ) : cur?.active ? (
                    <button className="btn ghost billing-cta" disabled={!!busy || !st.configured} onClick={() => void go('portal')}>
                      <ExternalLink size={14} /> Switch in Manage billing
                    </button>
                  ) : (
                    <button
                      className={`btn ${featured || st.plans.length === 1 ? '' : 'billing-cta-alt'} billing-cta`}
                      disabled={!!busy || !st.configured}
                      onClick={() => void go('checkout', p.id)}
                    >
                      {busy === p.id ? 'Opening Stripe…' : `Get ${p.name}`}
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {waiting && (
        <div className="card billing-waiting">
          <RefreshCw size={14} className="spin" aria-hidden="true" />
          <span className="grow">Waiting for you to finish in your browser…</span>
          <button
            className="btn ghost sm"
            onClick={() => {
              setWaiting(false)
              void load(true)
            }}
          >
            Refresh now
          </button>
        </div>
      )}

      <div className="billing-footer">
        <ShieldCheck size={15} className="billing-footer-icon" aria-hidden="true" />
        <p>
          Payments are handled securely by Stripe in your browser — Veyra Study never sees your card details. Core study tools stay free, and you can change or cancel any time in Manage billing.
        </p>
      </div>
    </div>
  )
}

function ComingSoon() {
  return (
    <div className="ai-soon" style={{ marginTop: 32 }}>
      <div className="ai-soon-icon">
        <CreditCard size={26} />
        <span className="ai-soon-lock">
          <Lock size={13} />
        </span>
      </div>
      <h2>Plans Coming Soon!</h2>
      <p className="ai-soon-sub">Stay Tuned!</p>
      <p className="dim">Paid plans with more Veyra AI are on the way. Everything you use today stays free.</p>
    </div>
  )
}
