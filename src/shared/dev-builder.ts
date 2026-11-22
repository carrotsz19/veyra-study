/**
 * The in-app Dev builder (Veyra Study Dev on Windows → Settings → Software update → Build from commits).
 *
 * The app runs the same script as the terminal (`node tools/release.mjs --dev …`) in your local
 * checkout, so the build uses this computer's git, GitHub sign-in (gh) and signing setup. These
 * helpers turn a choice made in the UI into that script's arguments, refusing anything that
 * isn't a plain commit, branch or PR name (the script passes values on to git and npm).
 */

export type DevBuildMode = 'ref' | 'commits'

export interface DevBuildRequest {
  /** 'ref': build one commit, branch, tag or PR as is. 'commits': cherry-pick these onto `base`. */
  mode: DevBuildMode
  ref?: string
  commits?: string[]
  base?: string
  label?: string
  /** Skip the Android APK (it needs the Android SDK on this computer). */
  windowsOnly?: boolean
  /** Also deploy the Dev website from the same selection. */
  web?: boolean
}

export interface DevCandidateCommit {
  sha: string
  full: string
  rel: string
  date: string
  author: string
  deco: string
  subject: string
  merge?: boolean
}
export interface DevCandidateBranch {
  name: string
  sha: string
  rel: string
  subject: string
  remote?: boolean
}
export interface DevCandidatePr {
  number: number
  title: string
  headRefName: string
  author?: string
  updatedAt?: string
}
export interface DevCandidates {
  repoDir: string
  head: string
  defaultBase: string
  commits: DevCandidateCommit[]
  branches: DevCandidateBranch[]
  prs: DevCandidatePr[]
  prError?: string
  error?: string
}

export interface DevPreview {
  kind: DevBuildMode
  ref?: string
  title: string
  base: string
  /** onBase: already contained in the base, so it is skipped. */
  commits: { sha: string; subject: string; stat?: string; onBase?: boolean }[]
  skipped?: number
  aheadCount?: number
  shortstat?: string
  note?: string
  error?: string
}

export type DevJobStatus = 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled'

export interface DevBuildJob {
  id: string
  summary: string
  status: DevJobStatus
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  /** The newest log lines (older ones are dropped). */
  log: string[]
  error?: string
}

export interface DevBuilderState {
  /** The builder works here: Veyra Study Dev on Windows. */
  available: boolean
  repoDir: string
  /** repoDir is a Veyra Study checkout (has .git and tools/dev-select.mjs). */
  repoOk: boolean
  reason?: string
  job: DevBuildJob | null
}

/** Commit SHAs, branch/tag names (feat/x, dev-repo/main, v26.11.4) and PRs (pr#12). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,199}$/
const SHA_RE = /^[0-9a-f]{7,40}$/i

export function isSafeRef(ref: unknown): ref is string {
  const r = String(ref ?? '')
  return REF_RE.test(r) && !r.includes('..') && !r.endsWith('.lock') && !r.endsWith('/') && !r.includes('//')
}

/** A label for the build switcher: one line, no control characters, at most 80 characters. */
export function cleanLabel(label: unknown): string {
  return String(label ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+\s*/, '')
    .slice(0, 80)
    .trim()
}

/** The selection part of the arguments (--ref, or --commits and --base), validated. */
export function selectionArgs(req: DevBuildRequest): string[] {
  if (!req || (req.mode !== 'ref' && req.mode !== 'commits')) throw new Error('Choose a commit, branch or pull request first.')
  if (req.mode === 'ref') {
    if (!isSafeRef(req.ref)) throw new Error('That commit, branch or pull request name isn’t valid.')
    return ['--ref', String(req.ref)]
  }
  const commits = Array.isArray(req.commits) ? req.commits.map((c) => String(c).trim()).filter(Boolean) : []
  if (!commits.length) throw new Error('Select at least one commit to cherry-pick.')
  if (commits.length > 100) throw new Error('Select at most 100 commits.')
  if (!commits.every((c) => SHA_RE.test(c))) throw new Error('Commits must be chosen from the list.')
  if (new Set(commits.map((c) => c.toLowerCase())).size !== commits.length) throw new Error('A commit is selected twice.')
  const args = ['--commits', commits.join(',')]
  if (req.base) {
    if (!isSafeRef(req.base)) throw new Error('That base branch name isn’t valid.')
    args.push('--base', req.base)
  }
  return args
}

/** Arguments for `node <...>` run in the checkout: tools/release.mjs --dev plus the selection. */
export function buildReleaseArgs(req: DevBuildRequest): string[] {
  const args = ['tools/release.mjs', '--dev', ...selectionArgs(req)]
  const label = cleanLabel(req.label)
  if (label) args.push('--label', label)
  if (req.windowsOnly) args.push('--windows-only')
  if (req.web) args.push('--web')
  return args
}

/** One line describing the request, for the job header and the diagnostics log. */
export function describeRequest(req: DevBuildRequest): string {
  const label = cleanLabel(req.label)
  const what =
    req.mode === 'ref'
      ? String(req.ref ?? '').replace(/^pr#?/i, 'PR #')
      : `${req.commits?.length ?? 0} commit${req.commits?.length === 1 ? '' : 's'} onto ${req.base || 'the default base'}`
  return label ? `${label} (${what})` : what
}

/** Removes terminal colour codes and other escapes from a log line. */
export function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '')
}
