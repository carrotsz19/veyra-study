import { useCallback, useEffect, useState } from 'react'
import type { AiState } from '@shared/types'
import { groupCall } from './groups'

/* =====================================================================
   Veyra AI: Claude through the Veyra group server, on the owner's key, for
   people the owner approves, within limits (server/ai.mjs). Works on the
   computer, the phone and the website. Answers are read back by polling
   (the server's tunnel doesn't carry streams).
===================================================================== */

export interface VeyraAiLimit {
  kind: '5h' | 'week' | 'month'
  /** 0 to 1 */
  used: number
  resetsAt: number | null
}
export interface VeyraAiStatus {
  configured: boolean
  approved: boolean
  owner: boolean
  models: { id: string; label: string }[]
  limits: VeyraAiLimit[]
  /** The month is quiet, so limits are raised for now. */
  boost: boolean
  /** The month is near its total: everyone is on the fastest model with a smaller share. */
  saving: boolean
  /** Past this share of a limit, requests move to the fastest model (null: never). */
  downgradeAt: number | null
  maxChars: number
  /** The owner allows web research in the Assistant. */
  agentWeb?: boolean
  /** The owner opened the Veyra AI tab to everyone (servers before 1.15.0 leave it out). */
  aiTab?: boolean
  /** Why a request can't be sent now, or null. */
  blocked: string | null
  busy: boolean
}

export const LIMIT_LABELS: Record<VeyraAiLimit['kind'], string> = { '5h': '5-hour limit', week: 'Weekly limit', month: 'Monthly limit' }

/** The chosen AI (provider and models), shared by every screen that needs it. */
let aiState: AiState | null = null
const stateListeners = new Set<(s: AiState) => void>()
export function setAiState(s: AiState): AiState {
  aiState = s
  stateListeners.forEach((l) => l(s))
  return s
}
export async function loadAiState(): Promise<AiState> {
  return setAiState(await window.veyra.ai.state())
}
export function useAiState(): AiState | null {
  const [s, set] = useState(aiState)
  useEffect(() => {
    stateListeners.add(set)
    if (!aiState) void loadAiState().catch(() => {})
    return () => void stateListeners.delete(set)
  }, [])
  return s
}

/** This person's Veyra AI: whether they can use it, the models, and how full their limits are. */
export function useVeyraAi(active = true) {
  const [status, setStatus] = useState<VeyraAiStatus | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    groupCall<VeyraAiStatus>('GET', '/ai')
      .then((s) => {
        setStatus(s)
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Couldn’t reach the Veyra server.'))
  }, [])
  useEffect(() => {
    if (!active) return
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [active, load])
  return { status, error, reload: load }
}

/** "resets 3:40 PM", "resets Tue 9:00 AM", "resets 12 Dec" */
export function resetText(at: number | null, timeFormat: '12h' | '24h' = '12h'): string {
  if (!at) return 'Starts with your next request'
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: timeFormat === '12h' })
  const days = (at - Date.now()) / 86_400_000
  if (new Date().toDateString() === d.toDateString()) return `Resets ${time}`
  if (days < 6) return `Resets ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `Resets ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
}

export interface VeyraRun {
  cancel: () => void
}
/**
 * Sends one request and reports the answer as it arrives. `model` is a wish: near a limit the
 * server may answer with the fastest model instead (onStart says which).
 */
export function runVeyraAi(
  req: { system: string; prompt: string },
  model: string | undefined,
  on: { start?: (m: { label: string; downgraded: boolean }) => void; text: (all: string) => void; done: (r: { error?: string; cut?: boolean }) => void }
): VeyraRun {
  let id: string | null = null
  let stopped = false
  let text = ''
  void (async () => {
    try {
      const job = await groupCall<{ id: string; model: { id: string; label: string }; downgraded: boolean }>('POST', '/ai/jobs', { ...req, model })
      id = job.id
      if (stopped) return void groupCall('DELETE', `/ai/jobs/${encodeURIComponent(job.id)}`).catch(() => {})
      on.start?.({ label: job.model.label, downgraded: job.downgraded })
      for (let fails = 0; !stopped; ) {
        try {
          const p = await groupCall<{ text: string; length: number; done: boolean; error: string | null; cut: boolean }>('GET', `/ai/jobs/${encodeURIComponent(job.id)}?from=${text.length}`)
          fails = 0
          if (p.text) {
            text += p.text
            on.text(text)
          }
          if (p.done) return on.done({ error: p.error ?? undefined, cut: p.cut })
        } catch (e) {
          // A dropped connection: try a few more times before giving up.
          if (++fails >= 4) throw e
          await new Promise((r) => setTimeout(r, 1000 * fails))
        }
      }
    } catch (e) {
      if (!stopped) on.done({ error: e instanceof Error ? e.message : 'Couldn’t reach Veyra AI.' })
    }
  })()
  return {
    cancel: () => {
      stopped = true
      if (id) void groupCall('DELETE', `/ai/jobs/${encodeURIComponent(id)}`).catch(() => {})
    }
  }
}
