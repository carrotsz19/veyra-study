/**
 * Veyra Study Dev on Windows: build and publish a Dev release from chosen commits, a branch or
 * a pull request, from inside the app (Settings → Software update → Build from commits).
 *
 * It runs the same script as the terminal, `node tools/release.mjs --dev --ref …|--commits …`,
 * in your local checkout (C:\dev\veyra-study unless you pick another folder). That script builds
 * in a temporary git worktree, so the checkout and any uncommitted work are never touched, and
 * publishes with this computer's GitHub sign-in (gh) and signing setup. One build at a time.
 */
import { app, dialog, type BrowserWindow, type WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IS_DEV } from '../shared/channel'
import {
  buildReleaseArgs,
  describeRequest,
  selectionArgs,
  stripAnsi,
  type DevBuildJob,
  type DevBuildRequest,
  type DevBuilderState,
  type DevCandidates,
  type DevPreview
} from '../shared/dev-builder'
import { diag } from './diaglog'

const CONFIG = () => join(app.getPath('userData'), 'dev-builder.json')
const DEFAULT_REPO = 'C:\\dev\\veyra-study'
const MAX_LOG = 4000

const watchers = new Set<WebContents>()
let job: DevBuildJob | null = null
let child: ChildProcess | null = null
let workDir = ''

export const devBuilderAvailable = (): boolean => IS_DEV && process.platform === 'win32'

function readConfig(): { repoDir?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG(), 'utf8')) as { repoDir?: string }
  } catch {
    return {}
  }
}

const isCheckout = (dir: string): boolean => !!dir && existsSync(join(dir, '.git')) && existsSync(join(dir, 'tools', 'dev-select.mjs')) && existsSync(join(dir, 'tools', 'release.mjs'))

/** The checkout builds run in: the folder you chose, else $VEYRA_DEV_REPO, else this code's own checkout (npm run dev), else C:\dev\veyra-study. */
function repoDir(): string {
  const chosen = readConfig().repoDir
  if (chosen) return resolve(chosen)
  if (process.env['VEYRA_DEV_REPO']) return resolve(process.env['VEYRA_DEV_REPO'])
  if (!app.isPackaged && isCheckout(process.cwd())) return process.cwd()
  return DEFAULT_REPO
}

/** The environment for the build: the user's own, minus anything Electron or this app set for itself. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('ELECTRON_') || k.startsWith('VEYRA_') || k === 'NODE_OPTIONS' || k === 'NODE_ENV') delete env[k]
  }
  return { ...env, FORCE_COLOR: '0', NO_COLOR: '1', ...extra }
}

const NO_NODE = 'Couldn’t start Node.js. Install it, or make sure “node” works in a new terminal, then reopen Veyra Study Dev.'

export function devBuilderState(sender?: WebContents): DevBuilderState {
  if (sender && !watchers.has(sender)) {
    watchers.add(sender)
    sender.once('destroyed', () => watchers.delete(sender))
  }
  const dir = repoDir()
  const available = devBuilderAvailable()
  const repoOk = available && isCheckout(dir)
  return {
    available,
    repoDir: dir,
    repoOk,
    reason: !available ? 'Building from commits works in Veyra Study Dev on Windows.' : repoOk ? undefined : `${dir} isn’t a Veyra Study checkout. Choose the folder you cloned it into.`,
    job
  }
}

function publishState(): void {
  const s = devBuilderState()
  for (const wc of watchers) if (!wc.isDestroyed()) wc.send('devBuilder:state', s)
}

function publishLog(lines: string[]): void {
  if (!job || !lines.length) return
  job.log.push(...lines)
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG)
  const payload = { id: job.id, lines }
  for (const wc of watchers) if (!wc.isDestroyed()) wc.send('devBuilder:log', payload)
}

/** Runs tools/dev-select.mjs with a JSON flag and returns what it printed. */
function selectJson<T>(args: string[], timeout: number): Promise<T> {
  const dir = repoDir()
  if (!devBuilderAvailable()) return Promise.reject(new Error('Building from commits works in Veyra Study Dev on Windows.'))
  if (!isCheckout(dir)) return Promise.reject(new Error(`${dir} isn’t a Veyra Study checkout.`))
  return new Promise((done, fail) => {
    execFile('node', [join('tools', 'dev-select.mjs'), ...args], { cwd: dir, env: childEnv(), timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      let parsed: (T & { error?: string }) | null = null
      try {
        parsed = stdout ? (JSON.parse(stdout) as T & { error?: string }) : null
      } catch {
        /* not JSON */
      }
      if (parsed?.error) return fail(new Error(parsed.error))
      if (parsed) return done(parsed)
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return fail(new Error(NO_NODE))
      if (err && (err as { killed?: boolean }).killed) return fail(new Error('Listing commits took too long.'))
      fail(new Error(err?.message || 'Couldn’t read the checkout.'))
    })
  })
}

export function devCandidates(fetch = false): Promise<DevCandidates> {
  return selectJson<DevCandidates>(['--list-json', '--limit', '300', ...(fetch ? ['--fetch'] : [])], fetch ? 120_000 : 45_000)
}

