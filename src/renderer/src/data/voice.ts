import type { Editor } from '@tiptap/core'
import type { Attachment, VoiceModel } from '@shared/types'
import { withDefaults } from '@shared/settings'

const api = window.veyra.voice
export const cleanVoiceError = (e: unknown, fallback = 'Something went wrong.') =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

async function voiceSettings() {
  const rec = (await window.veyra.db.list('settings'))[0]
  return withDefaults(rec?.data ?? {})
}

/* ---------- first-time setup (the dialog lives in VoiceSetupHost) ---------- */
type SetupRequest = (model: VoiceModel) => Promise<boolean>
let setupHost: SetupRequest | null = null
export const registerVoiceSetup = (fn: SetupRequest) => {
  setupHost = fn
  return () => {
    if (setupHost === fn) setupHost = null
  }
}

/** Makes sure the engine and the chosen model are downloaded (asking first). */
export async function ensureVoice(model: VoiceModel): Promise<boolean> {
  const st = await api.status()
  if (st.subtitleMaker || (st.engine && st.models.includes(model))) return true
  return setupHost ? setupHost(model) : false
}

/* ---------- transcription progress, per attachment ---------- */
export interface TranscribeState {
  running: boolean
  progress: number | null
  error: string
}
const states = new Map<string, TranscribeState>()
const subs = new Map<string, Set<(s: TranscribeState | undefined) => void>>()
const setState = (id: string, s: TranscribeState | undefined) => {
  if (s) states.set(id, s)
  else states.delete(id)
  subs.get(id)?.forEach((f) => f(s))
}
export function watchTranscription(id: string, f: (s: TranscribeState | undefined) => void): () => void {
  if (!subs.has(id)) subs.set(id, new Set())
  subs.get(id)!.add(f)
  f(states.get(id))
  return () => void subs.get(id)?.delete(f)
}
api.onTranscribing(({ id, progress }) => {
  const s = states.get(id)
  if (s?.running) setState(id, { ...s, progress })
})

/** Any audio the browser can play → 16 kHz mono 16-bit WAV, which whisper.cpp reads. */
export async function toWav16k(data: ArrayBuffer): Promise<Uint8Array> {
  const ctx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await ctx.decodeAudioData(data)
  } finally {
    void ctx.close()
  }
  const rate = 16000
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const pcm = (await off.startRendering()).getChannelData(0)
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  out.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, rate, true)
  out.setUint32(28, rate * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  str(36, 'data')
  out.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true)
  return new Uint8Array(out.buffer)
}

/**
 * Transcribes an audio attachment and puts the text in a "Transcript"
 * toggle right after it. `pos` finds the attachment's place in the note.
 */
export async function transcribeInto(editor: Editor, pos: () => number | undefined, file: Attachment): Promise<void> {
  if (states.get(file.id)?.running) return
  const s = await voiceSettings()
  if (!(await ensureVoice(s.voiceModel))) return
  setState(file.id, { running: true, progress: null, error: '' })
  try {
    const raw = await window.veyra.files.read(file.id)
    const wav = await toWav16k(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
    const text = await api.transcribe(file.id, wav, s.voiceModel, s.voiceLanguage)
    const at = pos()
    if (editor.isDestroyed || at === undefined) {
      setState(file.id, undefined)
      return
    }
    const node = editor.state.doc.nodeAt(at)
    const after = at + (node?.nodeSize ?? 1)
    const paras = (text || '(Nothing was heard in this recording.)')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))
    editor
      .chain()
      .insertContentAt(after, {
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: `Transcript · ${file.name}` }] },
          { type: 'detailsContent', content: paras }
        ]
      })
      .run()
    setState(file.id, undefined)
  } catch (e) {
    setState(file.id, { running: false, progress: null, error: cleanVoiceError(e, 'Transcription failed.') })
  }
}

export const cancelTranscription = (id: string) => api.cancel(id)

/* ---------- recording (the bar lives in RecorderBar) ---------- */
export interface RecorderState {
  phase: 'recording' | 'paused' | 'saving'
  started: number
  /** Milliseconds recorded before the current stretch (pauses don't count). */
  banked: number
  level: number
  /** The microphone in use (its name). */
  mic: string
  /** Nothing has been heard for a while (a muted or idle microphone, say Camo with no phone). */
  quiet: boolean
}
let rec: {
  editor: Editor
  pos: number
  media: MediaRecorder
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  dest: MediaStreamAudioDestinationNode
  chunks: Blob[]
  ctx: AudioContext
  lastHeard: number
  everHeard: boolean
  raf: number
  state: RecorderState
  discard: boolean
} | null = null
const recSubs = new Set<(s: RecorderState | null) => void>()
const emitRec = () => recSubs.forEach((f) => f(rec ? { ...rec.state } : null))
export function watchRecorder(f: (s: RecorderState | null) => void): () => void {
  recSubs.add(f)
  f(rec ? { ...rec.state } : null)
  return () => void recSubs.delete(f)
}

/** A message for the person; long ones stay up longer, with an OK button. */
type Report = (msg: string, long?: boolean) => void
let report: Report = () => {}
export const onVoiceMessage = (r: Report) => {
  report = r
  return () => {
    if (report === r) report = () => {}
  }
}

