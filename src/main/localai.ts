/**
 * One-click local AI. Finds an existing Ollama, or downloads Ollama's
 * portable build into the app's own folder (no installer, no admin),
 * checks it against GitHub's published SHA-256, runs it in the
 * background while the app is open, and pulls a model sized for this
 * computer.
 */
import { app, type WebContents } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LocalAiStatus, LocalModelChoice } from '../shared/types'

const run = promisify(execFile)
export const OLLAMA_URL = 'http://127.0.0.1:11434'
const GB = 1024 ** 3

export const LOCAL_MODELS: LocalModelChoice[] = [
  { model: 'llama3.2:3b', label: 'Fast', sizeGB: 2.0, why: 'Quick answers on almost any computer. Good for flashcards and summaries.' },
  { model: 'gemma3:4b', label: 'Balanced', sizeGB: 3.3, why: 'A little smarter, still light.' },
  { model: 'qwen2.5:7b', label: 'Best quality', sizeGB: 4.7, why: 'Better explanations. Needs 16 GB of memory; fast with a graphics card of 8 GB or more.' }
]

export class LocalAiError extends Error {}

export class LocalAi {
  private child: ChildProcess | null = null
  private abort: AbortController | null = null
  private dir = join(app.getPath('userData'), 'local-ai')
  private exe = join(this.dir, 'ollama', 'ollama.exe')

  /** True when an Ollama server answers. */
  async running(): Promise<boolean> {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }

  /** An Ollama installed the normal way, if there is one. */
  private installedExe(): string | null {
    const p = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Ollama', 'ollama.exe')
    return existsSync(p) ? p : null
  }

