import { useEffect, useState } from 'react'
import { Copy, RotateCcw, Sparkles, Square, X } from 'lucide-react'
import type { AiState } from '@shared/types'
import { AI_LABELS, buildPrompt, parseCards, useAiRun, type AiTask } from '../../data/ai'
import { useNav } from '../../nav'
import { useToast } from '../ui'

const PROVIDER_NAMES = { ollama: 'Local AI (Ollama)', anthropic: 'Claude', gemini: 'Gemini', openai: 'OpenAI' } as const

/** Side panel on a note: runs one AI study task and offers to put the result into the note. */
export function AiPanel({
  task,
  source,
  title,
  onInsert,
  onClose
}: {
  task: AiTask
  source: string
  title: string
  onInsert: (task: AiTask, text: string) => void
  onClose: () => void
}) {
  const { text, status, error, run, stop } = useAiRun()
  const [cfg, setCfg] = useState<AiState | null>(null)
  const { go } = useNav()
  const toast = useToast()

  const start = () => run(buildPrompt(task, source, { title }))
  useEffect(() => {
    window.veyra.ai.state().then((s) => {
      setCfg(s)
      if (s.provider && source.trim()) start()
    })
  }, [task, source]) // eslint-disable-line react-hooks/exhaustive-deps

  const cards = task === 'flashcards' || task === 'quiz' ? parseCards(text) : []
  const canInsert = status === 'done' && text.trim() && (cards.length > 0 || (task !== 'flashcards' && task !== 'quiz'))

  return (
    <aside className="ai-panel" aria-label={`AI: ${AI_LABELS[task]}`}>
      <header className="ai-head">
        <span className="ai-badge">
          <Sparkles size={14} />
        </span>
        <b className="grow">{AI_LABELS[task]}</b>
        <button className="iconbtn plain" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {cfg && !cfg.provider ? (
        <div className="ai-body">
          <p>AI tools need a provider. Use free local AI on this computer, or your own Claude, Gemini or OpenAI key.</p>
          <button
            className="btn"
            onClick={() => {
              sessionStorage.setItem('veyra.settingsSection', 'ai')
              go({ name: 'settings' })
            }}
          >
            Set up AI
          </button>
        </div>
      ) : !source.trim() ? (
        <div className="ai-body">
          <p className="dim">{task === 'explain' || task === 'simplify' ? 'Select some text in the note first.' : 'This note is empty. Write something first.'}</p>
        </div>
      ) : (
        <>
          <div className="ai-body" aria-live="polite">
            {cfg?.provider && <div className="xs tert" style={{ marginBottom: 8 }}>{PROVIDER_NAMES[cfg.provider]}{cfg.models[cfg.provider] ? ` · ${cfg.models[cfg.provider]}` : ''}</div>}
            {error ? (
              <p className="ai-error">{error}</p>
            ) : cards.length ? (
              <ol className="ai-cards">
                {cards.map((c, i) => (
                  <li key={i}>
                    <b>{c.q}</b>
                    <span>{c.a}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="ai-text">{text || (status === 'running' ? <span className="ai-dots">Thinking</span> : '')}</div>
            )}
            {status === 'running' && cards.length > 0 && <span className="ai-dots xs">Writing more</span>}
            {status === 'done' && (task === 'flashcards' || task === 'quiz') && !cards.length && !error && (
              <p className="ai-error">The answer wasn’t in the expected format. Try again, or pick a larger model in Settings → AI.</p>
            )}
          </div>
          <footer className="ai-foot">
            {status === 'running' ? (
              <button className="btn sec sm" onClick={stop}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <>
                <button className="btn sm" disabled={!canInsert} onClick={() => onInsert(task, text)}>
                  Insert into note
                </button>
                <button
                  className="btn ghost sm"
                  disabled={!text}
                  onClick={() => {
                    navigator.clipboard.writeText(text)
                    toast('Copied')
                  }}
                >
                  <Copy size={13} /> Copy
                </button>
                <button className="btn ghost sm" onClick={start}>
                  <RotateCcw size={13} /> Try again
                </button>
              </>
            )}
          </footer>
          <p className="ai-note">AI can be wrong. Check answers against your course material.</p>
        </>
      )}
    </aside>
  )
}
