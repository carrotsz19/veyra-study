/**
 * AI study tools. The person picks a provider in Settings → AI:
 *  - Local: Ollama on this computer (free, private, offline);
 *  - Claude, Gemini or OpenAI with their own API key (billed to them).
 * Keys are stored encrypted with safeStorage and never reach the UI.
 * Requests stream back to the renderer as "ai:event" messages.
 */
import { safeStorage, type WebContents } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import type { AiProvider, AiState } from '../shared/types'

interface Config {
  provider: AiProvider | null
  ollamaUrl: string
  models: Partial<Record<AiProvider, string>>
  keys: Partial<Record<Exclude<AiProvider, 'ollama'>, string>>
}

export class AiError extends Error {}

const DEFAULT_MODELS: Record<Exclude<AiProvider, 'ollama'>, string> = {
  anthropic: 'claude-opus-5-5',
  gemini: '',
  openai: ''
}
/** Claude models that accept Anthropic's server-side refusal fallback ("default" form). */
const FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']

/** Reads a fetch response body line by line (NDJSON or server-sent events). */
async function* lines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line) yield line
    }
  }
  if (buf.trim()) yield buf.trim()
}

export class AiService {
  private cfg: Config = { provider: null, ollamaUrl: 'http://127.0.0.1:11434', models: {}, keys: {} }
  private running = new Map<string, AbortController>()
  private disposed = false

  constructor(
    private file: string,
    /** Starts the local engine if it isn't running (one-click local AI). */
    private ensureLocal?: () => Promise<void>
  ) {
    try {
      if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.cfg = { ...this.cfg, ...JSON.parse(safeStorage.decryptString(readFileSync(file))) }
    } catch {
      /* start fresh */
    }
  }

  dispose(): void {
    this.disposed = true
    for (const c of this.running.values()) c.abort()
  }

