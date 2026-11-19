import { useEffect, useRef, useState } from 'react'
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Settings2, Volume2, WifiOff } from 'lucide-react'
import type { Group } from '@shared/types'
import { isDmGroup } from '@shared/dm'
import { getCachedGroup } from '../data/groups'
import { Avatar } from './account'
import { Popover } from './Popover'
import { Select } from './Select'
import { useToast } from './ui'
import {
  audioDevices,
  callState,
  canPickSpeaker,
  joinVoice,
  leaveVoice,
  micLevel,
  onCallNotice,
  setDeafened,
  setMic,
  setMuted,
  setSpeaker,
  setVolume,
  useCall,
  useVoiceRooms,
  voicePrefs,
  type VoicePerson
} from '../data/call'
import { useNav } from '../nav'
import '../voice.css'

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Couldn’t join the voice room. Try again.')

/** Toasts from the call (it ended by itself, no microphone…), wherever you are in the app. */
export function CallNotices() {
  const toast = useToast()
  useEffect(() => onCallNotice((t) => toast(t)), [toast])
  // Ctrl+Shift+M mutes, Ctrl+Shift+D deafens (while the app has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return
      const k = e.key.toLowerCase()
      const s = callState()
      if ((k !== 'm' && k !== 'd') || s.phase === 'idle') return
      e.preventDefault()
      if (k === 'm') setMuted(!s.muted)
      else setDeafened(!s.deafened)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return null
}