  private async hardware(): Promise<{ ramGB: number; vramGB: number; gpu: string }> {
    let vramGB = 0
    let gpu = ''
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true })
      const [name, mem] = stdout.trim().split('\n')[0].split(',').map((x) => x.trim())
      gpu = name
      vramGB = Math.round((Number(mem) / 1024) * 10) / 10
    } catch {
      /* no NVIDIA card (or no driver tools): CPU only */
    }
    return { ramGB: Math.round(totalmem() / GB), vramGB, gpu }
  }

  private recommend(hw: { ramGB: number; vramGB: number }): string {
    if (hw.vramGB >= 8 && hw.ramGB >= 16) return 'qwen2.5:7b'
    if (hw.ramGB >= 16 && hw.vramGB >= 4) return 'gemma3:4b'
    return 'llama3.2:3b'
  }

  async status(): Promise<LocalAiStatus> {
    const hw = await this.hardware()
    const isRunning = await this.running()
    let models: string[] = []
    if (isRunning) {
      try {
        models = ((await (await fetch(`${OLLAMA_URL}/api/tags`)).json()).models ?? []).map((m: any) => m.name)
      } catch {
        /* ignore */
      }
    }
    let freeGB = 0
    try {
      mkdirSync(this.dir, { recursive: true })
      const st = statfsSync(this.dir)
      freeGB = Math.round(((st.bavail * st.bsize) / GB) * 10) / 10
    } catch {
      /* unknown */
    }
    const engine = existsSync(this.exe) ? 'managed' : this.installedExe() || isRunning ? 'external' : null
    return { engine, running: isRunning, models, hardware: hw, recommended: this.recommend(hw), choices: LOCAL_MODELS, freeGB, engineSizeGB: 1.6 }
  }

  /** Starts Ollama in the background if it isn't answering yet. */
  async ensureRunning(): Promise<void> {
    if (await this.running()) return
    const exe = existsSync(this.exe) ? this.exe : this.installedExe()
    if (!exe) throw new LocalAiError('Local AI isn’t set up yet. Use Settings → AI → Set up local AI.')
    this.child = spawn(exe, ['serve'], {
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' },
      windowsHide: true,
      stdio: 'ignore'
    })
    this.child.on('exit', () => (this.child = null))
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.running()) return
    }
    throw new LocalAiError('The local AI engine didn’t start. Try again, or restart the app.')
  }

  /** Stops the engine if this app started it. */
  stop(): void {
    this.child?.kill()
    this.child = null
  }

  cancel(): void {
    this.abort?.abort()
  }

  /**
   * The whole setup, reporting each step:
   * engine (download) → unpack → start → model (download) → ready.
   */
  async setup(model: string, wc: WebContents): Promise<void> {
    const send = (step: string, progress: number | null, detail = '') => !wc.isDestroyed() && wc.send('localai:progress', { step, progress, detail })
    this.abort = new AbortController()
    const signal = this.abort.signal
    try {
      const st = await this.status()
      const choice = LOCAL_MODELS.find((m) => m.model === model)
      const need = (st.engine ? 0 : st.engineSizeGB * 2.2) + (choice?.sizeGB ?? 4) + 0.5
      if (st.freeGB && st.freeGB < need) throw new LocalAiError(`Not enough disk space: local AI needs about ${Math.ceil(need)} GB free, and there’s ${st.freeGB} GB.`)

      if (!st.engine) {
        // 1. Find the latest release and its published checksum.
        send('engine', 0, 'Finding the latest version')
        const rel = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VeyraStudy' } }).then((r) => {
          if (!r.ok) throw new LocalAiError('Couldn’t reach GitHub to download the AI engine.')
          return r.json()
        })
        const asset = (rel.assets ?? []).find((a: any) => a.name === 'ollama-windows-amd64.zip')
        if (!asset) throw new LocalAiError('The AI engine download wasn’t found. Try again later.')
        let expected = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : ''
        if (!expected) {
          const sums = (rel.assets ?? []).find((a: any) => a.name === 'sha256sum.txt')
          if (sums) {
            const txt = await (await fetch(sums.browser_download_url, { signal })).text()
            expected = txt.split('\n').find((l) => l.includes('ollama-windows-amd64.zip'))?.split(/\s+/)[0] ?? ''
          }
        }
        if (!expected) throw new LocalAiError('Couldn’t verify the AI engine download, so it wasn’t installed.')

        // 2. Download it, hashing as it arrives.
        mkdirSync(this.dir, { recursive: true })
        const zip = join(this.dir, 'ollama.zip.part')
        const res = await fetch(asset.browser_download_url, { signal })
        if (!res.ok || !res.body) throw new LocalAiError('The AI engine download failed. Try again.')
        const total = Number(res.headers.get('content-length')) || asset.size || 0
        const hash = createHash('sha256')
        const out = createWriteStream(zip)
        let got = 0
        let last = 0
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          got += value.byteLength
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          if (Date.now() - last > 250) {
            last = Date.now()
            send('engine', total ? got / total : null, `${(got / GB).toFixed(2)} of ${(total / GB).toFixed(2)} GB`)
          }
        }
        await new Promise<void>((r, j) => out.end((e: unknown) => (e ? j(e) : r())))
        if (hash.digest('hex') !== expected.toLowerCase()) {
          rmSync(zip, { force: true })
          throw new LocalAiError('The download didn’t match its checksum, so it was deleted. Try again.')
        }

        // 3. Unpack with Windows' built-in tar.
        send('unpack', null, 'Unpacking (this takes a minute)')
        const dest = join(this.dir, 'ollama.new')
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dest, { recursive: true })
        // Windows' own tar (bsdtar) unpacks zip files; a GNU tar earlier on PATH can't.
        const tar = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'tar.exe')
        await run(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', dest], { timeout: 15 * 60 * 1000, windowsHide: true })
        rmSync(zip, { force: true })
        rmSync(join(this.dir, 'ollama'), { recursive: true, force: true })
        renameSync(dest, join(this.dir, 'ollama'))
        if (!existsSync(this.exe)) throw new LocalAiError('The AI engine didn’t unpack properly. Try again.')
      }

      // 4. Start it.
      send('start', null, 'Starting the AI engine')
      await this.ensureRunning()

      // 5. Download the model.
      if (!(await this.status()).models.includes(model)) {
        const res = await fetch(`${OLLAMA_URL}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }), signal })
        if (!res.ok || !res.body) throw new LocalAiError('The model download failed to start.')
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (!line.trim()) continue
            const j = JSON.parse(line)
            if (j.error) throw new LocalAiError(String(j.error))
            if (j.total) send('model', (j.completed ?? 0) / j.total, `${((j.completed ?? 0) / GB).toFixed(2)} of ${(j.total / GB).toFixed(2)} GB`)
            else send('model', null, String(j.status ?? ''))
          }
        }
      }
      send('done', 1, '')
    } catch (e) {
      if (signal.aborted) throw new LocalAiError('Setup was cancelled. You can continue later; finished downloads are kept.')
      throw e
    } finally {
      this.abort = null
    }
  }
}
