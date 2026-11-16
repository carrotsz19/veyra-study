import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Bot, Users, Check, ChevronDown, ChevronRight, CircleDashed, Copy, ExternalLink, FilePlus2, FileText, Globe, HardDrive, Image as ImageIcon, ListChecks, Loader2, MessageSquarePlus, Paperclip, Square, Undo2, X, XCircle, Zap } from 'lucide-react'
import { DRIVE_KEY, loadChat, MAX_FILES, prepareFile, saveChat, startAgent, SUBAGENTS_KEY, TURBO_KEY, WEB_KEY, type AgentChange, type AgentEvent, type AgentFile, type AgentRun, type ChatTurn, type NoteContext, type ToolAsk } from '../../data/agent'
import { useDrive } from '../../data/drive'
import { setAiState, useAiState, useVeyraAi } from '../../data/veyra-ai'
import { useNav } from '../../nav'
import { useToast } from '../ui'
import { Select } from '../Select'

/**
 * The Assistant: a chat beside the note with Veyra AI as an agent. It plans, researches the web
 * (with sources), sends subagents to research in parallel, and reads and changes notes and
 * tasks, asking first (or not, with Turbo). Chats are kept on this device, one per note.
 *
 * Files (pictures, PDFs, text) can be attached, pasted or dropped in: they stay with the chat
 * and go with each message until removed (only their names are saved). On the computer, with
 * Google Drive allowed in Settings → Connections, it can also search and read Drive and make Docs.
 */

type Step = { key: string; label: string; state: 'running' | 'done' | 'error'; icon: 'web' | 'note' | 'sub' | 'task' }
type Pending = ToolAsk & { key: string; resolve: (ok: boolean) => void }
interface Live {
  text: string
  steps: Step[]
  plan: Extract<AgentEvent, { t: 'plan' }>['items'] | null
  sources: { url: string; title: string }[]
  changes: AgentChange[]
  pending: Pending[]
  thinking: boolean
  model: string
  note: string
}
const fresh = (): Live => ({ text: '', steps: [], plan: null, sources: [], changes: [], pending: [], thinking: true, model: '', note: '' })

const SUGGESTIONS = ['Research this topic and add a summary to the note', 'Make a 10-question quiz from this note', 'What’s missing from this note? Check it against good sources', 'Plan my revision for this subject as tasks']

const readFlag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const writeFlag = (key: string, on: boolean) => {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}
const readTurbo = () => readFlag(TURBO_KEY, false)

