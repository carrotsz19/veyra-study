/**
 * Offline transcription with whisper.cpp, run on this computer. Veyra
 * downloads the Windows build from whisper.cpp's GitHub releases and a model
 * from its Hugging Face repo, checks each against its published SHA-256, and
 * runs whisper-cli on a 16 kHz WAV the UI makes from the recording.
 */
import { app, type WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VoiceModel, VoiceProgress, VoiceStatus } from '../shared/types'

const run = promisify(execFile)
const MB = 1024 * 1024

export const VOICE_MODELS: { id: VoiceModel; file: string; label: string; sizeMB: number; why: string }[] = [
  { id: 'base', file: 'ggml-base.bin', label: 'Fast', sizeMB: 141, why: 'Clear lectures and voice notes. Several times faster than real time on most laptops.' },
  { id: 'small', file: 'ggml-small.bin', label: 'More accurate', sizeMB: 465, why: 'Better with accents, quick speech and noisy rooms. Slower.' }
]

export class VoiceError extends Error {}

export class Whisper {
  private dir = join(app.getPath('userData'), 'whisper')
  private abort: AbortController | null = null
  private jobs = new Map<string, ChildProcess>()

  private get exe() {
    return join(this.dir, 'engine', 'whisper-cli.exe')
  }
  private model(id: VoiceModel) {
    return join(this.dir, 'models', VOICE_MODELS.find((m) => m.id === id)!.file)
  }

  status(): VoiceStatus {
    return {
      engine: existsSync(this.exe),
      models: VOICE_MODELS.filter((m) => existsSync(this.model(m.id))).map((m) => m.id),
      choices: VOICE_MODELS.map(({ id, label, sizeMB, why }) => ({ id, label, sizeMB, why }))
    }
  }

  cancelSetup(): void {
    this.abort?.abort()
  }

