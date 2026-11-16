/**
 * Voice calls: each group has a voice room, like a voice channel. The sound goes straight
 * between the apps (WebRTC, one connection per other person); the group server only says
 * who's in the room and passes the setup messages (server/calls.mjs).
 *
 * The call lives here, outside any screen, so it carries on while you move around the app
 * (the call dock shows it). Each connection is set up with one offer and one answer that
 * carry all their network addresses (no trickle: fewer trips through the server). The person
 * whose username sorts first makes the offer, so two people never offer at once.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { GroupUser } from '@shared/types'
import { GroupCallError, gid, groupCall } from './groups'

export type VoicePerson = GroupUser & { sid: string; joinedAt: number; muted: boolean; deafened: boolean }
export type Link = 'connecting' | 'connected' | 'failed'

export interface CallState {
  groupId: string | null
  groupName: string
  phase: 'idle' | 'joining' | 'connected' | 'reconnecting'
  people: VoicePerson[]
  muted: boolean
  deafened: boolean
  /** Usernames talking right now (you included). */
  speaking: string[]
  links: Record<string, Link>
  /** No microphone (or it was refused): you can still listen. */
  listenOnly: boolean
  me: string
}

const idle: CallState = { groupId: null, groupName: '', phase: 'idle', people: [], muted: false, deafened: false, speaking: [], links: {}, listenOnly: false, me: '' }
let state: CallState = idle
const subs = new Set<() => void>()
const set = (s: Partial<CallState>) => {
  state = { ...state, ...s }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f))
export const useCall = () => useSyncExternalStore(subscribe, () => state)
export const callState = () => state

/** Messages for the screens (the call ended by itself, couldn't connect…). */
const noticeSubs = new Set<(text: string) => void>()
export const onCallNotice = (f: (text: string) => void) => (noticeSubs.add(f), () => void noticeSubs.delete(f))
const notice = (text: string) => noticeSubs.forEach((f) => f(text))

/* ---------- saved choices (this device only) ---------- */
const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}
export const voicePrefs = {
  mic: () => read<string>('veyra.voice.mic', ''),
  speaker: () => read<string>('veyra.voice.speaker', ''),
  volume: (username: string) => read<Record<string, number>>('veyra.voice.volume', {})[username] ?? 1
}

/* ---------- the call ---------- */
interface Peer {
  username: string
  sid: string
  pc: RTCPeerConnection
  audio: HTMLAudioElement
  analyser: AnalyserNode | null
  offerer: boolean
  restarts: number
  downSince: number
  /** When our last offer went out (an answer that never comes gets a new offer). */
  offeredAt: number
}
interface Live {
  groupId: string
  sid: string
  iceServers: RTCIceServer[]
  mic: MediaStream | null
  ctx: AudioContext
  micAnalyser: AnalyserNode | null
  peers: Map<string, Peer>
  ticker: ReturnType<typeof setInterval>
  wantMuted: boolean
  ended: boolean
}
let live: Live | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function openMic(deviceId = voicePrefs.mic()): Promise<MediaStream | null> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio })
  } catch {
    return null
  }
}

function analyse(ctx: AudioContext, stream: MediaStream): AnalyserNode | null {
  try {
    const a = ctx.createAnalyser()
    a.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(a)
    return a
  } catch {
    return null
  }
}
const buf = new Uint8Array(512)
function level(a: AnalyserNode | null): number {
  if (!a) return 0
  a.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < a.fftSize; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / a.fftSize)
}

/** Short sounds for joining, leaving and muting. */
function chime(kind: 'join' | 'leave' | 'mute' | 'unmute' | 'other-join' | 'other-leave') {
  const ctx = live?.ctx
  if (!ctx || state.deafened) return
  const notes: Record<typeof kind, number[]> = {
    join: [523, 784],
    leave: [784, 523],
    'other-join': [659, 880],
    'other-leave': [880, 659],
    mute: [440],
    unmute: [660]
  }
  const t0 = ctx.currentTime
  notes[kind].forEach((f, i) => {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = f
    const t = t0 + i * 0.09
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.08, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + 0.18)
  })
}

