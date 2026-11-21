/**
 * Settings → Software update → Build from commits (Veyra Study Dev on Windows).
 *
 * Choose a commit, branch or pull request to build as is, or tick several commits to
 * cherry-pick onto a base. The app shows what that will include, then runs
 * `node tools/release.mjs --dev …` in your checkout and streams its log here
 * (src/main/dev-builder.ts). The new build then appears in the Dev builds list above.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderOpen, GitBranch, GitCommitHorizontal, GitPullRequest, Hammer, RefreshCw, Search, Square, X } from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import type { DevBuildRequest, DevBuilderState, DevCandidates, DevPreview } from '@shared/dev-builder'
import { Select as Dropdown } from '../components/Select'

type Tab = 'commits' | 'branches' | 'prs'
type How = 'as-is' | 'pick'
type Target = { ref: string; title: string; label?: string }

const MAX_ROWS = 150

export function DevBuilderSection({ onBuilt }: { onBuilt: () => void }) {
  const api = window.veyra.devBuilder
  const [st, setSt] = useState<DevBuilderState | null>(null)
  const [cands, setCands] = useState<DevCandidates | null>(null)
  const [candErr, setCandErr] = useState('')
  const [loading, setLoading] = useState(false)

  const [how, setHow] = useState<How>('as-is')
  const [tab, setTab] = useState<Tab>('commits')
  const [filter, setFilter] = useState('')
  const [target, setTarget] = useState<Target | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [label, setLabel] = useState('')
  const [android, setAndroid] = useState(true)
  const [web, setWeb] = useState(false)

  const [preview, setPreview] = useState<DevPreview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [startErr, setStartErr] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const jobId = useRef<string | null>(null)
  const lastStatus = useRef<string | null>(null)

  const load = (fetch = false) => {
    if (!api) return
    setLoading(true)
    setCandErr('')
    void api
      .candidates(fetch)
      .then((c) => {
        setCands(c)
        setBase((b) => b || c.defaultBase)
      })
      .catch((e) => setCandErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Couldn’t read the checkout.'))
      .finally(() => setLoading(false))
  }

  // Follow the builder's state and log; reload the Dev builds list when a build finishes.
  useEffect(() => {
    if (!api) return
    const apply = (s: DevBuilderState) => {
      setSt(s)
      const id = s.job?.id ?? null
      if (id !== jobId.current) {
        jobId.current = id
        setLog(s.job?.log ?? [])
      }
      const status = s.job?.status ?? null
      if (status === 'done' && lastStatus.current && lastStatus.current !== 'done') onBuilt()
      lastStatus.current = status
    }
    void api.state().then((s) => {
      apply(s)
      if (s.available && s.repoOk) load()
    })
    const offState = api.onState(apply)
    const offLog = api.onLog((e) => {
      if (e.id === jobId.current) setLog((l) => [...l, ...e.lines].slice(-4000))
    })
    return () => {
      offState()
      offLog()
    }
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, showLog])

  const req: DevBuildRequest | null = useMemo(() => {
    if (how === 'pick') {
      if (!picked.length || !cands) return null
      const order = new Map(cands.commits.map((c, i) => [c.full, i]))
      const commits = [...picked].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0)) // oldest first
      return { mode: 'commits', commits, base: base || cands.defaultBase }
    }
    return target ? { mode: 'ref', ref: target.ref } : null
  }, [how, picked, base, target, cands])
  const reqKey = JSON.stringify(req)

  // What the selection will build, shown before anything runs.
  useEffect(() => {
    setConfirming(false)
    setPreview(null)
    setPreviewErr('')
    if (!req || !api) return
    let live = true
    const t = setTimeout(() => {
      void api
        .preview(req)
        .then((p) => live && setPreview(p))
        .catch((e) => live && setPreviewErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Couldn’t preview that.'))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [reqKey])

  if (!api || !st || !st.available) return null

  const job = st.job
  const running = job?.status === 'running' || job?.status === 'cancelling'
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const commits = (cands?.commits ?? []).filter((c) => hit(`${c.sha} ${c.subject} ${c.deco} ${c.author}`))
  const branches = (cands?.branches ?? []).filter((b) => hit(`${b.name} ${b.sha} ${b.subject}`))
  const prs = (cands?.prs ?? []).filter((p) => hit(`#${p.number} ${p.title} ${p.headRefName}`))
  const activeTab: Tab = how === 'pick' ? 'commits' : tab

  const start = () => {
    if (!req) return
    setStartErr('')
    setConfirming(false)
    void api
      .start({ ...req, label: label.trim() || target?.label || '', windowsOnly: !android, web })
      .then((s) => {
        setShowLog(true)
        setSt(s)
      })
      .catch((e) => setStartErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Couldn’t start the build.'))
  }

  const toggle = (full: string) => setPicked((p) => (p.includes(full) ? p.filter((x) => x !== full) : [...p, full]))
  const when = (iso?: string) => (iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : '')
  const elapsed = job ? Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000) : 0
  const baseOptions = (() => {
    const names = (cands?.branches ?? []).map((b) => b.name)
    if (cands?.defaultBase && !names.includes(cands.defaultBase)) names.unshift(cands.defaultBase)
    return names.map((n) => ({ value: n, label: n, hint: n === cands?.defaultBase ? 'default' : undefined }))
  })()

  return (
    <div className="set-group">
      <h2>Build from commits</h2>
      <div className="set-card devb">
        <div className="dev-builds-bar">
          <div className="grow row" style={{ gap: 8, minWidth: 0 }}>
            <FolderOpen size={14} className="dim" style={{ flexShrink: 0 }} />
            <span className="sm dim trunc" title={st.repoDir}>
              {st.repoDir}
              {cands?.head ? ` · on ${cands.head}` : ''}
            </span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn ghost sm" disabled={running} onClick={() => void api.chooseRepo().then(setSt).then(() => load()).catch((e) => setCandErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))}>
              Change…
            </button>
            {st.repoOk && (
              <button className="btn ghost sm" disabled={loading || running} onClick={() => load(true)} title="Fetch from GitHub and reload the list">
                <RefreshCw size={13} className={loading ? 'spin' : ''} /> Fetch
              </button>
            )}
          </div>
        </div>

        {!st.repoOk && <div className="dev-builds-msg error">{st.reason}</div>}
        {candErr && <div className="dev-builds-msg error">{candErr}</div>}

        {job && (
          <div className={`devb-job ${job.status}`}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`pill ${job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : 'accent'}`}>
                {job.status === 'running' ? 'Building' : job.status === 'cancelling' ? 'Stopping' : job.status === 'done' ? 'Published' : job.status === 'failed' ? 'Failed' : 'Stopped'}
              </span>
              <span className="grow trunc sm" title={job.summary}>
                {job.summary}
              </span>
              <span className="xs dim num">{elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}</span>
              <button className="btn ghost sm" onClick={() => setShowLog((v) => !v)}>
                {showLog ? 'Hide log' : 'Show log'}
              </button>
              {running ? (
                <button className="btn ghost sm" disabled={job.status === 'cancelling'} onClick={() => void api.cancel().then(setSt)}>
                  <Square size={12} /> Stop
                </button>
              ) : (
                <button className="btn ghost sm" aria-label="Dismiss" onClick={() => void api.clear().then(setSt)}>
                  <X size={13} />
                </button>
              )}
            </div>
            {job.error && <div className="xs devb-err">{job.error}</div>}
            {job.status === 'done' && <div className="xs dim">It’s in the Dev builds list above. Installed Dev apps pick it up on their own.</div>}
            {showLog && (
              <pre className="devb-log" ref={logRef}>
                {log.join('\n') || 'Starting…'}
              </pre>
            )}
          </div>
        )}

        {st.repoOk && cands && (
          <fieldset className="devb-pick" disabled={running}>
            <div className="devb-controls">
              <div className="seg" role="radiogroup" aria-label="How to build">
                <button role="radio" aria-checked={how === 'as-is'} aria-selected={how === 'as-is'} onClick={() => setHow('as-is')}>
                  Build one as is
                </button>
                <button role="radio" aria-checked={how === 'pick'} aria-selected={how === 'pick'} onClick={() => setHow('pick')}>
                  Cherry-pick commits
                </button>
              </div>
              {how === 'as-is' && (
                <div className="seg" role="tablist" aria-label="What to build">
                  <button role="tab" aria-selected={tab === 'commits'} onClick={() => setTab('commits')}>
                    <GitCommitHorizontal size={13} /> Commits
                  </button>
                  <button role="tab" aria-selected={tab === 'branches'} onClick={() => setTab('branches')}>
                    <GitBranch size={13} /> Branches
                  </button>
                  <button role="tab" aria-selected={tab === 'prs'} onClick={() => setTab('prs')}>
                    <GitPullRequest size={13} /> PRs{cands.prs.length ? ` ${cands.prs.length}` : ''}
                  </button>
                </div>
              )}
            </div>

            <div className="devb-search">
              <Search size={14} className="dim" />
              <input className="set-input" placeholder={activeTab === 'commits' ? 'Search commits by message, SHA or branch' : activeTab === 'prs' ? 'Search pull requests' : 'Search branches'} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search" />
              {how === 'pick' && picked.length > 0 && (
                <button className="btn ghost sm" onClick={() => setPicked([])}>
                  Clear {picked.length}
                </button>
              )}
            </div>

            <div className="devb-list" role="listbox" aria-multiselectable={how === 'pick'}>
              {activeTab === 'commits' &&
                commits.slice(0, MAX_ROWS).map((c) => {
                  const on = how === 'pick' ? picked.includes(c.full) : target?.ref === c.full
                  return (
                    <button
                      key={c.full}
                      role="option"
                      aria-selected={on}
                      className={`devb-row ${on ? 'on' : ''}`}
                      onClick={() => (how === 'pick' ? toggle(c.full) : setTarget({ ref: c.full, title: `${c.sha} ${c.subject}` }))}
                    >
                      <span className={`devb-check ${how === 'pick' ? 'box' : 'dot'}`}>{on && <Check size={11} strokeWidth={3} />}</span>
                      <code className="dev-sha">{c.sha}</code>
                      <span className="grow trunc devb-subj" title={c.subject}>
                        {c.subject}
                      </span>
                      {c.deco && (
                        <span className="pill trunc devb-deco" title={c.deco}>
                          {c.deco.replace(/^HEAD -> /, '')}
                        </span>
                      )}
                      <span className="xs tert devb-when">{c.rel}</span>
                    </button>
                  )
                })}
              {activeTab === 'branches' &&
                branches.map((b) => {
                  const on = target?.ref === b.name
                  return (
                    <button key={b.name} role="option" aria-selected={on} className={`devb-row ${on ? 'on' : ''}`} onClick={() => setTarget({ ref: b.name, title: b.name })}>
                      <span className="devb-check dot">{on && <Check size={11} strokeWidth={3} />}</span>
                      <span className="devb-branch trunc">{b.name}</span>
                      <span className="grow trunc xs dim" title={b.subject}>
                        {b.subject}
                      </span>
                      <span className="xs tert devb-when">{b.rel}</span>
                    </button>
                  )
                })}
              {activeTab === 'prs' &&
                prs.map((p) => {
                  const on = target?.ref === `pr#${p.number}`
                  return (
                    <button
                      key={p.number}
                      role="option"
                      aria-selected={on}
                      className={`devb-row ${on ? 'on' : ''}`}
                      onClick={() => setTarget({ ref: `pr#${p.number}`, title: `#${p.number} ${p.title}`, label: `PR #${p.number}: ${p.title}` })}
                    >
                      <span className="devb-check dot">{on && <Check size={11} strokeWidth={3} />}</span>
                      <span className="dev-sha">#{p.number}</span>
                      <span className="grow trunc devb-subj">{p.title}</span>
                      <span className="pill trunc devb-deco">{p.headRefName}</span>
                      <span className="xs tert devb-when">{when(p.updatedAt)}</span>
                    </button>
                  )
                })}
              {((activeTab === 'commits' && !commits.length) || (activeTab === 'branches' && !branches.length) || (activeTab === 'prs' && !prs.length)) && (
                <div className="dev-builds-msg dim">{filter ? 'Nothing matches.' : activeTab === 'prs' ? cands.prError || 'No open pull requests.' : 'Nothing here.'}</div>
              )}
              {activeTab === 'commits' && commits.length > MAX_ROWS && <div className="dev-builds-msg xs tert">Showing {MAX_ROWS} of {commits.length}. Search to narrow it down.</div>}
            </div>

            {how === 'pick' && (
              <div className="devb-opt">
                <span className="sm">Apply onto</span>
                <Dropdown className="set-sel" label="Base to cherry-pick onto" value={base || cands.defaultBase} options={baseOptions} onChange={setBase} />
              </div>
            )}

            {req && (
              <div className="devb-preview">
                {previewErr ? (
                  <div className="xs devb-err">{previewErr}</div>
                ) : !preview ? (
                  <div className="xs dim">Working out what this includes…</div>
                ) : (
                  <>
                    <div className="sm devb-ptitle">{preview.kind === 'commits' ? `Cherry-pick ${preview.title}` : `Build ${preview.title}`}</div>
                    <div className="xs dim">
                      {preview.note ??
                        (preview.kind === 'ref'
                          ? preview.aheadCount
                            ? `${preview.aheadCount} commit${preview.aheadCount === 1 ? '' : 's'} not on ${preview.base}${preview.shortstat ? ` · ${preview.shortstat}` : ''}`
                            : `Nothing beyond ${preview.base}.`
                          : 'Applied oldest first, in a temporary copy of the checkout.')}
                    </div>
                    {preview.commits.length > 0 && (
                      <ul className="devb-plist">
                        {preview.commits.slice(0, 12).map((c) => (
                          <li key={c.sha} className="xs">
                            <code>{c.sha}</code> {c.subject}
                            {c.stat && <span className="tert"> · {c.stat}</span>}
                          </li>
                        ))}
                        {preview.commits.length > 12 && <li className="xs tert">… and {preview.commits.length - 12} more</li>}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="devb-opt">
              <input className="set-input grow" placeholder={target?.label || 'Label for the build switcher (optional)'} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-label="Build label" />
            </div>
            <div className="devb-opt devb-checks">
              <label className="row sm" style={{ gap: 6 }}>
                <input type="checkbox" checked={android} onChange={(e) => setAndroid(e.target.checked)} /> Android APK too
              </label>
              <label className="row sm" style={{ gap: 6 }}>
                <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Also deploy the Dev website
              </label>
              <span className="grow" />
              {confirming ? (
                <>
                  <span className="xs dim">Publish to the Dev feed?</span>
                  <button className="btn ghost sm" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button className="btn sm" onClick={start}>
                    <Hammer size={13} /> Build &amp; publish
                  </button>
                </>
              ) : (
                <button className="btn sm" disabled={!req || running || !!previewErr} onClick={() => setConfirming(true)}>
                  <Hammer size={13} /> Build…
                </button>
              )}
            </div>
            {startErr && <div className="dev-builds-msg error">{startErr}</div>}
          </fieldset>
        )}
      </div>
      <p className="set-footer">
        Runs npm run release:dev in your checkout, in a temporary copy so your work in progress is never touched, using this computer’s GitHub sign-in. Builds take a few minutes; you can keep using the app meanwhile.
      </p>
    </div>
  )
}