  /** Downloads whatever is missing: the engine and/or the model. */
  async setup(model: VoiceModel, wc: WebContents): Promise<VoiceStatus> {
    if (!VOICE_MODELS.some((m) => m.id === model)) throw new VoiceError('Unknown transcription model.')
    const send = (p: VoiceProgress) => !wc.isDestroyed() && wc.send('voice:progress', p)
    this.abort = new AbortController()
    const signal = this.abort.signal
    try {
      if (!existsSync(this.exe)) {
        send({ step: 'engine', progress: 0, detail: 'Finding the latest version' })
        // Windows builds are on whisper.cpp's numbered releases; take the newest that has one.
        const rels = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15', { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VeyraStudy' } }).then((r) => {
          if (!r.ok) throw new VoiceError('Couldn’t reach GitHub to download the transcription engine.')
          return r.json()
        })
        const asset = (rels as any[]).flatMap((r) => r.assets ?? []).find((a: any) => a.name === 'whisper-bin-x64.zip' && typeof a.digest === 'string' && a.digest.startsWith('sha256:'))
        if (!asset) throw new VoiceError('The transcription engine download wasn’t found. Try again later.')
        mkdirSync(this.dir, { recursive: true })
        const zip = join(this.dir, 'engine.zip.part')
        await download(asset.browser_download_url, zip, asset.digest.slice(7), signal, (got, total) => send({ step: 'engine', progress: total ? got / total : null, detail: `${(got / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB` }))
        send({ step: 'unpack', progress: null, detail: 'Unpacking' })
        const tmp = join(this.dir, 'engine.new')
        rmSync(tmp, { recursive: true, force: true })
        mkdirSync(tmp, { recursive: true })
        const tar = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'tar.exe')
        await run(existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', tmp], { timeout: 5 * 60_000, windowsHide: true })
        rmSync(zip, { force: true })
        // The zip has a Release folder; keep just that.
        const inner = existsSync(join(tmp, 'Release', 'whisper-cli.exe')) ? join(tmp, 'Release') : readdirSync(tmp).map((d) => join(tmp, d)).find((d) => existsSync(join(d, 'whisper-cli.exe'))) ?? tmp
        rmSync(join(this.dir, 'engine'), { recursive: true, force: true })
        renameSync(inner, join(this.dir, 'engine'))
        rmSync(tmp, { recursive: true, force: true })
        if (!existsSync(this.exe)) throw new VoiceError('The transcription engine didn’t unpack properly. Try again.')
      }

      if (!existsSync(this.model(model))) {
        const m = VOICE_MODELS.find((x) => x.id === model)!
        send({ step: 'model', progress: 0, detail: `Getting the ${m.label.toLowerCase()} model` })
        const tree = await fetch('https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main', { signal }).then((r) => {
          if (!r.ok) throw new VoiceError('Couldn’t reach Hugging Face to download the model.')
          return r.json()
        })
        const entry = (tree as any[]).find((f) => f.path === m.file)
        const sha = entry?.lfs?.oid
        if (!sha) throw new VoiceError('Couldn’t verify the model download, so it wasn’t installed.')
        mkdirSync(join(this.dir, 'models'), { recursive: true })
        const part = this.model(model) + '.part'
        await download(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`, part, sha, signal, (got, total) =>
          send({ step: 'model', progress: total ? got / total : null, detail: `${Math.round(got / MB)} of ${Math.round(total / MB)} MB` })
        )
        renameSync(part, this.model(model))
      }
      send({ step: 'done', progress: 1, detail: '' })
      return this.status()
    } catch (e) {
      if (signal.aborted) throw new VoiceError('Download cancelled.')
      throw e instanceof VoiceError ? e : new VoiceError('The download didn’t finish. Check your connection and try again.')
    } finally {
      this.abort = null
    }
  }

  /** Transcribes a 16 kHz mono WAV. Progress goes to the window as voice:transcribing. */
  async transcribe(id: string, wav: Uint8Array, model: VoiceModel, language: string, wc: WebContents): Promise<string> {
    if (!existsSync(this.exe) || !existsSync(this.model(model))) throw new VoiceError('Transcription isn’t set up yet.')
    if (!(wav instanceof Uint8Array) || wav.byteLength < 100) throw new VoiceError('That recording is empty.')
    const work = join(tmpdir(), `veyra-voice-${randomUUID()}`)
    mkdirSync(work, { recursive: true })
    const input = join(work, 'audio.wav')
    writeFileSync(input, wav)
    const lang = /^(auto|[a-z]{2})$/.test(language) ? language : 'auto'
    const threads = String(Math.max(1, Math.min(8, availableParallelism() - 1)))
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(this.exe, ['-m', this.model(model), '-f', input, '-otxt', '-of', join(work, 'out'), '-l', lang, '-t', threads, '-pp', '-nt'], { cwd: join(this.dir, 'engine'), windowsHide: true })
        this.jobs.set(id, p)
        let err = ''
        const progress = (chunk: Buffer) => {
          const s = chunk.toString()
          err = (err + s).slice(-4000)
          const m = [...s.matchAll(/progress\s*=\s*(\d+)%/g)].pop()
          if (m && !wc.isDestroyed()) wc.send('voice:transcribing', { id, progress: Number(m[1]) / 100 })
        }
        p.stderr.on('data', progress)
        p.stdout.on('data', progress)
        p.on('error', () => reject(new VoiceError('The transcription engine couldn’t start.')))
        p.on('close', (code, signal) => {
          this.jobs.delete(id)
          if (signal || code === null) reject(new VoiceError('Transcription cancelled.'))
          else if (code !== 0) reject(new VoiceError(/failed to (read|open)/i.test(err) ? 'The recording couldn’t be read.' : 'Transcription failed.'))
          else resolve()
        })
      })
      const out = join(work, 'out.txt')
      return existsSync(out) ? readFileSync(out, 'utf8').trim() : ''
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  cancel(id: string): void {
    this.jobs.get(id)?.kill()
  }

  stopAll(): void {
    for (const p of this.jobs.values()) p.kill()
  }
}

/** Downloads to `file`, hashing as it arrives; deletes it if the SHA-256 doesn't match. */
async function download(url: string, file: string, sha256: string, signal: AbortSignal, onProgress: (got: number, total: number) => void): Promise<void> {
  const res = await fetch(url, { signal, headers: { 'User-Agent': 'VeyraStudy' } })
  if (!res.ok || !res.body) throw new VoiceError('The download failed. Try again.')
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  let got = 0
  let last = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      got += value.byteLength
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      if (Date.now() - last > 250) {
        last = Date.now()
        onProgress(got, total)
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  if (hash.digest('hex') !== sha256.toLowerCase()) {
    rmSync(file, { force: true })
    throw new VoiceError('The download didn’t match its checksum, so it was deleted. Try again.')
  }
}
