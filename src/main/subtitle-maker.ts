/**
 * Transcribing with Subtitle Maker (carrotsz19/subtitle-maker) when it's on
 * this computer: it already has faster-whisper, the user's quality level,
 * graphics card settings, hotwords, word fixes and downloaded models, so
 * Veyra uses those instead of downloading an engine and model of its own.
 *
 * Veyra runs a small script in Subtitle Maker's own Python, using its own
 * helpers to pick and load the model (never downloading one). Its subtitle
 * command isn't used: subtitles drop punctuation and capitals, and notes want
 * proper sentences. "Working" means its engine loads and a model is there.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SubtitleMakerInfo {
  folder: string
  python: string
  level: string
  model: string
  device: string
}

const DATA = process.env['VEYRA_SUBTITLE_MAKER_DATA'] || join(homedir(), '.subtitle-maker')

/** Runs in Subtitle Maker's Python, in its folder. "check" reports what it would use; a WAV path transcribes it. */
export const SM_SCRIPT = String.raw`
import json, os, sys
sys.path.insert(0, os.getcwd())  # Subtitle Maker's folder (the script itself is in a temp folder)
mode = sys.argv[1]
from paths import load_settings, LEVELS
import models
settings = load_settings()
order = ["max", "high", "balanced", "fast", "potato"]
level = settings.get("level")
if not (level in LEVELS and models.whisper_path(LEVELS[level]["model"])):
    level = next((l for l in order if l in LEVELS and models.whisper_path(LEVELS[l]["model"])), None)
if level is None:
    print(json.dumps({"ok": False, "why": "no speech model downloaded"})); sys.exit(0)
name = LEVELS[level]["model"]
if mode == "check":
    import faster_whisper, ctranslate2
    print(json.dumps({"ok": True, "level": LEVELS[level]["name"], "model": name, "device": settings.get("device", "auto")})); sys.exit(0)
language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("", "auto") else settings.get("language")
import make_subtitles as ms
model, device = ms.load_model(name, settings.get("device", "auto"))
# A punctuated example to continue from: without one, Whisper often writes in lowercase with no full stops.
kwargs = {"language": language or None, "vad_filter": bool(settings.get("vad", True)), "beam_size": 5,
          "initial_prompt": "Hello, and welcome. Today's notes are written in full sentences, with punctuation."}
if settings.get("hotwords"):
    kwargs["hotwords"] = settings["hotwords"]
segments, info = model.transcribe(mode, **kwargs)
fixes = [f for f in settings.get("fixes", []) if isinstance(f, list) and len(f) == 2]
total = max(info.duration or 1, 1)
for s in segments:
    text = s.text.strip()
    for a, b in fixes:
        text = text.replace(a, b)
    print("@@" + json.dumps({"start": s.start, "end": s.end, "text": text, "progress": min(1, s.end / total)}), flush=True)
print("@@" + json.dumps({"done": True, "device": device}), flush=True)
`

let cached: { at: number; info: SubtitleMakerInfo | null } | null = null

function writeScript(): string {
  const file = join(tmpdir(), `veyra-sm-${randomUUID()}.py`)
  writeFileSync(file, SM_SCRIPT)
  return file
}

/** Subtitle Maker, if it's installed and working (checked at most every 10 minutes). */
export async function findSubtitleMaker(fresh = false): Promise<SubtitleMakerInfo | null> {
  if (!fresh && cached && Date.now() - cached.at < 10 * 60_000) return cached.info
  const info = await probe()
  cached = { at: Date.now(), info }
  return info
}

async function probe(): Promise<SubtitleMakerInfo | null> {
  let script = ''
  try {
    const python = join(DATA, 'venv', 'Scripts', 'python.exe')
    const folder = String(JSON.parse(readFileSync(join(DATA, 'installed.json'), 'utf8')).folder || '')
    if (!existsSync(python) || !folder || !existsSync(join(folder, 'models.py')) || !existsSync(join(folder, 'make_subtitles.py'))) return null
    script = writeScript()
    const out = await new Promise<string>((resolve) =>
      execFile(python, [script, 'check'], { cwd: folder, timeout: 45_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout) => resolve(err ? '' : String(stdout)))
    )
    const r = JSON.parse(out.trim().split('\n').pop() || '{}')
    return r.ok ? { folder, python, level: r.level, model: r.model, device: r.device } : null
  } catch {
    return null
  } finally {
    if (script) rmSync(script, { force: true })
  }
}

/** Transcribes a WAV with Subtitle Maker's engine. Paragraphs start wherever the speaker pauses. */
export function transcribeWithSubtitleMaker(sm: SubtitleMakerInfo, wav: string, language: string, onProgress: (p: number) => void, onStart: (p: ChildProcess) => void): Promise<string> {
  const script = writeScript()
  return new Promise<string>((resolve, reject) => {
    const p = spawn(sm.python, [script, wav, /^[a-z]{2}$/.test(language) ? language : 'auto'], {
      cwd: sm.folder,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    onStart(p)
    const paras: string[] = []
    let cur: string[] = []
    let lastEnd = 0
    let buf = ''
    let err = ''
    p.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('@@')) continue
        try {
          const m = JSON.parse(line.slice(2))
          if (typeof m.text === 'string' && m.text) {
            if (cur.length && m.start - lastEnd > 1.5) {
              paras.push(cur.join(' '))
              cur = []
            }
            cur.push(m.text)
            lastEnd = m.end
            onProgress(m.progress)
          }
        } catch {
          /* not one of ours */
        }
      }
    })
    p.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-6000)))
    p.on('error', () => reject(new Error('Subtitle Maker couldn’t start.')))
    p.on('close', (code, signal) => {
      rmSync(script, { force: true })
      if (signal || code === null) return reject(new Error('Transcription cancelled.'))
      if (code !== 0) {
        const why = err.split('\n').map((l) => l.trim()).filter(Boolean).reverse().find((l) => /error|memory|cuda/i.test(l))
        return reject(new Error(why ? `Subtitle Maker stopped: ${why.slice(0, 200)}` : 'Subtitle Maker stopped before it finished.'))
      }
      if (cur.length) paras.push(cur.join(' '))
      resolve(paras.join('\n'))
    })
  })
}
