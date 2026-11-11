import { useEffect, useState } from 'react'
import { Mic, Pause, Play, Square, Trash2 } from 'lucide-react'
import type { VoiceModel, VoiceProgress, VoiceStatus } from '@shared/types'
import { Bar, Dialog } from '../ui'
import { cleanVoiceError, pauseRecording, registerVoiceSetup, stopRecording, watchRecorder, type RecorderState } from '../../data/voice'
import { useSettings } from '../../data/settings'

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The bar shown while recording: time, level, pause, stop, discard. */
export function RecorderBar() {
  const [s, setS] = useState<RecorderState | null>(null)
  const [, tick] = useState(0)
  useEffect(() => watchRecorder(setS), [])
  useEffect(() => {
    if (!s || s.phase !== 'recording') return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [s?.phase]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null
  const elapsed = s.banked + (s.phase === 'recording' ? Date.now() - s.started : 0)
  return (
    <div className="rec-bar" role="status" aria-label="Recording">
      <span className={`rec-dot ${s.phase === 'recording' ? 'on' : ''}`} />
      <b className="num">{clock(elapsed)}</b>
      <span className="rec-level" aria-hidden="true">
        <i style={{ transform: `scaleX(${Math.min(1, s.level * 2.2)})` }} />
      </span>
      {s.phase === 'saving' ? (
        <span className="sm dim">Saving…</span>
      ) : (
        <>
          <button className="iconbtn plain" onClick={pauseRecording} aria-label={s.phase === 'paused' ? 'Resume' : 'Pause'} title={s.phase === 'paused' ? 'Resume' : 'Pause'}>
            {s.phase === 'paused' ? <Play size={16} /> : <Pause size={16} />}
          </button>
          <button className="btn sm" onClick={() => stopRecording()} title="Stop and put it in the note">
            <Square size={13} /> Stop
          </button>
          <button className="iconbtn plain" onClick={() => stopRecording(true)} aria-label="Discard recording" title="Discard">
            <Trash2 size={15} />
          </button>
        </>
      )}
    </div>
  )
}

/** Asks before downloading the transcription engine and model, and shows the download. */
export function VoiceSetupHost() {
  const { s, set } = useSettings()
  const [ask, setAsk] = useState<{ model: VoiceModel; done: (ok: boolean) => void } | null>(null)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [model, setModel] = useState<VoiceModel>('base')
  const [progress, setProgress] = useState<VoiceProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(
    () =>
      registerVoiceSetup(
        (m) =>
          new Promise<boolean>((done) => {
            setModel(m)
            setError('')
            setProgress(null)
            void window.veyra.voice.status().then(setStatus)
            setAsk({ model: m, done })
          })
      ),
    []
  )
  useEffect(() => window.veyra.voice.onProgress(setProgress), [])
  if (!ask || !status) return null

  const close = (ok: boolean) => {
    if (progress && progress.step !== 'done' && !error) void window.veyra.voice.cancelSetup()
    ask.done(ok)
    setAsk(null)
  }
  const go = async () => {
    setError('')
    setProgress({ step: status.engine ? 'model' : 'engine', progress: 0, detail: 'Starting' })
    try {
      await window.veyra.voice.setup(model)
      if (model !== s.voiceModel) set({ voiceModel: model })
      ask.done(true)
      setAsk(null)
    } catch (e) {
      setError(cleanVoiceError(e, 'The download didn’t finish.'))
      setProgress(null)
    }
  }
  const choice = status.choices.find((c) => c.id === model)
  const engineMB = status.engine ? 0 : 9
  const busy = !!progress && !error

  return (
    <Dialog title="Turn on transcription" onClose={() => close(false)} width={480}>
      <p className="sm dim" style={{ marginTop: 0 }}>
        Veyra turns recordings into text on this computer, with no account and nothing sent anywhere. It needs a one-time download of about {(choice?.sizeMB ?? 0) + engineMB} MB.
      </p>
      <div className="voice-choices" role="radiogroup" aria-label="Transcription model">
        {status.choices.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={model === c.id} disabled={busy} className="voice-choice" onClick={() => setModel(c.id)}>
            <b>
              {c.label} <span className="xs dim">{c.sizeMB} MB{status.models.includes(c.id) ? ' · downloaded' : ''}</span>
            </b>
            <span className="sm dim">{c.why}</span>
          </button>
        ))}
      </div>
      {progress && !error && (
        <div style={{ marginTop: 14 }}>
          <div className="between sm" style={{ marginBottom: 6 }}>
            <span>{progress.step === 'engine' ? 'Downloading the engine' : progress.step === 'unpack' ? 'Unpacking' : progress.step === 'model' ? 'Downloading the model' : 'Ready'}</span>
            <span className="dim num">{progress.detail}</span>
          </div>
          <Bar pct={Math.round((progress.progress ?? 0) * 100)} />
        </div>
      )}
      {error && <p className="welcome-err">{error}</p>}
      <div className="actions row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn sec" onClick={() => close(false)}>
          Cancel
        </button>
        <button className="btn" disabled={busy} onClick={go}>
          <Mic size={15} /> {busy ? 'Downloading…' : 'Download and transcribe'}
        </button>
      </div>
    </Dialog>
  )
}