const micTrack = () => live?.mic?.getAudioTracks()[0] ?? null

/** Waits until the connection knows its network addresses (at most 3 s), so one message carries them all. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    const timer = setTimeout(done, 3000)
    pc.addEventListener('icegatheringstatechange', check)
  })
}

async function signal(to: Peer, data: unknown) {
  if (!live) return
  try {
    await groupCall('POST', '/voice/signal', { to: to.username, toSid: to.sid, sid: live.sid, data })
  } catch {
    /* they left, or the server is restarting: the room update sorts it out */
  }
}

function setLink(username: string, link: Link | null) {
  const links = { ...state.links }
  if (link) links[username] = link
  else delete links[username]
  set({ links })
}

function makePeer(username: string, sid: string): Peer {
  const l = live!
  const pc = new RTCPeerConnection({ iceServers: l.iceServers })
  const audio = new Audio()
  audio.autoplay = true
  audio.volume = Math.min(1, voicePrefs.volume(username))
  audio.muted = state.deafened
  const speaker = voicePrefs.speaker()
  if (speaker && 'setSinkId' in audio) void (audio as any).setSinkId(speaker).catch(() => {})
  const peer: Peer = { username, sid, pc, audio, analyser: null, offerer: state.me < username, restarts: 0, downSince: 0, offeredAt: 0 }
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track])
    audio.srcObject = stream
    void audio.play().catch(() => {})
    peer.analyser = analyse(l.ctx, stream)
  }
  pc.onconnectionstatechange = () => {
    if (live !== l || l.peers.get(username) !== peer) return
    const s = pc.connectionState
    if (s === 'connected') {
      peer.restarts = 0
      peer.downSince = 0
      setLink(username, 'connected')
    } else if (s === 'failed') {
      // Try new network paths a few times (the offerer starts it), then give up on this person.
      if (peer.offerer && peer.restarts < 3) {
        peer.restarts++
        setLink(username, 'connecting')
        void offer(peer, true)
      } else if (!peer.offerer) setLink(username, 'connecting')
      else setLink(username, 'failed')
    } else if (s === 'disconnected') {
      peer.downSince = Date.now()
      setLink(username, 'connecting')
    }
  }
  l.peers.set(username, peer)
  setLink(username, 'connecting')
  return peer
}

function dropPeer(username: string) {
  const p = live?.peers.get(username)
  if (!p) return
  live!.peers.delete(username)
  p.pc.close()
  p.audio.srcObject = null
  setLink(username, null)
}

/** Adds what you send (your microphone, or nothing if you're listening only). */
function addOurAudio(pc: RTCPeerConnection, t?: RTCRtpTransceiver) {
  const track = micTrack()
  const tr = t ?? pc.addTransceiver('audio', { direction: 'sendrecv', streams: live?.mic ? [live.mic] : [] })
  tr.direction = 'sendrecv'
  void tr.sender.replaceTrack(track)
}

async function offer(peer: Peer, restart = false) {
  const { pc } = peer
  try {
    if (!pc.getTransceivers().length) addOurAudio(pc)
    peer.offeredAt = Date.now()
    await pc.setLocalDescription(await pc.createOffer(restart ? { iceRestart: true } : undefined))
    await gathered(pc)
    if (live?.peers.get(peer.username) !== peer) return
    await signal(peer, { kind: 'offer', sdp: pc.localDescription!.sdp })
  } catch {
    setLink(peer.username, 'failed')
  }
}

