/**
 * Reads the diagnostics log (src/main/diaglog.ts) to tell how the app's earlier runs ended.
 * A run starts with a "start" line. It ended cleanly if any of its lines is "quit" (Veyra
 * quit normally) or "system shutdown" (Windows signed out, restarted or turned off with
 * Veyra open: Electron skips the quit events then). Anything else ended unexpectedly.
 */
const CLEAN = /^\S+ (quit|system shutdown)(\s|$)/m

export function runEndings(log: string): { badRunsInARow: number; lastEndedBadly: boolean; lastLine: string } {
  const text = log.trimEnd()
  if (!text) return { badRunsInARow: 0, lastEndedBadly: false, lastLine: '' }
  const runs = text.split(/\n(?=\S+ start(?:\s|$))/)
  let badRunsInARow = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (CLEAN.test(runs[i])) break
    badRunsInARow++
  }
  const lastLine = text.slice(text.lastIndexOf('\n') + 1)
  return { badRunsInARow, lastEndedBadly: !CLEAN.test(runs[runs.length - 1] ?? ''), lastLine }
}
