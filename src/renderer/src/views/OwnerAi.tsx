import { useEffect, useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ArrowDown, ArrowUp, Check, Plus, RefreshCw, Search, Trash2, UserCheck, UserX } from 'lucide-react'
import { groupCall, gid } from '../data/groups'
import { Avatar } from '../components/account'
import { Bar, Dialog, useToast } from '../components/ui'

/**
 * Settings → Owner → AI: Veyra AI, the owner's Claude key shared with approved people
 * (server/ai.mjs). The month against its total, the settings, the models and their prices,
 * and each person's use, with approving and limits. Amounts are US dollars.
 */

type Settings = { cap: number; breaker: number; scaling: boolean; downgrade: boolean; downgradeAt: number; maxChars: number; fiveHour: number | null; week: number | null }
type Model = { id: string; label: string; enabled: boolean; input: number; output: number; cacheWrite: number; cacheRead: number; effort: string | null; maxTokens: number }
type Overview = {
  keySet: boolean
  keyError: string | null
  settings: Settings
  month: { spent: number; cap: number; pace: number; boost: number; throttle: number; fairShare: number; approved: number; breaker: boolean; paused: boolean; resetsAt: number; byModel: { model: string; n: number; s: number }[] }
  models: Model[]
  available: { id: string; name: string; price: [number, number] | null }[] | null
}
type Win = { spent: number; limit: number | null; resetsAt: number | null }
type AiUser = {
  username: string
  displayName: string
  photoUrl: string
  owner: boolean
  approved: boolean
  base: { fiveHour: number | null; week: number | null; month: number | null }
  heavy: boolean
  windows: { '5h': Win; week: Win; month: Win }
  last30: number
  requests30: number
}

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`)
const err = (e: unknown) => (e instanceof Error ? e.message : 'That didn’t work.')
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']

export function OwnerAiTab() {
  const toast = useToast()
  const [o, setO] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AiUser[] | null>(null)
  const [error, setError] = useState('')
  const load = () => {
    setError('')
    groupCall<Overview>('GET', '/admin/ai').then(setO, (e) => setError(err(e)))
    groupCall<{ users: AiUser[] }>('GET', '/admin/ai/users').then((r) => setUsers(r.users), (e) => setError(err(e)))
  }
  useEffect(load, [])

  const saveSettings = async (patch: Partial<Settings>) => {
    try {
      await groupCall('PUT', '/admin/ai/settings', patch)
      load()
    } catch (e) {
      toast(err(e))
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
  if (!o) return <div className="dim sm owner-loading">Loading…</div>
  const m = o.month
  const state = m.paused ? 'Paused (total reached)' : m.breaker ? `Saving mode (past ${Math.round(o.settings.breaker * 100)}%)` : m.boost > 1.01 ? `Boost ×${m.boost.toFixed(2)}` : m.throttle < 0.99 ? `Heavy users ×${m.throttle.toFixed(2)}` : 'Normal'

  return (
    <>
      {!o.keySet ? (
        <div className="card owner-problem">
          <span className="grow">Veyra AI is off: the server has no Claude API key. Add ANTHROPIC_API_KEY to the server’s .env file and restart it.</span>
        </div>
      ) : o.keyError ? (
        <div className="card owner-problem">
          <span className="grow">{o.keyError}</span>
        </div>
      ) : null}

      <div className="owner-tiles">
        <div className="card owner-tile">
          <span className="owner-tile-label">This month</span>
          <b className="num">
            {usd(m.spent)} <span className="dim sm">of {usd(m.cap)}</span>
          </b>
          <Bar pct={Math.min(100, Math.round((m.spent / Math.max(m.cap, 0.0001)) * 100))} color={m.breaker ? 'var(--bad)' : undefined} />
          <span className="xs dim">Resets {formatDistanceToNowStrict(m.resetsAt, { addSuffix: true })}</span>
        </div>
        <div className="card owner-tile">
          <span className="owner-tile-label">Pace</span>
          <b className="num">{Math.round(m.pace * 100)}%</b>
          <span className="xs dim">{state}</span>
        </div>
        <div className="card owner-tile">
          <span className="owner-tile-label">Approved people</span>
          <b className="num">{m.approved}</b>
          <span className="xs dim">Fair share {usd(m.fairShare)} a week</span>
        </div>
        {m.byModel.map((x) => (
          <div key={x.model} className="card owner-tile">
            <span className="owner-tile-label trunc">{o.models.find((y) => y.id === x.model)?.label ?? x.model}</span>
            <b className="num">{usd(x.s)}</b>
            <span className="xs dim">{x.n === 1 ? '1 request' : `${x.n} requests`} this month</span>
          </div>
        ))}
      </div>

      <h3 className="owner-sub">Settings</h3>
      <SettingsCard s={o.settings} onSave={saveSettings} />

      <h3 className="owner-sub">Models</h3>
      <ModelsCard models={o.models} available={o.available} onSaved={load} />

      <h3 className="owner-sub">People</h3>
      {users ? <UsersCard users={users} defaults={o.settings} onChanged={load} /> : <div className="dim sm owner-loading">Loading…</div>}
      <p className="xs tert" style={{ marginTop: 12 }}>
        Amounts are US dollars, worked out from Anthropic’s token prices set above. Set a spend limit on your Anthropic Console account too, as a backstop.
      </p>
    </>
  )
}

/** A dollar amount, or empty for "no limit". */
function Money({ value, onChange, label, empty = 'No limit' }: { value: number | null; onChange: (v: number | null) => void; label: string; empty?: string }) {
  const [v, setV] = useState(value === null ? '' : String(value))
  useEffect(() => setV(value === null ? '' : String(value)), [value])
  return (
    <label className="oai-money">
      <span>$</span>
      <input
        inputMode="decimal"
        aria-label={label}
        placeholder={empty}
        value={v}
        onChange={(e) => setV(e.target.value.replace(/[^0-9.]/g, ''))}
        onBlur={() => {
          const n = v.trim() === '' ? null : Number(v)
          if (n !== value && (n === null || Number.isFinite(n))) onChange(n)
        }}
      />
    </label>
  )
}

function SettingsCard({ s, onSave }: { s: Settings; onSave: (p: Partial<Settings>) => void }) {
  return (
    <div className="ig oai-settings">
      <div className="ig-row">
        <div className="grow">
          <div className="ig-title">Monthly total</div>
          <div className="ig-sub">Everyone together, each calendar month. At {Math.round(s.breaker * 100)}% everyone moves to the fastest model and a fair share; at 100% it pauses (not for you).</div>
        </div>
        <Money label="Monthly total" value={s.cap} empty="0" onChange={(cap) => onSave({ cap: cap ?? 0 })} />
      </div>
      <div className="ig-row">
        <div className="grow">
          <div className="ig-title">New people start with</div>
          <div className="ig-sub">The 5-hour and weekly limits someone gets when you approve them. You can change each person’s afterwards.</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Money label="5-hour limit for new people" value={s.fiveHour} onChange={(fiveHour) => onSave({ fiveHour })} />
          <Money label="Weekly limit for new people" value={s.week} onChange={(week) => onSave({ week })} />
        </div>
      </div>
      <label className="ig-row tap">
        <div className="grow">
          <div className="ig-title">Scale limits with the month’s pace</div>
          <div className="ig-sub">Quiet month: everyone’s limits rise, up to double. Busy month: people over their fair share shrink, down to half. Changes at most 10% an hour.</div>
        </div>
        <input type="checkbox" checked={s.scaling} onChange={(e) => onSave({ scaling: e.target.checked })} />
      </label>
      <label className="ig-row tap">
        <div className="grow">
          <div className="ig-title">Switch to the fastest model near a limit</div>
          <div className="ig-sub">Once someone has used {Math.round(s.downgradeAt * 100)}% of any limit, their answers come from the cheapest model you’ve switched on.</div>
        </div>
        <input type="checkbox" checked={s.downgrade} onChange={(e) => onSave({ downgrade: e.target.checked })} />
      </label>
      <div className="ig-row">
        <div className="grow">
          <div className="ig-title">Longest request</div>
          <div className="ig-sub">In characters (about 4 per token). Longer notes have to be done a part at a time.</div>
        </div>
        <input className="oai-num" inputMode="numeric" aria-label="Longest request" defaultValue={s.maxChars} key={s.maxChars} onBlur={(e) => Number(e.target.value) !== s.maxChars && onSave({ maxChars: Number(e.target.value) })} />
      </div>
    </div>
  )
}

function ModelsCard({ models, available, onSaved }: { models: Model[]; available: Overview['available']; onSaved: () => void }) {
  const toast = useToast()
  const [list, setList] = useState<Model[]>(models)
  const [adding, setAdding] = useState('')
  useEffect(() => setList(models), [models])
  const dirty = JSON.stringify(list) !== JSON.stringify(models)
  const edit = (i: number, patch: Partial<Model>) => setList((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)))
  const move = (i: number, d: number) => setList((l) => {
    const n = [...l]
    const [x] = n.splice(i, 1)
    n.splice(Math.max(0, Math.min(n.length, i + d)), 0, x)
    return n
  })
  const choices = (available ?? []).filter((a) => !list.some((m) => m.id === a.id))
  const add = () => {
    const a = available?.find((x) => x.id === adding)
    if (!a) return
    const [input, output] = a.price ?? [0, 0]
    setList((l) => [...l, { id: a.id, label: a.name.replace(/^Claude /, ''), enabled: true, input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1, effort: null, maxTokens: 12000 }])
    setAdding('')
  }
  const save = async () => {
    try {
      await groupCall('PUT', '/admin/ai/models', { models: list })
      toast('Models saved')
      onSaved()
    } catch (e) {
      toast(err(e))
    }
  }
  return (
    <div className="ig">
      {list.map((m, i) => (
        <div key={m.id} className="ig-row oai-model">
          <input type="checkbox" checked={m.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} aria-label={`${m.id} switched on`} />
          <div className="grow" style={{ minWidth: 0 }}>
            <input className="oai-label" value={m.label} onChange={(e) => edit(i, { label: e.target.value })} aria-label={`Name people see for ${m.id}`} />
            <div className="ig-sub trunc">{m.id}</div>
          </div>
          <label className="oai-price" title="US dollars per million input tokens">
            in <input inputMode="decimal" value={m.input} onChange={(e) => edit(i, { input: Number(e.target.value) || 0, cacheWrite: (Number(e.target.value) || 0) * 1.25, cacheRead: (Number(e.target.value) || 0) * 0.1 })} />
          </label>
          <label className="oai-price" title="US dollars per million output tokens (thinking counts as output)">
            out <input inputMode="decimal" value={m.output} onChange={(e) => edit(i, { output: Number(e.target.value) || 0 })} />
          </label>
          <select className="oai-effort" value={m.effort ?? ''} onChange={(e) => edit(i, { effort: e.target.value || null })} aria-label={`Effort for ${m.id}`} title="Effort: how hard the model thinks (more effort costs more)">
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x || 'default effort'}
              </option>
            ))}
          </select>
          <button className="iconbtn plain" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp size={14} />
          </button>
          <button className="iconbtn plain" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown size={14} />
          </button>
          <button className="iconbtn plain" aria-label={`Remove ${m.id}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="ig-row">
        {available ? (
          <>
            <select className="grow oai-add" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a model">
              <option value="">Add a model…</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id}){a.price ? ` · $${a.price[0]} / $${a.price[1]}` : ' · set its prices'}
                </option>
              ))}
            </select>
            <button className="btn ghost sm" disabled={!adding} onClick={add}>
              <Plus size={14} /> Add
            </button>
          </>
        ) : (
          <span className="xs dim grow">The list of models shows once the server’s key works.</span>
        )}
        <button className="btn sm" disabled={!dirty} onClick={() => void save()}>
          <Check size={14} /> Save models
        </button>
      </div>
      <div className="ig-row xs dim">The first switched-on model is what people get unless they pick another. Prices are US dollars per million tokens.</div>
    </div>
  )
}