async function onSignal(from: string, fromSid: string, data: any) {
  const l = live
  if (!l || !data) return
  let peer = l.peers.get(from)
  if (peer && peer.sid !== fromSid) {
    dropPeer(from)
    peer = undefined
  }
  if (data.kind === 'offer') {
    if (!peer) peer = makePeer(from, fromSid)
    const { pc } = peer
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      const tr = pc.getTransceivers()[0]
      if (tr) addOurAudio(pc, tr)
      await pc.setLocalDescription(await pc.createAnswer())
      await gathered(pc)
      if (live?.peers.get(from) !== peer) return
      await signal(peer, { kind: 'answer', sdp: pc.localDescription!.sdp })
    } catch {
      setLink(from, 'failed')
    }
  } else if (data.kind === 'answer' && peer && peer.pc.signalingState === 'have-local-offer') {
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
    } catch {
      setLink(from, 'failed')
    }
  }
}

/** Matches the connections to who's in the room. */
function reconcile(people: VoicePerson[]) {
  const l = live
  if (!l) return
  const before = new Set(state.people.map((p) => p.username))
  const here = new Map(people.filter((p) => p.username !== state.me).map((p) => [p.username, p]))
  for (const [u, p] of l.peers) if (!here.has(u) || here.get(u)!.sid !== p.sid) dropPeer(u)
  for (const [u, p] of here) {
    if (l.peers.has(u)) continue
    // The offerer starts; the other side waits for the offer (and makes its connection then).
    if (state.me < u) void offer(makePeer(u, p.sid))
  }
  if (state.phase === 'connected') {
    if (people.some((p) => !before.has(p.username))) chime('other-join')
    else if ([...before].some((u) => !people.some((p) => p.username === u))) chime('other-leave')
  }
  const links = Object.fromEntries(Object.entries(state.links).filter(([u]) => here.has(u)))
  for (const u of here.keys()) if (!links[u]) links[u] = 'connecting'
  set({ people, links })
}

/** Who's talking, about 8 times a second; connections stuck "disconnected" get new network paths. */
function tick() {
  const l = live
  if (!l) return
  const talking: string[] = []
  if (!state.muted && level(l.micAnalyser) > 0.035) talking.push(state.me)
  for (const p of l.peers.values()) {
    if (!state.deafened && level(p.analyser) > 0.02) talking.push(p.username)
    if (p.downSince && Date.now() - p.downSince > 6000 && p.offerer && p.restarts < 3) {
      p.downSince = 0
      p.restarts++
      void offer(p, true)
    } else if (p.offerer && p.offeredAt && p.pc.signalingState === 'have-local-offer' && Date.now() - p.offeredAt > 12000 && p.restarts < 5) {
      // No answer (lost while the server restarted?): offer again.
      p.restarts++
      void offer(p, true)
    }
  }
  // Talking stays lit a moment after the sound stops, so it doesn't flicker.
  const now = Date.now()
  for (const u of talking) lastTalk.set(u, now)
  const lit = [...lastTalk].filter(([, t]) => now - t < 350).map(([u]) => u).sort()
  if (lit.join() !== state.speaking.join()) set({ speaking: lit })
}
const lastTalk = new Map<string, number>()

async function listen(l: Live) {
  let fails = 0
  while (live === l && !l.ended) {
    try {
      const r = await groupCall<{ messages: any[] }>('GET', `/poll/voice?sid=${encodeURIComponent(l.sid)}`)
      if (live !== l) return
      fails = 0
      if (state.phase !== 'connected') set({ phase: 'connected' })
      for (const m of r.messages) {
        if (m.type === 'room' && m.groupId === l.groupId) reconcile(m.people)
        else if (m.type === 'signal') void onSignal(m.from, m.fromSid, m.data)
        else if (m.type === 'ended') {
          if (m.reason === 'elsewhere') {
            notice('You joined this voice room on another device.')
            return end(false)
          }
          if (m.reason === 'removed') {
            notice('You’re no longer in this group.')
            return end(false)
          }
          // The server dropped us (it restarted, or we were away too long): join again.
          return void rejoin(l)
        }
      }
    } catch (e) {
      if (live !== l) return
      fails++
      if (e instanceof GroupCallError && e.status === 404) {
        notice('Voice needs a newer group server.')
        return end(false)
      }
      // Refused outright (not a dropout): stop instead of spinning on "Reconnecting…".
      if (e instanceof GroupCallError && e.status === 400) {
        notice(`Voice couldn’t connect: ${e.message}`)
        return end(true)
      }
      set({ phase: 'reconnecting' })
      await sleep(Math.min(8000, 1000 * fails))
    }
  }
}