  private save() {
    if (this.disposed) return
    if (!safeStorage.isEncryptionAvailable()) throw new AiError('This computer can’t store keys securely.')
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.cfg)))
  }

  state(): AiState {
    return {
      provider: this.cfg.provider,
      ollamaUrl: this.cfg.ollamaUrl,
      models: this.cfg.models,
      hasKey: { anthropic: !!this.cfg.keys.anthropic, gemini: !!this.cfg.keys.gemini, openai: !!this.cfg.keys.openai }
    }
  }

  set(o: { provider?: AiProvider | null; model?: { provider: AiProvider; model: string }; key?: { provider: Exclude<AiProvider, 'ollama'>; key: string }; ollamaUrl?: string }): AiState {
    if (o.provider !== undefined) this.cfg.provider = o.provider
    if (o.model) this.cfg.models = { ...this.cfg.models, [o.model.provider]: o.model.model }
    if (o.key) {
      const k = o.key.key.trim()
      if (k) this.cfg.keys = { ...this.cfg.keys, [o.key.provider]: k }
      else delete this.cfg.keys[o.key.provider]
    }
    if (o.ollamaUrl) this.cfg.ollamaUrl = o.ollamaUrl.replace(/\/$/, '')
    this.save()
    return this.state()
  }

  forget(): AiState {
    this.cfg = { provider: null, ollamaUrl: 'http://127.0.0.1:11434', models: {}, keys: {} }
    rmSync(this.file, { force: true })
    return this.state()
  }

  private key(p: Exclude<AiProvider, 'ollama'>): string {
    const k = this.cfg.keys[p]
    if (!k) throw new AiError('Add your API key in Settings → AI first.')
    return k
  }

  private async local(): Promise<void> {
    if (this.ensureLocal && this.cfg.ollamaUrl === 'http://127.0.0.1:11434') await this.ensureLocal().catch(() => {})
  }

  /** Models the provider offers to this person (live from the provider). */
  async models(p: AiProvider): Promise<string[]> {
    try {
      if (p === 'ollama') {
        await this.local()
        const r = await fetch(`${this.cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) })
        const j = await r.json()
        return (j.models ?? []).map((m: any) => m.name as string)
      }
      if (p === 'anthropic') {
        const client = new Anthropic({ apiKey: this.key('anthropic') })
        const out: string[] = []
        for await (const m of client.models.list()) out.push(m.id)
        return out
      }
      if (p === 'gemini') {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': this.key('gemini') }, signal: AbortSignal.timeout(15000) })
        if (r.status === 400 || r.status === 403) throw new AiError('Google didn’t accept that API key.')
        const j = await r.json()
        return (j.models ?? [])
          .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
          .map((m: any) => String(m.name).replace(/^models\//, ''))
      }
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${this.key('openai')}` }, signal: AbortSignal.timeout(15000) })
      if (r.status === 401) throw new AiError('OpenAI didn’t accept that API key.')
      const j = await r.json()
      return (j.data ?? []).map((m: any) => m.id as string).filter((id: string) => /^(gpt|o\d|chatgpt)/.test(id)).sort()
    } catch (e) {
      if (e instanceof AiError) throw e
      if (e instanceof Anthropic.AuthenticationError) throw new AiError('Anthropic didn’t accept that API key.')
      if (p === 'ollama') throw new AiError('Ollama isn’t running on this computer. Install it from ollama.com, then open it.')
      throw new AiError('Couldn’t reach the AI provider. Check your connection.')
    }
  }

  /** Downloads a local model, reporting progress (0–1). */
  async pull(model: string, wc: WebContents): Promise<void> {
    await this.local()
    const res = await fetch(`${this.cfg.ollamaUrl}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }) }).catch(() => null)
    if (!res || !res.ok) throw new AiError(res?.status === 404 ? `Ollama has no model called “${model}”.` : 'Ollama isn’t running on this computer.')
    for await (const line of lines(res)) {
      let j: any
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      if (j.error) throw new AiError(String(j.error))
      if (!wc.isDestroyed()) wc.send('ai:pull', { model, status: j.status, progress: j.total ? (j.completed ?? 0) / j.total : null })
    }
  }

  cancel(id: string): void {
    this.running.get(id)?.abort()
  }

  /** Streams one answer to the renderer as ai:event {id, delta | done | error}. */
  async run(id: string, req: { system: string; prompt: string }, wc: WebContents): Promise<void> {
    const send = (msg: Record<string, unknown>) => !wc.isDestroyed() && wc.send('ai:event', { id, ...msg })
    const p = this.cfg.provider
    const ctrl = new AbortController()
    this.running.set(id, ctrl)
    try {
      if (!p) throw new AiError('Choose an AI provider in Settings → AI first.')
      const model = this.cfg.models[p] || (p !== 'ollama' ? DEFAULT_MODELS[p] : '')
      if (!model) throw new AiError('Choose a model in Settings → AI first.')

      if (p === 'anthropic') {
        const client = new Anthropic({ apiKey: this.key('anthropic') })
        const fallback = FALLBACK_MODELS.includes(model)
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 16000,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
            output_config: { effort: 'medium' },
            ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
          },
          { signal: ctrl.signal }
        )
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') send({ delta: ev.delta.text })
        }
        const final = await stream.finalMessage()
        if (final.stop_reason === 'refusal') throw new AiError('Claude declined this request.')
        if (final.stop_reason === 'max_tokens') send({ delta: '\n\n(Stopped: the answer was too long.)' })
      } else if (p === 'ollama') {
        await this.local()
        const res = await fetch(`${this.cfg.ollamaUrl}/api/chat`, {
          method: 'POST',
          signal: ctrl.signal,
          // keep_alive: stay loaded for a study session, so later answers start at once.
          body: JSON.stringify({ model, stream: true, keep_alive: '30m', messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] })
        }).catch((e) => {
          if (ctrl.signal.aborted) throw e
          throw new AiError('Ollama isn’t running on this computer. Open Ollama and try again.')
        })
        if (!res.ok) throw new AiError(res.status === 404 ? `The model “${model}” isn’t downloaded. Get it in Settings → AI.` : `Ollama answered ${res.status}.`)
        for await (const line of lines(res)) {
          const j = JSON.parse(line)
          if (j.error) throw new AiError(String(j.error))
          if (j.message?.content) send({ delta: j.message.content })
        }
      } else if (p === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key('gemini') },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.prompt }] }] })
        })
        if (!res.ok) throw new AiError(res.status === 429 ? 'Gemini’s limit for your key was reached. Try again later.' : res.status === 400 || res.status === 403 ? 'Google didn’t accept the request or key.' : `Gemini answered ${res.status}.`)
        for await (const line of lines(res)) {
          if (!line.startsWith('data:')) continue
          const j = JSON.parse(line.slice(5))
          for (const part of j.candidates?.[0]?.content?.parts ?? []) if (part.text) send({ delta: part.text })
        }
      } else {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key('openai')}` },
          body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] })
        })
        if (!res.ok) throw new AiError(res.status === 401 ? 'OpenAI didn’t accept your key.' : res.status === 429 ? 'OpenAI’s limit for your key was reached.' : `OpenAI answered ${res.status}.`)
        for await (const line of lines(res)) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue
          const d = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content
          if (d) send({ delta: d })
        }
      }
      send({ done: true })
    } catch (e) {
      if (ctrl.signal.aborted) send({ done: true, cancelled: true })
      else if (e instanceof AiError) send({ error: e.message })
      else if (e instanceof Anthropic.AuthenticationError) send({ error: 'Anthropic didn’t accept your API key.' })
      else if (e instanceof Anthropic.RateLimitError) send({ error: 'Your Claude rate limit was reached. Try again in a moment.' })
      else if (e instanceof Anthropic.APIError) send({ error: `Claude answered with an error (${e.status ?? 'network'}).` })
      else send({ error: 'The AI request failed. Check your connection and try again.' })
    } finally {
      this.running.delete(id)
    }
  }
}
