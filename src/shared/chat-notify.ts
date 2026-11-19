import type { Group, GroupItem } from './types'

export interface ChatNotice {
  groupId: string
  groupName: string
  title: string
  body: string
  count: number
  isDm: boolean
}

export interface ChatNotifierDeps {
  call: <T = unknown>(method: 'GET', path: string) => Promise<T>
  meId: () => string | null
  enabled: () => boolean
  /** True when the app window is visible, not minimized, and focused (suppresses desktop alerts). */
  isWindowActive: () => boolean
  /** Optional privacy predicate; returning false suppresses notifications for that group/DM. */
  allowGroup?: (group: Group) => boolean
  notify: (notice: ChatNotice) => void
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

const RECENT_NEW_GROUP_MS = 5 * 60_000
const MAX_BODY_LEN = 140
const DM_NAME_RE = /^DM(?:\s*·\s*|:)@([a-z0-9_.-]+)(?:\s*·\s*|:)@([a-z0-9_.-]+)$/i

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Sent a message'
  return clean.length > MAX_BODY_LEN ? `${clean.slice(0, MAX_BODY_LEN - 1)}…` : clean
}

function senderName(group: Group, username: string): string {
  const m = group.members.find((x) => x.username === username)
  if (!m) return username ? `@${username}` : 'Someone'
  return m.displayName?.trim() || (m.username ? `@${m.username}` : 'Someone')
}

export function formatChatNotice(group: Group, messages: GroupItem<'message'>[]): ChatNotice {
  const last = messages[messages.length - 1]
  const who = senderName(group, last.createdBy)
  const preview = clip(last.data?.text ?? '')
  const taggedDm = DM_NAME_RE.test(group.name.trim())
  const isDm = taggedDm || group.members.length <= 2
  if (messages.length === 1) {
    return {
      groupId: group.id,
      groupName: group.name,
      title: isDm ? who : `${who} · ${group.name}`,
      body: preview,
      count: 1,
      isDm: taggedDm
    }
  }
  return {
    groupId: group.id,
    groupName: group.name,
    title: isDm ? who : group.name,
    body: isDm ? `${messages.length} new messages — ${preview}` : `${messages.length} new messages — ${who}: ${preview}`,
    count: messages.length,
    isDm: taggedDm
  }
}

/**
 * Watches group/DM chat updates and triggers desktop notifications when the app is unfocused
 * or minimized. Pure logic with injected transport and notifier so it runs in Electron main,
 * the web renderer, and unit tests.
 */
export class ChatNotifier {
  private seenSeq = new Map<string, number>()
  private seeded = false
  private wasEnabled = false
  private busy = false
  private again = false
  private disposed = false
  private deps: ChatNotifierDeps
  private startedAt: number

  constructor(deps: ChatNotifierDeps) {
    this.deps = deps
    this.startedAt = (deps.now ?? Date.now)()
  }

  /** Hook into GroupCore emit events (`group:status` and `group:changed`). */
  onEvent(channel: 'group:status' | 'group:changed', payload: unknown): void {
    if (this.disposed) return
    if (channel === 'group:status') {
      const s = payload as { state?: string } | null
      if (s?.state === 'online' && (!this.seeded || !this.wasEnabled)) {
        void this.check()
      }
      return
    }
    if (channel === 'group:changed') {
      const p = payload as { voice?: boolean } | null
      if (p?.voice) return
      void this.check()
    }
  }

  /** Call when the user toggles the setting so enabling seeds silently right away. */
  onSettingsChanged(): void {
    if (this.disposed) return
    if (!this.deps.enabled()) {
      this.wasEnabled = false
      return
    }
    if (!this.seeded || !this.wasEnabled) void this.check()
  }

  reset(): void {
    this.seenSeq.clear()
    this.seeded = false
    this.wasEnabled = false
    this.startedAt = (this.deps.now ?? Date.now)()
  }

  dispose(): void {
    this.disposed = true
    this.seenSeq.clear()
  }

  async check(): Promise<void> {
    if (this.disposed) return
    if (!this.deps.enabled()) {
      this.wasEnabled = false
      return
    }
    if (this.busy) {
      this.again = true
      return
    }
    this.busy = true
    try {
      do {
        this.again = false
        if (this.disposed || !this.deps.enabled()) {
          this.wasEnabled = false
          return
        }
        await this.runOnce()
      } while (this.again && !this.disposed)
    } finally {
      this.busy = false
    }
  }

  private async runOnce(): Promise<void> {
    const me = this.deps.meId()
    if (!me) return
    let groups: Group[]
    try {
      const r = await this.deps.call<{ groups: Group[] }>('GET', '/groups')
      groups = Array.isArray(r?.groups) ? r.groups : []
    } catch {
      return
    }

    const silentSeed = !this.seeded || !this.wasEnabled
    const now = (this.deps.now ?? Date.now)()
    const liveIds = new Set(groups.map((g) => g.id))
    for (const id of [...this.seenSeq.keys()]) {
      if (!liveIds.has(id)) this.seenSeq.delete(id)
    }

    for (const group of groups) {
      if (this.disposed) return
      const prev = this.seenSeq.get(group.id)
      const since = prev ?? 0
      let res: { items: GroupItem[]; seq: number }
      try {
        res = await this.deps.call<{ items: GroupItem[]; seq: number }>(
          'GET',
          `/groups/${encodeURIComponent(group.id)}/items?since=${since}`
        )
      } catch {
        continue
      }
      const items = Array.isArray(res?.items) ? res.items : []
      let maxSeq = Math.max(since, typeof res?.seq === 'number' ? res.seq : 0)
      for (const it of items) {
        if (typeof it.seq === 'number' && it.seq > maxSeq) maxSeq = it.seq
      }
      this.seenSeq.set(group.id, maxSeq)

      if (silentSeed) continue

      const fresh = items
        .filter((it): it is GroupItem<'message'> => {
          if (it.kind !== 'message' || it.deleted) return false
          if (it.rev !== 1) return false
          if (it.createdBy === me) return false
          if (prev !== undefined) return it.seq > prev
          // Brand-new group discovered after initial seed: only alert on recent messages so
          // joining an older group never floods desktop notifications with history.
          const ts = typeof it.createdAt === 'number' ? it.createdAt : it.updatedAt
          return typeof ts === 'number' && ts >= this.startedAt && now - ts <= RECENT_NEW_GROUP_MS
        })
        .sort((a, b) => a.seq - b.seq)

      if (
        fresh.length > 0 &&
        !this.deps.isWindowActive() &&
        this.deps.enabled() &&
        (!this.deps.allowGroup || this.deps.allowGroup(group))
      ) {
        this.deps.notify(formatChatNotice(group, fresh))
      }
    }

    this.seeded = true
    this.wasEnabled = true
  }
}