async function rejoin(l: Live) {
  set({ phase: 'reconnecting' })
  for (let i = 0; live === l; i++) {
    try {
      const r = await groupCall('POST', `/groups/${gid(l.groupId)}/voice/join`)
      if (live !== l) return
      for (const u of [...l.peers.keys()]) dropPeer(u)
      l.sid = r.sid
      l.iceServers = r.iceServers
      set({ people: [] })
      reconcile(r.people)
      if (state.muted || state.deafened) void sendState()
      return void listen(l)
    } catch (e) {
      if (e instanceof GroupCallError && (e.status === 404 || e.status === 409)) {
        notice(e.message)
        return end(false)
      }
      await sleep(Math.min(10000, 1500 * (i + 1)))
    }
  }
}

function sendState() {
  const l = live
  if (!l) return Promise.resolve()
  return groupCall('PATCH', `/groups/${gid(l.groupId)}/voice/state`, { muted: state.muted, deafened: state.deafened }).catch(() => {})
}

/** Joins a group's voice room (leaving any other). */
export async function joinVoice(group: { id: string; name: string }, me: string): Promise<void> {
  if (state.groupId === group.id && state.phase !== 'idle') return
  if (live) await end(true)
  set({ ...idle, groupId: group.id, groupName: group.name, phase: 'joining', me })
  const ctx = new AudioContext()
  void ctx.resume()
  const mic = await openMic()
  if (state.groupId !== group.id) return void ctx.close()
  let r: { sid: string; people: VoicePerson[]; iceServers: RTCIceServer[] }
  try {
    r = await groupCall('POST', `/groups/${gid(group.id)}/voice/join`)
  } catch (e) {
    mic?.getTracks().forEach((t) => t.stop())
    void ctx.close()
    if (state.groupId === group.id) set(idle)
    throw e
  }
  if (state.groupId !== group.id) {
    mic?.getTracks().forEach((t) => t.stop())
    void ctx.close()
    void groupCall('POST', `/groups/${gid(group.id)}/voice/leave`, { sid: r.sid }).catch(() => {})
    return
  }
  live = { groupId: group.id, sid: r.sid, iceServers: r.iceServers, mic, ctx, micAnalyser: mic ? analyse(ctx, mic) : null, peers: new Map(), ticker: setInterval(tick, 120), wantMuted: false, ended: false }
  set({ listenOnly: !mic, muted: !mic })
  if (!mic) {
    notice('Veyra can’t use a microphone, so you’re listening only. Check your microphone and its permission, then join again.')
    void sendState()
  }
  reconcile(r.people)
  set({ phase: 'connected' })
  chime('join')
  void listen(live)
}

/** Leaves the call. */
export async function leaveVoice(): Promise<void> {
  await end(true)
}

async function end(tellServer: boolean) {
  const l = live
  if (!l) return set(idle)
  chime('leave')
  l.ended = true
  live = null
  clearInterval(l.ticker)
  for (const p of l.peers.values()) {
    p.pc.close()
    p.audio.srcObject = null
  }
  l.mic?.getTracks().forEach((t) => t.stop())
  setTimeout(() => void l.ctx.close().catch(() => {}), 400)
  lastTalk.clear()
  set(idle)
  if (tellServer) await groupCall('POST', `/groups/${gid(l.groupId)}/voice/leave`, { sid: l.sid }).catch(() => {})
}

export function setMuted(muted: boolean) {
  if (!live || state.listenOnly) return
  const t = micTrack()
  if (t) t.enabled = !muted
  // Unmuting while deafened turns hearing back on too (as you'd expect).
  const deafened = muted ? state.deafened : false
  if (!deafened) for (const p of live.peers.values()) p.audio.muted = false
  set({ muted, deafened })
  chime(muted ? 'mute' : 'unmute')
  void sendState()
}