export function AgentPanel({ note, onClose, onInsert }: { note: NoteContext; onClose: () => void; onInsert: (markdown: string) => void }) {
  const toast = useToast()
  const { go } = useNav()
  const { status, error: statusError, reload } = useVeyraAi()
  const ai = useAiState()
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadChat(note.id))
  const [live, setLive] = useState<Live | null>(null)
  const [input, setInput] = useState('')
  const [turbo, setTurbo] = useState(readTurbo)
  const [allowChat, setAllowChat] = useState(false)
  const [web, setWeb] = useState(() => readFlag(WEB_KEY, true))
  const [subagents, setSubagents] = useState(() => readFlag(SUBAGENTS_KEY, true))
  const [driveOn, setDriveOn] = useState(() => readFlag(DRIVE_KEY, true))
  const { state: drive } = useDrive()
  const [files, setFiles] = useState<AgentFile[]>([])
  const [reading, setReading] = useState(0)
  const [dropping, setDropping] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  // Files already shown on an earlier message of this chat (each shows once, where it was added).
  const shown = useRef(new Set<string>())
  const run = useRef<AgentRun | null>(null)
  const liveRef = useRef<Live | null>(null)
  const turboRef = useRef(turbo)
  const allowRef = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  turboRef.current = turbo
  allowRef.current = allowChat

  useEffect(() => saveChat(note.id, turns), [note.id, turns])
  useEffect(() => () => run.current?.stop(), [])
  useEffect(() => {
    const el = scroller.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [turns, live])

  const update = (f: (l: Live) => Live) => {
    if (!liveRef.current) return
    liveRef.current = f(liveRef.current)
    setLive(liveRef.current)
  }
  const step = (key: string, label: string, icon: Step['icon'], state: Step['state'] = 'done') =>
    update((l) => {
      const i = l.steps.findIndex((s) => s.key === key)
      const steps = i >= 0 ? l.steps.map((s, j) => (j === i ? { ...s, label, state } : s)) : [...l.steps, { key, label, state, icon }]
      return { ...l, steps }
    })

  const finish = (end: { error?: string; note?: string }) => {
    const l = liveRef.current
    if (!l) return
    for (const p of l.pending) p.resolve(false)
    const turn: ChatTurn = {
      role: 'assistant',
      text: l.text,
      steps: l.steps.map((s) => ({ label: s.label, state: s.state === 'running' ? 'done' : s.state })),
      plan: l.plan ?? undefined,
      sources: l.sources.length ? l.sources : undefined,
      changes: l.changes.length ? l.changes.map((c) => ({ label: c.label })) : undefined,
      error: end.error,
      note: end.note || l.note || undefined
    }
    // Keep the changes (with their Undo) on screen for this session.
    setDone((d) => [...d, ...l.changes])
    liveRef.current = null
    setLive(null)
    run.current = null
    setTurns((t) => [...t, turn])
  }
  const [done, setDone] = useState<AgentChange[]>([])

  /** Gets files ready to send (pictures made smaller), up to MAX_FILES in the chat. */
  const addFiles = async (list: File[]) => {
    if (!list.length) return
    const room = MAX_FILES - files.length
    if (room <= 0) return toast(`Up to ${MAX_FILES} files in a chat. Remove one first.`)
    if (list.length > room) toast(`Only the first ${room} ${room === 1 ? 'file was' : 'files were'} added (up to ${MAX_FILES} in a chat).`)
    setReading((n) => n + 1)
    try {
      for (const f of list.slice(0, room)) {
        try {
          const ready = await prepareFile(f)
          setFiles((cur) => (cur.length >= MAX_FILES || cur.some((x) => x.name === ready.name && x.size === ready.size) ? cur : [...cur, ready]))
        } catch (e) {
          toast(e instanceof Error ? e.message : `Couldn’t read “${f.name}”.`)
        }
      }
    } finally {
      setReading((n) => n - 1)
    }
  }
  const driveReady = !!drive?.assistant
  const useDriveNow = driveReady && driveOn

  const send = (text = input) => {
    const message = text.trim()
    if (!message || live || reading) return
    // Earlier turns go as text; files are named so the Assistant knows what came when.
    const history = turns.filter((t) => t.text).map((t) => ({ role: t.role, text: t.files?.length ? `${t.text}\n[Attached: ${t.files.join(', ')}]` : t.text }))
    const added = files.map((f) => f.name).filter((n) => !shown.current.has(n))
    added.forEach((n) => shown.current.add(n))
    setTurns((t) => [...t, { role: 'user', text: message, ...(added.length ? { files: added } : {}) }])
    setInput('')
    liveRef.current = fresh()
    setLive(liveRef.current)
    run.current = startAgent(
      { message, history, model: ai?.models.veyra, note, web: web && status?.agentWeb !== false, subagents, files, drive: useDriveNow },
      {
        event: (e) => {
          if (e.t === 'model') update((l) => ({ ...l, model: e.label, note: e.downgraded ? `Using ${e.label} to make your Veyra AI limit last longer.` : '' }))
          else if (e.t === 'text' && e.a === 'lead') update((l) => ({ ...l, text: l.text + e.s, thinking: false }))
          else if (e.t === 'think' && e.a === 'lead') update((l) => ({ ...l, thinking: true }))
          else if (e.t === 'tool') step(`${e.a}:${e.name}:${Date.now()}`, e.a === 'lead' ? e.label : `${e.label} (subagent)`, 'web')
          else if (e.t === 'plan') update((l) => ({ ...l, plan: e.items }))
          else if (e.t === 'sub') step(`sub:${e.id}`, `Subagent: ${e.title}${e.state === 'error' && e.note ? ` (${e.note})` : ''}`, 'sub', e.state)
          else if (e.t === 'sources') update((l) => ({ ...l, sources: e.items }))
          else if (e.t === 'end') finish(e)
        },
        tool: (label) => step(`app:${label}:${Date.now()}`, label, 'note'),
        changed: (c) => update((l) => ({ ...l, changes: [...l.changes, c] })),
        approve: (ask) =>
          turboRef.current || allowRef.current
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) => {
                const key = `${Date.now()}:${Math.random()}`
                update((l) => ({
                  ...l,
                  pending: [
                    ...l.pending,
                    {
                      ...ask,
                      key,
                      resolve: (ok) => {
                        update((x) => ({ ...x, pending: x.pending.filter((p) => p.key !== key) }))
                        if (!ok) step(`deny:${key}`, `Declined: ${ask.label}`, 'task', 'error')
                        resolve(ok)
                      }
                    }
                  ]
                }))
              })
      }
    )
  }
  const stop = () => {
    run.current?.stop()
    finish({ error: 'Stopped.' })
  }
  const newChat = () => {
    if (live) return
    setTurns([])
    setDone([])
    setAllowChat(false)
    setFiles([])
    shown.current.clear()
  }
  const flipTurbo = () => {
    const v = !turbo
    setTurbo(v)
    writeFlag(TURBO_KEY, v)
    if (v) liveRef.current?.pending.forEach((p) => p.resolve(true))
    toast(v ? 'Turbo on: the Assistant makes changes without asking. Each one can be undone.' : 'Turbo off: the Assistant asks before each change.')
  }
  const undo = async (c: AgentChange) => {
    if (!c.undo || c.undone) return
    try {
      await c.undo()
      setDone((d) => d.map((x) => (x === c ? { ...x, undone: true } : x)))
      toast('Undone')
    } catch {
      toast('Couldn’t undo that.')
    }
  }

  const blocked = statusError ? statusError : status && !status.approved ? status.blocked : null
  const models = status?.models ?? []
  const model = models.find((m) => m.id === ai?.models.veyra) ?? models[0]

  return (
    <aside
      className={`ai-panel agent-panel ${dropping ? 'agent-drop' : ''}`}
      aria-label="Assistant"
      onDragOver={(e) => {
        if (blocked || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDropping(false)
        void addFiles([...e.dataTransfer.files])
      }}
    >
      <header className="ai-head">
        <span className="ai-badge">
          <Bot size={15} />
        </span>
        <b className="grow">Assistant</b>
        {models.length > 1 && (
          <Select
            className="agent-model"
            label="Model"
            value={model?.id ?? ''}
            onChange={async (id) => setAiState(await window.veyra.ai.set({ model: { provider: 'veyra', model: id } }))}
            options={models.map((m) => ({ value: m.id, label: m.label }))}
          />
        )}
        <button className={`iconbtn plain agent-turbo ${turbo ? 'on' : ''}`} aria-pressed={turbo} title={turbo ? 'Turbo is on: changes are made without asking' : 'Turbo: make changes without asking'} aria-label="Turbo" onClick={flipTurbo}>
          <Zap size={16} />
        </button>
        <button className="iconbtn plain" aria-label="New chat" title="New chat" disabled={!!live || !turns.length} onClick={newChat}>
          <MessageSquarePlus size={16} />
        </button>
        <button className="iconbtn plain" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="ai-body agent-body" ref={scroller} aria-live="polite">
        {blocked ? (
          <div className="agent-empty">
            <p>{blocked}</p>
            <button className="btn sec sm" onClick={reload}>
              Check again
            </button>
          </div>
        ) : !turns.length && !live ? (
          <div className="agent-empty">
            <p className="dim">
              Ask for research, a summary, a quiz or a study plan. The Assistant can search the web, send helpers to research in parallel, and read and add to your notes and tasks{turbo ? ' (Turbo is on: it won’t ask first)' : ' (it asks before changing anything)'}.
            </p>
            <div className="agent-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="agent-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="agent-user">
              {t.files && (
                <div className="agent-user-files">
                  {t.files.map((n) => (
                    <span key={n} className="agent-file-name">
                      <Paperclip size={11} /> {n}
                    </span>
                  ))}
                </div>
              )}
              {t.text}
            </div>
          ) : (
            <Answer key={i} turn={t} onInsert={onInsert} />
          )
        )}

        {live && (
          <div className="agent-turn">
            {live.plan && <Plan items={live.plan} />}
            {live.steps.length > 0 && <Steps steps={live.steps} open />}
            {live.pending.map((p) => (
              <div key={p.key} className="agent-ask">
                <div className="agent-ask-head">
                  <FilePlus2 size={15} /> <b>{p.label}</b>
                </div>
                {p.preview && <pre className="agent-ask-preview">{p.preview}</pre>}
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => p.resolve(true)}>
                    <Check size={14} /> Allow
                  </button>
                  <button
                    className="btn sec sm"
                    onClick={() => {
                      setAllowChat(true)
                      liveRef.current?.pending.forEach((x) => x.resolve(true))
                    }}
                  >
                    Allow all in this chat
                  </button>
                  <button className="btn ghost sm" onClick={() => p.resolve(false)}>
                    Deny
                  </button>
                </div>
              </div>
            ))}
            {live.text ? <Markdown text={live.text} /> : live.thinking && <span className="ai-dots dim">{live.steps.length ? 'Working' : 'Thinking'}</span>}
            {live.changes.length > 0 && <Changes list={live.changes} onUndo={undo} />}
            {live.note && <p className="xs dim">{live.note}</p>}
          </div>
        )}
        {!live && done.some((c) => c.undo && !c.undone) && <Changes list={done.filter((c) => c.undo)} onUndo={undo} title="Changes in this chat" />}
      </div>

      {(files.length > 0 || reading > 0) && (
        <div className="agent-files" aria-label="Attached files">
          {files.map((f) => (
            <span key={`${f.name}:${f.size}`} className="agent-file" title={`${f.name} · ${sizeOf(f.size)} · goes with each message in this chat`}>
              {f.type === 'image' ? <ImageIcon size={13} /> : <FileText size={13} />}
              <span className="trunc">{f.name}</span>
              <span className="xs tert">{sizeOf(f.size)}</span>
              <button type="button" className="iconbtn plain agent-file-x" aria-label={`Remove ${f.name}`} disabled={!!live} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>
                <X size={12} />
              </button>
            </span>
          ))}
          {reading > 0 && (
            <span className="agent-file dim">
              <Loader2 size={13} className="spin" /> Reading…
            </span>
          )}
        </div>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept="image/*,application/pdf,.pdf,text/*,.md,.csv,.json,.txt"
        onChange={(e) => {
          void addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div className="agent-switches" role="group" aria-label="What the Assistant can use">
        <button type="button" className="agent-switch" disabled={!!blocked || files.length >= MAX_FILES} title="Attach pictures, PDFs or text files (or paste or drop them here)" onClick={() => picker.current?.click()}>
          <Paperclip size={13} /> Attach
        </button>
        <button
          type="button"
          className={`agent-switch ${web && status?.agentWeb !== false ? 'on' : ''}`}
          aria-pressed={web && status?.agentWeb !== false}
          disabled={status?.agentWeb === false}
          title={status?.agentWeb === false ? 'Web research is switched off for Veyra AI' : web ? 'Web search is on: it can search the web and read pages (costs more)' : 'Web search is off: notes and what it knows only'}
          onClick={() => (setWeb(!web), writeFlag(WEB_KEY, !web))}
        >
          <Globe size={13} /> Web search
        </button>
        <button
          type="button"
          className={`agent-switch ${subagents ? 'on' : ''}`}
          aria-pressed={subagents}
          title={subagents ? 'Subagents are on: it can send helpers to research parts at the same time (costs more)' : 'Subagents are off: it does all the work itself'}
          onClick={() => (setSubagents(!subagents), writeFlag(SUBAGENTS_KEY, !subagents))}
        >
          <Users size={13} /> Subagents
        </button>
        {drive?.connected &&
          (driveReady ? (
            <button
              type="button"
              className={`agent-switch ${driveOn ? 'on' : ''}`}
              aria-pressed={driveOn}
              title={driveOn ? 'Google Drive is on: it can search and read your Drive, and make Google Docs (it asks first)' : 'Google Drive is off for the Assistant'}
              onClick={() => (setDriveOn(!driveOn), writeFlag(DRIVE_KEY, !driveOn))}
            >
              <HardDrive size={13} /> Google Drive
            </button>
          ) : (
            <button
              type="button"
              className="agent-switch"
              title="Let the Assistant search and read your Google Drive: Settings → Connections → Google Drive"
              onClick={() => {
                sessionStorage.setItem('veyra.settingsSection', 'connections')
                go({ name: 'settings' })
              }}
            >
              <HardDrive size={13} /> Google Drive…
            </button>
          ))}
      </div>
      <form
        className="agent-compose"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          rows={2}
          placeholder={blocked ? 'Veyra AI isn’t available' : 'Ask the Assistant…'}
          value={input}
          disabled={!!blocked}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files]
            if (!pasted.length) return
            e.preventDefault()
            void addFiles(pasted)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          aria-label="Message the Assistant"
        />
        {live ? (
          <button type="button" className="iconbtn agent-send" aria-label="Stop" onClick={stop}>
            <Square size={14} />
          </button>
        ) : (
          <button type="submit" className="iconbtn agent-send" aria-label="Send" disabled={!input.trim() || !!blocked || reading > 0}>
            <ArrowUp size={16} />
          </button>
        )}
      </form>
      <p className="ai-note">
        {live?.model || model?.label || 'Veyra AI'} · AI can be wrong; check sources.{' '}
        {ai?.provider !== 'veyra' && !blocked && status?.approved && (
          <button
            className="linkbtn"
            onClick={() => {
              sessionStorage.setItem('veyra.settingsSection', 'ai')
              go({ name: 'settings' })
            }}
          >
            Your limits
          </button>
        )}
      </p>
    </aside>
  )
}

function Answer({ turn, onInsert }: { turn: ChatTurn; onInsert: (md: string) => void }) {
  const toast = useToast()
  return (
    <div className="agent-turn">
      {turn.plan && <Plan items={turn.plan} />}
      {turn.steps && turn.steps.length > 0 && <Steps steps={turn.steps.map((s, i) => ({ key: String(i), label: s.label, state: s.state ?? 'done', icon: 'note' }))} />}
      {turn.text && <Markdown text={turn.text} />}
      {turn.sources && <Sources list={turn.sources} />}
      {turn.changes && (
        <ul className="agent-changes">
          {turn.changes.map((c, i) => (
            <li key={i}>
              <Check size={13} /> {c.label}
            </li>
          ))}
        </ul>
      )}
      {turn.error && <p className="ai-error">{turn.error}</p>}
      {turn.note && <p className="xs dim">{turn.note}</p>}
      {turn.text && (
        <div className="row agent-actions">
          <button className="btn ghost sm" onClick={() => onInsert(turn.text)}>
            Insert into note
          </button>
          <button
            className="btn ghost sm"
            onClick={() => {
              void navigator.clipboard.writeText(turn.text)
              toast('Copied')
            }}
          >
            <Copy size={13} /> Copy
          </button>
        </div>
      )}
    </div>
  )
}

function Plan({ items }: { items: NonNullable<ChatTurn['plan']> }) {
  return (
    <div className="agent-plan">
      <div className="agent-plan-head">
        <ListChecks size={14} /> Plan
      </div>
      {items.map((it, i) => (
        <div key={i} className={`agent-plan-item ${it.status}`}>
          {it.status === 'done' ? <Check size={13} /> : it.status === 'in_progress' ? <Loader2 size={13} className="spin" /> : <CircleDashed size={13} />}
          <span>{it.text}</span>
        </div>
      ))}
    </div>
  )
}

function Steps({ steps, open: startOpen = false }: { steps: Step[]; open?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  const running = steps.filter((s) => s.state === 'running').length
  return (
    <div className="agent-steps">
      <button className="agent-steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {running ? `Working · ${steps.length} step${steps.length === 1 ? '' : 's'}` : `${steps.length} step${steps.length === 1 ? '' : 's'}`}
      </button>
      {open &&
        steps.map((s) => (
          <div key={s.key} className={`agent-step ${s.state}`}>
            {s.state === 'running' ? <Loader2 size={13} className="spin" /> : s.state === 'error' ? <XCircle size={13} /> : s.icon === 'web' ? <Globe size={13} /> : s.icon === 'sub' ? <Bot size={13} /> : <Check size={13} />}
            <span>{s.label}</span>
          </div>
        ))}
    </div>
  )
}

function Changes({ list, onUndo, title = 'Changes' }: { list: AgentChange[]; onUndo: (c: AgentChange) => void; title?: string }) {
  return (
    <div className="agent-plan">
      <div className="agent-plan-head">{title}</div>
      {list.map((c) => (
        <div key={c.id} className="agent-plan-item agent-change">
          <Check size={13} />
          <span className={`grow ${c.undone ? 'undone' : ''}`}>{c.label}</span>
          {c.url && !c.undone && (
            <button className="btn ghost xs" onClick={() => openLink(c.url!)}>
              <ExternalLink size={12} /> Open
            </button>
          )}
          {c.undo && !c.undone && (
            <button className="btn ghost xs" onClick={() => onUndo(c)}>
              <Undo2 size={12} /> Undo
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`)

const openLink = (url: string) => (window.veyra.open ? window.veyra.open(url) : window.open(url, '_blank', 'noopener'))

function Sources({ list }: { list: { url: string; title: string }[] }) {
  return (
    <div className="agent-sources">
      <div className="agent-plan-head">Sources</div>
      {list.map((s) => (
        <button key={s.url} className="agent-source" onClick={() => openLink(s.url)} title={s.url}>
          <ExternalLink size={12} />
          <span className="trunc">{s.title}</span>
          <span className="xs tert trunc">{hostOf(s.url)}</span>
        </button>
      ))}
    </div>
  )
}
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/* ---------- a small, safe Markdown view (no HTML is ever inserted) ---------- */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<b key={k++}>{t.slice(2, -2)}</b>)
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('[')) {
      const label = t.slice(1, t.indexOf(']('))
      const url = m[2]
      out.push(
        <a key={k++} href={url} onClick={(e) => (e.preventDefault(), openLink(url))}>
          {label}
        </a>
      )
    } else if (t.startsWith('http'))
      out.push(
        <a key={k++} href={t} onClick={(e) => (e.preventDefault(), openLink(t))}>
          {hostOf(t) || t}
        </a>
      )
    else out.push(<i key={k++}>{t.slice(1, -1)}</i>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let list: { ordered: boolean; items: string[] } | null = null
  let para: string[] = []
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>)
    para = []
  }
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>)
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
    }
    list = null
  }
  let code: string[] | null = null
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>)
        code = null
      } else {
        flushPara()
        flushList()
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    const li = /^\s*(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      flushList()
      blocks.push(<h4 key={blocks.length}>{inline(h[2])}</h4>)
    } else if (li) {
      flushPara()
      const ordered = !!li[1]
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(li[2].replace(/^\[( |x)\]\s*/, (_, x) => (x === 'x' ? '☑ ' : '☐ ')))
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  if (code) blocks.push(<pre key={blocks.length}>{(code as string[]).join('\n')}</pre>)
  flushPara()
  flushList()
  return <div className="agent-md">{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>
}