/** The computer's microphones (names show once Veyra has used the microphone). */
export async function microphones(): Promise<{ id: string; label: string }[]> {
  const list = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  return list
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}
const openMic = (id: string) =>
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, ...(id ? { deviceId: { exact: id } } : {}) } })
const micName = (s: MediaStream) => s.getAudioTracks()[0]?.label || 'Microphone'
/** Below this the microphone is sending nothing at all (real rooms are never this quiet). */
const SILENT = 0.004
const QUIET_AFTER = 10_000

export async function startRecording(editor: Editor): Promise<void> {
  if (rec) return report('A recording is already going.')
  const chosen = (await voiceSettings()).voiceMic
  let stream: MediaStream
  try {
    stream = await openMic(chosen)
  } catch {
    try {
      if (!chosen) throw new Error('no microphone')
      stream = await openMic('')
      report('The microphone you picked isn’t connected, so this uses the default one.')
    } catch {
      return report('Veyra can’t use your microphone. Check Windows Settings → Privacy → Microphone.')
    }
  }
  // The microphone goes through the audio graph, so it can be switched mid-recording.
  const ctx = new AudioContext()
  void ctx.resume()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  const dest = ctx.createMediaStreamDestination()
  const source = ctx.createMediaStreamSource(stream)
  source.connect(analyser)
  source.connect(dest)
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  const media = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 })
  const buf = new Uint8Array(analyser.fftSize)
  const r = {
    editor,
    pos: editor.state.selection.to,
    media,
    stream,
    source,
    analyser,
    dest,
    chunks: [] as Blob[],
    ctx,
    lastHeard: Date.now(),
    everHeard: false,
    raf: 0,
    state: { phase: 'recording', started: Date.now(), banked: 0, level: 0, mic: micName(stream), quiet: false } as RecorderState,
    discard: false
  }
  rec = r
  const meter = () => {
    r.analyser.getByteTimeDomainData(buf)
    let peak = 0
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
    const recording = r.state.phase === 'recording'
    if (peak > SILENT) {
      r.lastHeard = Date.now()
      if (recording) r.everHeard = true
    }
    r.state.level = recording ? peak : 0
    r.state.quiet = recording && Date.now() - r.lastHeard > QUIET_AFTER
    emitRec()
    r.raf = requestAnimationFrame(meter)
  }
  meter()
  media.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
  media.onstop = () => void finish(r)
  media.start(1000)
}

/** Changes the microphone, mid-recording too (the recording carries on with the new one). */
export async function switchMic(id: string): Promise<void> {
  const r = rec
  if (!r || r.state.phase === 'saving') return
  let stream: MediaStream
  try {
    stream = await openMic(id)
  } catch {
    return report('That microphone can’t be used right now.')
  }
  if (rec !== r) return void stream.getTracks().forEach((t) => t.stop())
  const source = r.ctx.createMediaStreamSource(stream)
  source.connect(r.analyser)
  source.connect(r.dest)
  r.source.disconnect()
  r.stream.getTracks().forEach((t) => t.stop())
  r.source = source
  r.stream = stream
  r.lastHeard = Date.now()
  r.state = { ...r.state, mic: micName(stream), quiet: false }
  emitRec()
}

export function pauseRecording(): void {
  if (!rec) return
  if (rec.state.phase === 'recording') {
    rec.media.pause()
    rec.state = { ...rec.state, phase: 'paused', banked: rec.state.banked + (Date.now() - rec.state.started) }
  } else if (rec.state.phase === 'paused') {
    rec.media.resume()
    rec.lastHeard = Date.now()
    rec.state = { ...rec.state, phase: 'recording', started: Date.now() }
  }
  emitRec()
}

export function stopRecording(discard = false): void {
  if (!rec || rec.state.phase === 'saving') return
  rec.discard = discard
  rec.state = { ...rec.state, phase: 'saving', banked: rec.state.banked + (rec.state.phase === 'recording' ? Date.now() - rec.state.started : 0) }
  emitRec()
  rec.media.stop()
}

async function finish(r: NonNullable<typeof rec>) {
  cancelAnimationFrame(r.raf)
  r.stream.getTracks().forEach((t) => t.stop())
  void r.ctx.close()
  try {
    if (r.discard || !r.chunks.length) return
    const blob = new Blob(r.chunks, { type: r.media.mimeType || 'audio/webm' })
    const d = new Date()
    const name = `Recording ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(':', '.')}.webm`
    const file = await api.saveRecording(name, 'audio/webm', new Uint8Array(await blob.arrayBuffer()))
    if (r.editor.isDestroyed) return report('The recording was saved, but the note was closed. Attach it from your attachments folder.')
    const at = Math.min(r.pos, r.editor.state.doc.content.size)
    r.editor.chain().insertContentAt(at, { type: 'attachment', attrs: { ...file } }).run()
    // Only silence came in: say so, instead of transcribing nothing.
    if (!r.everHeard)
      return report(`This recording is silent: “${r.state.mic}” sent no sound. Pick another microphone from the recording bar, or in Settings → Notes.`, true)
    const s = await voiceSettings()
    if (s.voiceAutoTranscribe && !document.documentElement.classList.contains('phone')) {
      // Find the node we just put in (its id is unique).
      const pos = () => {
        let found: number | undefined
        r.editor.state.doc.descendants((n, p) => {
          if (found === undefined && n.type.name === 'attachment' && n.attrs.id === file.id) found = p
          return found === undefined
        })
        return found
      }
      void transcribeInto(r.editor, pos, file)
    }
  } catch (e) {
    report(cleanVoiceError(e, 'The recording couldn’t be saved.'))
  } finally {
    if (rec === r) rec = null
    emitRec()
  }
}