function UsersCard({ users, defaults, onChanged }: { users: AiUser[]; defaults: Settings; onChanged: () => void }) {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<AiUser | null>(null)
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^@/, '')
    return users.filter((u) => !t || u.username.includes(t) || u.displayName.toLowerCase().includes(t))
  }, [users, q])
  const revoke = async (u: AiUser) => {
    try {
      await groupCall('DELETE', `/admin/ai/users/${gid(u.username)}`)
      toast(`@${u.username} can’t use Veyra AI any more`)
      onChanged()
    } catch (e) {
      toast(err(e))
    }
  }
  const cell = (w: Win) => (w.limit === null ? usd(w.spent) : `${usd(w.spent)} / ${usd(w.limit)}`)
  return (
    <>
      <div className="owner-tools">
        <label className="owner-search">
          <Search size={15} className="dim" />
          <input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        </label>
        <span className="xs dim">{users.filter((u) => u.approved).length} approved</span>
      </div>
      <div className="ig">
        {shown.map((u) => (
          <div key={u.username} className="ig-row owner-user">
            <Avatar user={u} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ig-title trunc">
                {u.displayName} <span className="dim">@{u.username}</span>
                {u.owner ? <span className="pill accent" style={{ marginLeft: 6 }}>Owner · no limits</span> : u.approved ? null : <span className="pill" style={{ marginLeft: 6 }}>No access</span>}
                {u.heavy && !u.owner && <span className="pill bad" style={{ marginLeft: 6 }}>Over fair share</span>}
              </div>
              <div className="ig-sub trunc">
                {u.approved || u.owner
                  ? `5 h ${cell(u.windows['5h'])} · week ${cell(u.windows.week)} · month ${cell(u.windows.month)} · ${usd(u.last30)} in 30 days (${u.requests30})`
                  : u.requests30
                    ? `${usd(u.last30)} in 30 days`
                    : 'Hasn’t been given Veyra AI'}
              </div>
            </div>
            {!u.owner && (
              <>
                <button className="btn ghost sm" onClick={() => setEditing(u)}>
                  {u.approved ? 'Limits' : (<><UserCheck size={14} /> Approve</>)}
                </button>
                {u.approved && (
                  <button className="iconbtn plain" aria-label={`Remove @${u.username}’s access`} title="Remove access" onClick={() => void revoke(u)}>
                    <UserX size={15} />
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {!shown.length && <div className="ig-row dim sm">No one matches. People show here once they’ve used Group work or sync.</div>}
      </div>
      {editing && <LimitsDialog user={editing} defaults={defaults} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), onChanged())} />}
    </>
  )
}

function LimitsDialog({ user, defaults, onClose, onSaved }: { user: AiUser; defaults: Settings; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [v, setV] = useState(user.approved ? user.base : { fiveHour: defaults.fiveHour, week: defaults.week, month: null as number | null })
  const save = async () => {
    try {
      await groupCall('PUT', `/admin/ai/users/${gid(user.username)}`, v)
      toast(user.approved ? 'Limits saved' : `@${user.username} can use Veyra AI`)
      onSaved()
    } catch (e) {
      toast(err(e))
    }
  }
  return (
    <Dialog title={user.approved ? `Limits for @${user.username}` : `Give @${user.username} Veyra AI?`} onClose={onClose}>
      <p className="dim" style={{ marginTop: 0 }}>
        US dollars. Each limit counts from their first request in it and resets after the 5 hours, 7 days or 30 days. Leave one empty for no limit. Scaling can raise or lower the 5-hour and weekly ones with the month’s pace.
      </p>
      <div className="oai-limits">
        <label>
          5 hours <Money label="5-hour limit" value={v.fiveHour} onChange={(fiveHour) => setV({ ...v, fiveHour })} />
        </label>
        <label>
          Week <Money label="Weekly limit" value={v.week} onChange={(week) => setV({ ...v, week })} />
        </label>
        <label>
          Month <Money label="Monthly limit" value={v.month} onChange={(month) => setV({ ...v, month })} />
        </label>
      </div>
      <div className="actions">
        <button className="btn sec" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={() => void save()}>
          <Check size={15} /> {user.approved ? 'Save' : 'Approve'}
        </button>
      </div>
    </Dialog>
  )
}
