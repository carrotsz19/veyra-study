import { useEffect, useState } from 'react'
import { Check, Cpu, Loader2, Sparkles } from 'lucide-react'
import type { LocalAiProgress, LocalAiStatus } from '@shared/types'
import { useAiRun } from '../data/ai'

const STEPS: [LocalAiProgress['step'], string][] = [
  ['engine', 'Download the AI engine'],
  ['unpack', 'Unpack it'],
  ['start', 'Start it'],
  ['model', 'Download the model'],
  ['done', 'Ready']
]

/** One-click local AI: engine + a model sized for this computer, then a test answer. */
export function LocalAiSetup({ onReady }: { onReady?: () => void }) {
  const [st, setSt] = useState<LocalAiStatus | null>(null)
  const [model, setModel] = useState('')
  const [phase, setPhase] = useState<'choose' | 'running' | 'done' | 'error'>('choose')
  const [prog, setProg] = useState<LocalAiProgress | null>(null)
  const [reached, setReached] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const test = useAiRun()

  useEffect(() => {
    window.veyra.ai.localStatus().then((s) => {
      setSt(s)
      setModel(s.recommended)
    })
    return window.veyra.ai.onLocalProgress((p) => {
      setProg(p)
      setReached((r) => new Set([...r, p.step]))
    })
  }, [])

  if (!st) return <div className="card local-setup sm dim">Checking this computer…</div>

  const choice = st.choices.find((c) => c.model === model) ?? st.choices[0]
  const download = (st.engine ? 0 : st.engineSizeGB) + (st.models.includes(model) ? 0 : choice.sizeGB)
  const tooBig = model === 'qwen2.5:7b' && st.hardware.ramGB < 16

  const start = async () => {
    setPhase('running')
    setErr('')
    setReached(new Set())
    try {
      await window.veyra.ai.localSetup(model)
      setPhase('done')
      test.run({ system: 'You are a friendly study assistant.', prompt: 'In one short sentence, say hello and that you are ready to help with studying.' })
      onReady?.()
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setPhase('error')
    }
  }

  return (
    <div className="card local-setup">
      <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
        <span className="ls-icon">
          <Sparkles size={20} />
        </span>
        <div className="grow">
          <h3>Free AI on this computer</h3>
          <p className="sm dim" style={{ margin: '2px 0 0' }}>
            Private and offline: your notes never leave this PC. Veyra downloads everything and runs it for you; there’s nothing else to install.
          </p>
        </div>
      </div>

      {phase === 'choose' || phase === 'error' ? (
        <>
          <div className="ls-hw">
            <Cpu size={14} /> This computer: {st.hardware.ramGB} GB memory
            {st.hardware.gpu ? ` · ${st.hardware.gpu.replace(/^NVIDIA\s+/, '')} (${st.hardware.vramGB} GB)` : ' · no dedicated graphics card'}
          </div>
          <div className="ls-models" role="radiogroup" aria-label="Model size">
            {st.choices.map((c) => (
              <button key={c.model} className="ls-model" role="radio" aria-checked={model === c.model} onClick={() => setModel(c.model)}>
                <span className="between">
                  <b>{c.label}</b>
                  {c.model === st.recommended && <span className="pill accent">Recommended</span>}
                </span>
                <span className="ls-why">{c.why}</span>
                <span className="xs tert">
                  {c.model} · {st.models.includes(c.model) ? 'downloaded' : `${c.sizeGB} GB`}
                </span>
              </button>
            ))}
          </div>
          {tooBig && <p className="ai-error">This computer has {st.hardware.ramGB} GB of memory; this model will be very slow. “Fast” is a better fit.</p>}
          {err && <p className="ai-error">{err}</p>}
          <div className="between" style={{ marginTop: 14 }}>
            <span className="xs dim">
              {download ? `Downloads about ${download.toFixed(1)} GB` : 'Nothing to download'}
              {st.freeGB ? ` · ${st.freeGB} GB free on this drive` : ''}
            </span>
            <button className="btn" onClick={start}>
              {phase === 'error' ? 'Try again' : st.engine && st.models.includes(model) ? 'Use local AI' : 'Set up local AI'}
            </button>
          </div>
        </>
      ) : (
        <div className="ls-steps">
          {STEPS.filter(([k]) => !(st.engine && (k === 'engine' || k === 'unpack'))).map(([k, label]) => {
            const doneStep = phase === 'done' || (reached.has(k) && prog?.step !== k)
            const current = phase === 'running' && prog?.step === k
            return (
              <div key={k} className={`ls-step ${doneStep ? 'done' : current ? 'current' : ''}`}>
                <span className="ls-dot">{doneStep ? <Check size={13} strokeWidth={3} /> : current ? <Loader2 size={13} className="spin" /> : null}</span>
                <span className="grow">
                  {k === 'model' ? `${label} (${choice.label}, ${choice.sizeGB} GB)` : k === 'engine' ? `${label} (${st.engineSizeGB} GB)` : label}
                  {current && prog?.detail && <span className="xs dim" style={{ display: 'block' }}>{prog.detail}</span>}
                  {current && prog?.progress != null && (
                    <span className="bar" style={{ display: 'block', marginTop: 6 }}>
                      <span style={{ width: `${Math.round(prog.progress * 100)}%`, background: 'var(--accent)' }} />
                    </span>
                  )}
                </span>
              </div>
            )
          })}
          {phase === 'running' && (
            <div className="between" style={{ marginTop: 12 }}>
              <span className="xs dim">You can keep using Veyra while this downloads.</span>
              <button className="btn ghost sm" onClick={() => window.veyra.ai.localCancel()}>
                Cancel
              </button>
            </div>
          )}
          {phase === 'done' && (
            <div className="ls-test">
              <b className="sm">Local AI is ready.</b>
              <div className="sm">{test.text || (test.status === 'running' ? <span className="ai-dots">Loading the model for its first answer (up to a minute)</span> : test.error)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