/** The voice room on a group's page: who's in, Join, and your controls. */
export function VoiceRoom({ group, me }: { group: Group; me: string }) {
  const call = useCall()
  const { rooms, supported } = useVoiceRooms()
  const toast = useToast()
  const inHere = call.groupId === group.id && call.phase !== 'idle'
  const people = inHere ? call.people : (rooms[group.id] ?? [])
  const [busy, setBusy] = useState(false)

  const join = async () => {
    setBusy(true)
    try {
      await joinVoice(group, me)
    } catch (e) {
      toast(errText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!supported)
    return (
      <div className="card grp-status">
        <WifiOff size={16} /> Voice needs the group server to update. It will work once it has.
      </div>
    )

  return (
    <div className="voice-room">
      <div className="card voice-stage">
        <div className="between voice-stage-head">
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <Volume2 size={17} />
            <b className="trunc">Voice room</b>
            <span className="xs dim">{people.length ? `${people.length} in voice` : 'Nobody’s here yet'}</span>
          </div>
          {inHere ? (
            <span className={`voice-phase ${call.phase}`}>{call.phase === 'joining' ? 'Joining…' : call.phase === 'reconnecting' ? 'Reconnecting…' : 'Connected'}</span>
          ) : null}
        </div>

        {people.length > 0 ? (
          <div className="voice-grid">
            {people.map((p) => (
              <Tile key={p.username} p={p} mine={p.username === me} live={inHere} />
            ))}
          </div>
        ) : (
          <p className="sm dim voice-empty">Talk with your group while you work, like a study call. Everyone in {group.name} can join.</p>
        )}

        <div className="voice-actions">
          {inHere ? (
            <>
              <Controls />
              <button className="btn dan" onClick={() => void leaveVoice()}>
                <PhoneOff size={16} /> Leave
              </button>
            </>
          ) : (
            <button className="btn" onClick={join} disabled={busy || people.length >= 8}>
              <Volume2 size={16} /> {busy ? 'Joining…' : people.length >= 8 ? 'Room is full' : call.groupId ? `Join (leaves ${call.groupName})` : 'Join voice'}
            </button>
          )}
        </div>
      </div>
      <p className="xs dim voice-note">Your voice goes straight to the others in the call, not through Veyra. Voice is off overnight while the group server sleeps.</p>
    </div>
  )
}

function Tile({ p, mine, live }: { p: VoicePerson; mine: boolean; live: boolean }) {
  const call = useCall()
  const talking = live && call.speaking.includes(p.username)
  const link = live && !mine ? call.links[p.username] : undefined
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const [vol, setVol] = useState(() => voicePrefs.volume(p.username))
  return (
    <>
      <button
        ref={ref}
        className={`voice-tile ${talking ? 'talking' : ''} ${link && link !== 'connected' ? 'linking' : ''}`}
        onClick={() => !mine && live && setOpen(true)}
        onContextMenu={(e) => {
          if (mine || !live) return
          e.preventDefault()
          setOpen(true)
        }}
        title={mine || !live ? p.displayName : `${p.displayName}: click to change their volume`}
      >
        <span className="voice-ring">
          <Avatar user={p} large />
        </span>
        <span className="trunc voice-name">{mine ? `${p.displayName} (you)` : p.displayName}</span>
        <span className="voice-icons">
          {p.deafened ? <HeadphoneOff size={13} aria-label="Deafened" /> : p.muted ? <MicOff size={13} aria-label="Muted" /> : null}
        </span>
        {link === 'connecting' && <span className="xs dim">Connecting…</span>}
        {link === 'failed' && (
          <span className="xs voice-bad" title="Your two networks won’t let your devices reach each other directly. Veyra keeps trying; another network (e.g. a phone hotspot) usually works.">
            Can’t connect
          </span>
        )}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label={`${p.displayName}’s volume`} className="voice-pop">
        <div className="sm" style={{ fontWeight: 650, marginBottom: 8 }}>
          {p.displayName}’s volume
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(vol * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100
            setVol(v)
            setVolume(p.username, v)
          }}
          aria-label={`${p.displayName}’s volume`}
          style={{ width: '100%' }}
        />
        <div className="xs dim">{Math.round(vol * 100)}% · only on this device</div>
      </Popover>
    </>
  )
}

/** Mute, deafen and voice settings. */
function Controls({ compact }: { compact?: boolean }) {
  const call = useCall()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <div className={`voice-controls ${compact ? 'compact' : ''}`}>
      <button
        className={`iconbtn ${call.muted ? 'voice-off' : ''}`}
        onClick={() => setMuted(!call.muted)}
        disabled={call.listenOnly}
        title={call.listenOnly ? 'No microphone: listening only' : call.muted ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)'}
        aria-label={call.muted ? 'Unmute' : 'Mute'}
        aria-pressed={call.muted}
      >
        {call.muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button
        className={`iconbtn ${call.deafened ? 'voice-off' : ''}`}
        onClick={() => setDeafened(!call.deafened)}
        title={call.deafened ? 'Undeafen (Ctrl+Shift+D)' : 'Deafen: hear nothing and mute (Ctrl+Shift+D)'}
        aria-label={call.deafened ? 'Undeafen' : 'Deafen'}
        aria-pressed={call.deafened}
      >
        {call.deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
      </button>
      <button ref={ref} className="iconbtn" onClick={() => setOpen(true)} title="Voice settings" aria-label="Voice settings">
        <Settings2 size={16} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} label="Voice settings" className="voice-pop voice-settings">
        {open && <VoiceSettings />}
      </Popover>
    </div>
  )
}

function VoiceSettings() {
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] } | null>(null)
  const [mic, setMicId] = useState(voicePrefs.mic())
  const [micError, setMicError] = useState('')
  const [speaker, setSpeakerId] = useState(voicePrefs.speaker())
  const meter = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    void audioDevices().then(setDevices)
    let raf = 0
    const draw = () => {
      if (meter.current) meter.current.style.width = `${Math.round(micLevel() * 100)}%`
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  const name = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`
  return (
    <div className="voice-settings-body">
      <div className="sm" style={{ fontWeight: 700 }}>
        Voice settings
      </div>
      <label className="xs dim">Microphone</label>
      <Select
        label="Microphone"
        value={mic}
        onChange={(v) => {
          const before = mic
          setMicId(v)
          setMicError('')
          void setMic(v).then((err) => {
            if (!err) return
            setMicId(before)
            setMicError(err)
          })
        }}
        options={[{ value: '', label: 'Default' }, ...(devices?.mics ?? []).filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: name(d, i, 'Microphone') }))]}
      />
      <div className="voice-meter" aria-hidden>
        <span ref={meter} />
      </div>
      {micError && <div className="xs voice-bad">{micError}</div>}
      {canPickSpeaker && (
        <>
          <label className="xs dim">Speaker</label>
          <Select
            label="Speaker"
            value={speaker}
            onChange={(v) => {
              setSpeakerId(v)
              setSpeaker(v)
            }}
            options={[{ value: '', label: 'Default' }, ...(devices?.speakers ?? []).filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: name(d, i, 'Speaker') }))]}
          />
        </>
      )}
      <div className="xs dim">Echo and background noise are filtered out. Headphones work best.</div>
    </div>
  )
}

/** The call bar (bottom of the sidebar, or floating on a phone): where you are, mute, deafen, leave. */
export function CallDock({ floating }: { floating?: boolean }) {
  const call = useCall()
  const { go } = useNav()
  if (call.phase === 'idle' || !call.groupId) return null
  const others = call.people.filter((p) => p.username !== call.me)
  const talking = call.speaking.filter((u) => u !== call.me)
  return (
    <div className={`call-dock ${floating ? 'floating' : ''} ${call.phase}`} role="region" aria-label="Voice call">
      <button
        className="call-where"
        onClick={() => {
          const cached = getCachedGroup(call.groupId!)
          if (cached && isDmGroup(cached)) {
            try {
              localStorage.setItem('veyra.dm', call.groupId!)
            } catch {
              /* storage unavailable */
            }
            go({ name: 'messages', dmId: call.groupId! })
            setTimeout(() => window.dispatchEvent(new CustomEvent('veyra:open-dm-voice', { detail: call.groupId })), 0)
            return
          }
          try {
            localStorage.setItem('veyra.group', call.groupId!)
            localStorage.setItem('veyra.groupTab', 'voice')
          } catch {
            /* storage unavailable */
          }
          go({ name: 'groups' })
          window.dispatchEvent(new CustomEvent('veyra:open-voice', { detail: call.groupId }))
        }}
        title="Open the voice room"
      >
        <span className={`call-dot ${call.phase}`} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="call-state nav-label">{call.phase === 'connected' ? 'Voice connected' : call.phase === 'joining' ? 'Joining…' : 'Reconnecting…'}</span>
          <span className="trunc xs dim nav-label" style={{ display: 'block' }}>
            {call.groupName}
            {others.length ? ` · ${talking.length ? talking.map((u) => call.people.find((p) => p.username === u)?.displayName ?? u).join(', ') + ' talking' : `${others.length} with you`}` : ' · just you'}
          </span>
        </span>
      </button>
      <div className="call-buttons">
        <Controls compact />
        <button className="iconbtn call-hang" onClick={() => void leaveVoice()} title="Leave the call" aria-label="Leave the call">
          <PhoneOff size={16} />
        </button>
      </div>
    </div>
  )
}

/** Little faces of who's in voice (for the list of groups). */
export function VoiceBadge({ groupId }: { groupId: string }) {
  const { rooms } = useVoiceRooms()
  const people = rooms[groupId] ?? []
  if (!people.length) return null
  return (
    <span className="voice-badge" title={`In voice: ${people.map((p) => p.displayName).join(', ')}`}>
      <Volume2 size={12} />
      {people.length}
    </span>
  )
}
