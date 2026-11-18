import { useEffect, useState } from 'react'
import { groupCall } from './groups'
import { applyRemoteChats, chatOwner, clearPending, markAllChats, pendingChats, setChatOwner, type SavedChat } from './agent'

/* =====================================================================
   AI chat sync, end-to-end encrypted. Your devices share one random chat
   key (AES-256-GCM). The Veyra server keeps it only wrapped with a key made
   from your password here (PBKDF2), so neither the server nor its owner can
   read a chat: every chat goes up encrypted, with its id bound in.

   - Signing in (or creating an account) switches it on: the first device
     makes the key; the others unwrap it with the password just typed.
   - Changing your password re-wraps the same key.
   - After a forgotten-password reset, a device that still has the key
     re-wraps it with the new password; one that doesn't can unlock with the
     old password, or start over (a new key: the old synced chats go, and
     each device sends its own copy again).
===================================================================== */

interface ServerKey {
  gen: number
  salt: string
  iter: number
  iv: string
  wrapped: string
  updatedAt: number
}
interface LocalKey {
  gen: number
  key: string
}
export type ChatSyncStatus =
  /** Not signed in, or not set up yet (no key anywhere). */
  | 'off'
  /** The key is on the server but not on this device (or it changed): the password unlocks it. */
  | 'locked'
  | 'on'
  /** The server can't be reached, or is older than chat sync. */
  | 'unavailable'
export interface ChatSyncState {
  status: ChatSyncStatus
  syncing: boolean
  lastSync: number | null
  error: string
}

const ITER = 310_000
const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const WRAP_AAD = enc.encode('veyra-study-chat-key')

async function kek(password: string, salt: string, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function wrap(raw: Uint8Array<ArrayBuffer>, password: string): Promise<Omit<ServerKey, 'gen' | 'updatedAt'>> {
  const salt = b64(random(16))
  const iv = random(12)
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: WRAP_AAD }, await kek(password, salt, ITER), raw)
  return { salt, iter: ITER, iv: b64(iv), wrapped: b64(wrapped) }
}
/** The chat key, or null when the password doesn't open it. */
async function unwrap(k: ServerKey, password: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(k.iv), additionalData: WRAP_AAD }, await kek(password, k.salt, k.iter), unb64(k.wrapped)))
  } catch {
    return null
  }
}
const aes = (raw: string) => crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])

/* ---------- this device's copy of the key (per account) ---------- */
const keyName = () => `veyra.chatKey.${chatOwner()}`
const seqName = (gen: number) => `veyra.chatSync.seq.${chatOwner()}.${gen}`
function localKey(): LocalKey | null {
  try {
    return chatOwner() ? (JSON.parse(localStorage.getItem(keyName()) ?? 'null') as LocalKey | null) : null
  } catch {
    return null
  }
}
function setLocalKey(k: LocalKey | null): void {
  try {
    if (k) localStorage.setItem(keyName(), JSON.stringify(k))
    else localStorage.removeItem(keyName())
  } catch {
    /* storage unavailable */
  }
}
const readSeq = (gen: number) => Number(localStorage.getItem(seqName(gen)) || 0)
const writeSeq = (gen: number, seq: number) => {
  try {
    localStorage.setItem(seqName(gen), String(seq))
  } catch {
    /* storage unavailable */
  }
}

/* ---------- state, for the screens ---------- */
let state: ChatSyncState = { status: 'off', syncing: false, lastSync: null, error: '' }
const listeners = new Set<(s: ChatSyncState) => void>()
const set = (p: Partial<ChatSyncState>) => {
  state = { ...state, ...p }
  listeners.forEach((l) => l(state))
}
export function useChatSync(): ChatSyncState {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    setS(state)
    return () => void listeners.delete(setS)
  }, [])
  return s
}

const getKey = async () => (await groupCall<{ key: ServerKey | null }>('GET', '/chats/key')).key
const putKey = async (mode: 'create' | 'rewrap' | 'reset', w: Omit<ServerKey, 'gen' | 'updatedAt'>, gen?: number) =>
  (await groupCall<{ key: ServerKey }>('PUT', '/chats/key', { mode, ...w, ...(gen ? { gen } : {}) })).key
const unavailable = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  const old = (e as { status?: number })?.status === 404
  set({ status: 'unavailable', error: old ? 'The Veyra server needs an update for chat sync.' : msg || 'Can’t reach the Veyra server.' })
}

/** Where things stand: the server's key against this device's. */
async function check(): Promise<ServerKey | null> {
  const server = await getKey()
  const mine = localKey()
  set({ status: !server ? 'off' : mine && mine.gen === server.gen ? 'on' : 'locked', error: '' })
  return server
}

/** Uses a key: keeps it here, and sends every chat on this device (other devices merge them in). */
async function adopt(raw: Uint8Array<ArrayBuffer>, gen: number) {
  setLocalKey({ gen, key: b64(raw) })
  markAllChats()
  set({ status: 'on', error: '' })
  await syncNow()
}

/**
 * Right after signing in or creating an account, with the password just typed. Never throws: chat
 * sync is a nicety, and signing in must not wait on it or fail because of it.
 */
