/** Note history's thinning rules (lib/history.ts), on their own so tests can run them. */
const HOUR = 3_600_000
const DAY = 24 * HOUR
export const MAX_PER_NOTE = 50

/** Which versions to keep, newest first (the rest go). */
export function toKeep(list: { id: string; at: number }[], now = Date.now()): Set<string> {
  const keep = new Set<string>()
  const seen = new Set<string>()
  for (const v of [...list].sort((a, b) => b.at - a.at)) {
    const age = now - v.at
    const slot = age < DAY ? `v:${v.id}` : age < 7 * DAY ? `h:${Math.floor(v.at / HOUR)}` : age < 30 * DAY ? `d:${Math.floor(v.at / DAY)}` : `w:${Math.floor(v.at / (7 * DAY))}`
    if (seen.has(slot)) continue
    seen.add(slot)
    if (keep.size < MAX_PER_NOTE) keep.add(v.id)
  }
  return keep
}