export function setDeafened(deafened: boolean) {
  if (!live) return
  if (deafened) live.wantMuted = state.muted
  for (const p of live.peers.values()) p.audio.muted = deafened
  // Deafened means not talking either; undeafening goes back to how your microphone was.
  const muted = deafened ? true : state.listenOnly || live.wantMuted
  const t = micTrack()
  if (t) t.enabled = !muted
  set({ deafened, muted })
  chime(deafened ? 'mute' : 'unmute')
  void sendState()
}

export function setVolume(username: string, v: number) {
  const all = read<Record<string, number>>('veyra.voice.volume', {})
  all[username] = v
  write('veyra.voice.volume', all)
  const p = live?.peers.get(username)
  if (p) p.audio.volume = Math.min(1, v)
}

/** Switches microphone (during a call too). */
export async function setMic(deviceId: string) {
  write('veyra.voice.mic', deviceId)
  const l = live
  if (!l) return
  const mic = await openMic(deviceId)
  if (!mic || live !== l) return void mic?.getTracks().forEach((t) => t.stop())
  const track = mic.getAudioTracks()[0]
  track.enabled = !state.muted
  for (const p of l.peers.values()) for (const s of p.pc.getSenders()) if (!s.track || s.track.kind === 'audio') void s.replaceTrack(track)
  l.mic?.getTracks().forEach((t) => t.stop())
  l.mic = mic
  l.micAnalyser = analyse(l.ctx, mic)
  if (state.listenOnly) {
    set({ listenOnly: false, muted: false })
    track.enabled = true
    void sendState()
  }
}

export function setSpeaker(deviceId: string) {
  write('veyra.voice.speaker', deviceId)
  for (const p of live?.peers.values() ?? []) if ('setSinkId' in p.audio) void (p.audio as any).setSinkId(deviceId).catch(() => {})
}

export async function audioDevices(): Promise<{ mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  return { mics: all.filter((d) => d.kind === 'audioinput'), speakers: all.filter((d) => d.kind === 'audiooutput') }
}
export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** How loud your microphone is right now (0–1), for the level meter in voice settings. */
export const micLevel = () => (live && !state.muted ? Math.min(1, level(live.micAnalyser) * 6) : 0)

// Closing the app or the page: leave straight away (otherwise the server notices after ~35 s).
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void (live && end(true)))

/* ---------- who's in voice in each of your groups ---------- */
let rooms: Record<string, VoicePerson[]> = {}
let roomsSupported = true
const roomSubs = new Set<() => void>()
let loading: Promise<void> | null = null
let again = false
async function loadRooms() {
  if (loading) {
    again = true
    return loading
  }
  loading = (async () => {
    do {
      again = false
      try {
        const r = await groupCall<{ rooms: Record<string, VoicePerson[]> }>('GET', '/voice/rooms')
        rooms = r.rooms
        roomsSupported = true
      } catch (e) {
        if (e instanceof GroupCallError && e.status === 404) roomsSupported = false
      }
      roomSubs.forEach((f) => f())
    } while (again)
    loading = null
  })()
  return loading
}
let timer: ReturnType<typeof setTimeout> | null = null
window.veyra.group.onChanged(() => {
  if (!roomSubs.size) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void loadRooms(), 150)
})

/** Who's in each group's voice room (kept up to date while a screen shows it). */
export function useVoiceRooms(): { rooms: Record<string, VoicePerson[]>; supported: boolean } {
  const snap = useSyncExternalStore(
    (f) => {
      roomSubs.add(f)
      return () => void roomSubs.delete(f)
    },
    () => rooms
  )
  useEffect(() => {
    void loadRooms()
  }, [])
  // Your own room comes from the call itself (it's quicker).
  const call = useCall()
  const merged = call.groupId && call.people.length ? { ...snap, [call.groupId]: call.people } : snap
  return { rooms: merged, supported: roomsSupported }
}