export function devPreview(req: DevBuildRequest): Promise<DevPreview> {
  let args: string[]
  try {
    args = selectionArgs(req)
  } catch (e) {
    return Promise.reject(e)
  }
  return selectJson<DevPreview>(['--preview-json', ...args], 30_000)
}

export async function chooseDevRepo(win: BrowserWindow | null): Promise<DevBuilderState> {
  const opts = { title: 'Choose your Veyra Study checkout', defaultPath: repoDir(), properties: ['openDirectory' as const] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const dir = r.canceled ? '' : (r.filePaths[0] ?? '')
  if (dir) {
    if (!isCheckout(dir)) throw new Error('That folder isn’t a Veyra Study checkout (it needs .git and tools/release.mjs).')
    writeFileSync(CONFIG(), JSON.stringify({ repoDir: resolve(dir) }, null, 2))
    publishState()
  }
  return devBuilderState()
}

/** Removes the temporary worktree a stopped build left behind (the script tidies up itself otherwise). */
function tidyWorkDir(dir: string, repo: string): void {
  if (!dir || !existsSync(dir)) return
  try {
    // Unlink the node_modules junction itself first, never what it points to (your checkout's node_modules).
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true, maxRetries: 3 })
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch (e) {
    diag('dev build: temp folder not removed', { dir, error: e })
    publishLog([`(The temporary build folder ${dir} was left behind; you can delete it.)`])
  }
  execFile('git', ['worktree', 'prune'], { cwd: repo, windowsHide: true }, () => undefined)
}

export function startDevBuild(req: DevBuildRequest): DevBuilderState {
  if (!devBuilderAvailable()) throw new Error('Building from commits works in Veyra Study Dev on Windows.')
  if (child) throw new Error('A build is already running.')
  const repo = repoDir()
  if (!isCheckout(repo)) throw new Error(`${repo} isn’t a Veyra Study checkout.`)
  const args = buildReleaseArgs(req)
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  workDir = join(tmpdir(), `veyra-dev-select-app-${id}`)
  const thisDir = workDir
  job = { id, summary: describeRequest(req), status: 'running', startedAt: Date.now(), log: [] }
  diag('dev build started', { summary: job.summary, args: args.slice(1) })

  const proc = spawn('node', args, { cwd: repo, env: childEnv({ VEYRA_DEV_WORKDIR: thisDir }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child = proc
  const thisJob = job
  publishLog([`> node ${args.join(' ')}`, `  in ${repo}`, ''])

  const splitter = () => {
    let rest = ''
    return {
      push(chunk: Buffer) {
        rest += chunk.toString('utf8')
        const parts = rest.split(/\r?\n|\r(?!\n)/)
        rest = parts.pop() ?? ''
        if (job === thisJob) publishLog(parts.map(stripAnsi))
      },
      flush() {
        if (rest && job === thisJob) publishLog([stripAnsi(rest)])
        rest = ''
      }
    }
  }
  const out = splitter()
  const err = splitter()
  proc.stdout?.on('data', (c: Buffer) => out.push(c))
  proc.stderr?.on('data', (c: Buffer) => err.push(c))

  let settled = false
  const settle = (code: number | null, error?: string) => {
    if (settled) return
    settled = true
    out.flush()
    err.flush()
    if (child === proc) child = null
    if (thisJob.status === 'cancelling') thisJob.status = 'cancelled'
    else thisJob.status = code === 0 ? 'done' : 'failed'
    thisJob.exitCode = code
    thisJob.finishedAt = Date.now()
    if (error) thisJob.error = error
    else if (thisJob.status === 'failed') thisJob.error = `The build stopped with exit code ${code ?? 'unknown'}. See the log above.`
    tidyWorkDir(thisDir, repo)
    diag('dev build finished', { summary: thisJob.summary, status: thisJob.status, code, seconds: Math.round((thisJob.finishedAt - thisJob.startedAt) / 1000) })
    publishState()
  }
  proc.on('error', (e: NodeJS.ErrnoException) => settle(null, e.code === 'ENOENT' ? NO_NODE : e.message))
  proc.on('close', (code) => settle(code))

  publishState()
  return devBuilderState()
}

/** Stops the running build and everything it started (electron-builder, gradle, npm). */
export function cancelDevBuild(): DevBuilderState {
  const proc = child
  if (!proc || !job || job.status !== 'running') return devBuilderState()
  job.status = 'cancelling'
  publishLog(['', 'Stopping the build…'])
  publishState()
  if (proc.pid) execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  else proc.kill()
  return devBuilderState()
}

/** Forgets a finished build's log (the next one starts fresh anyway). */
export function clearDevBuild(): DevBuilderState {
  if (job && !child) job = null
  publishState()
  return devBuilderState()
}

/** Quitting the app stops a build that is still running, so no orphaned build keeps publishing. */
export function stopDevBuildOnQuit(): void {
  if (child?.pid) {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* quitting anyway */
    }
  }
}

/** A build is running (updates wait, so installing one doesn't stop it). */
export const devBuildRunning = (): boolean => !!child