export async function chatSyncAfterSignIn(username: string, password: string): Promise<void> {
  try {
    setChatOwner(username)
    const server = await getKey()
    const mine = localKey()
    if (!server) {
      const raw = random(32)
      const k = await putKey('create', await wrap(raw, password))
      return void (await adopt(raw, k.gen))
    }
    const raw = await unwrap(server, password)
    if (raw) return void (await adopt(raw, server.gen))
    // The password was reset: this device still has the key, so it's wrapped again with the new one.
    if (mine && mine.gen === server.gen) {
      await putKey('rewrap', await wrap(unb64(mine.key), password), server.gen)
      return void set({ status: 'on', error: '' })
    }
    set({ status: 'locked', error: '' })
  } catch (e) {
    unavailable(e)
  }
}

/** Unlock on this device (Settings), with the password the chats were locked with. */
export async function unlockChats(password: string): Promise<void> {
  const server = await getKey()
  if (!server) {
    const raw = random(32)
    const k = await putKey('create', await wrap(raw, password))
    return adopt(raw, k.gen)
  }
  const raw = await unwrap(server, password)
  if (!raw) throw new Error('That password doesn’t unlock your synced chats. If you reset your password, they’re locked with your old one: enter that, or start over.')
  await adopt(raw, server.gen)
}

/** A new key: the old synced chats are deleted, and this device sends its own again. */
export async function startChatsOver(password: string): Promise<void> {
  const raw = random(32)
  const k = await putKey('reset', await wrap(raw, password))
  await adopt(raw, k.gen)
}

/** After changing your password: the same key, wrapped with the new one. Never throws. */
export async function rewrapChats(newPassword: string): Promise<void> {
  try {
    const mine = localKey()
    if (!mine) return
    const server = await getKey()
    if (server && server.gen === mine.gen) await putKey('rewrap', await wrap(unb64(mine.key), newPassword), mine.gen)
  } catch {
    /* the next sign-in re-wraps it */
  }
}

/** Stops syncing here (the chats stay on this device; the others keep syncing). */
export function turnOffChatsHere(): void {
  setLocalKey(null)
  set({ status: 'locked' })
}

/* ---------- syncing ---------- */
let running: Promise<void> | null = null
export function syncNow(): Promise<void> {
  if (!running)
    running = sync().finally(() => {
      running = null
    })
  return running
}

async function sync(): Promise<void> {
  const mine = localKey()
  if (!mine || !chatOwner()) return
  set({ syncing: true })
  try {
    const key = await aes(mine.key)
    // Send what changed here, a few MB at a time.
    const { put, del, marks } = pendingChats()
    if (put.length || del.length) {
      const items: { id: string; at: number; iv?: string; data?: string; deleted?: boolean }[] = del.map((d) => ({ id: d.id, at: d.at, deleted: true }))
      for (const { id, chat } of put) {
        const iv = random(12)
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(id) }, key, enc.encode(JSON.stringify(chat)))
        items.push({ id, at: chat.at, iv: b64(iv), data: b64(data) })
      }
      let batch: typeof items = []
      let size = 0
      const send = async () => {
        if (batch.length) await groupCall('POST', '/chats/push', { gen: mine.gen, chats: batch })
        batch = []
        size = 0
      }
      for (const it of items) {
        const n = (it.data?.length ?? 0) + 200
        if (batch.length && (size + n > 3_000_000 || batch.length >= 100)) await send()
        batch.push(it)
        size += n
      }
      await send()
      clearPending(marks)
    }
    // Then fetch what your other devices changed.
    for (let more = true; more; ) {
      const page = await groupCall<{ gen: number | null; chats: { id: string; at: number; iv?: string; data?: string; deleted?: boolean }[]; seq: number; more: boolean }>('GET', `/chats/pull?since=${readSeq(mine.gen)}&limit=100`)
      if (page.gen !== mine.gen) {
        set({ status: page.gen ? 'locked' : 'off' })
        return
      }
      const list: Parameters<typeof applyRemoteChats>[0] = []
      for (const c of page.chats) {
        if (c.deleted) list.push({ id: c.id, at: c.at, deleted: true })
        else
          try {
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(c.iv!), additionalData: enc.encode(c.id) }, key, unb64(c.data!))
            list.push({ id: c.id, at: c.at, chat: JSON.parse(dec.decode(plain)) as SavedChat })
          } catch {
            /* not readable with this key: skipped */
          }
      }
      applyRemoteChats(list)
      writeSeq(mine.gen, page.seq)
      more = page.more
    }
    set({ lastSync: Date.now(), error: '' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Another device started over: this one needs the password again.
    if (/key changed|turn on chat sync/i.test(msg)) await check().catch(() => {})
    else set({ error: msg })
  } finally {
    set({ syncing: false })
  }
}

/**
 * Keeps chats in sync while the app is open (signed in): now, every minute, when the window comes
 * back, and a few seconds after a chat changes here.
 */
export function startChatSync(username: string): () => void {
  setChatOwner(username)
  let stopped = false
  let soon: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    if (!stopped && state.status === 'on') void syncNow()
  }
  void check()
    .then(run)
    .catch(unavailable)
  const every = setInterval(() => (state.status === 'unavailable' ? void check().then(run).catch(unavailable) : run()), 60_000)
  const onChats = () => {
    if (soon) clearTimeout(soon)
    soon = setTimeout(() => {
      if (pendingChats().put.length || pendingChats().del.length) run()
    }, 3000)
  }
  window.addEventListener('focus', run)
  window.addEventListener('veyra:chats', onChats)
  return () => {
    stopped = true
    clearInterval(every)
    if (soon) clearTimeout(soon)
    window.removeEventListener('focus', run)
    window.removeEventListener('veyra:chats', onChats)
  }
}
