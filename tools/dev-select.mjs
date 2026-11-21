/**
 * Commit / branch / PR selection for Dev builds (tools/release.mjs --dev and tools/release-web.mjs --dev).
 *
 * Lets you build a Dev release from:
 *  - a single commit, branch, tag, or GitHub PR:   --ref <sha|branch|tag|pr#12>
 *  - cherry-picked commits onto a clean base:      --commits <sha1,sha2,...> [--base <ref>]
 *  - an interactive terminal picker:               --pick
 *  - optional friendly name shown in the Dev app:  --label "Billing rework"
 *
 * Runs inside a clean detached git worktree so your main checkout (and any uncommitted work)
 * is never disturbed. When package-lock.json matches, it reuses node_modules via a directory
 * junction/symlink for fast builds; otherwise it runs npm ci inside the worktree.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DEV_REPO, findRemote } from './channels.mjs'

const META_OPEN = '<!-- veyra-dev-meta:'
const META_CLOSE = ' -->'

export function formatDevMetaComment(meta) {
  const safe = JSON.stringify(meta).replace(/-->/g, '--\\u003e')
  return `${META_OPEN}${safe}${META_CLOSE}`
}

/** Parses Dev commit-selection flags out of process.argv. */
export function parseDevSelectArgs(argv = process.argv.slice(2)) {
  const out = { pick: false, ref: '', commits: [], base: '', label: '', web: false }
  const take = (i, flag) => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value.`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pick') out.pick = true
    else if (a === '--web') out.web = true
    else if (a === '--ref') {
      out.ref = take(i, '--ref').trim()
      i++
    } else if (a.startsWith('--ref=')) out.ref = a.slice(6).trim()
    else if (a === '--base') {
      out.base = take(i, '--base').trim()
      i++
    } else if (a.startsWith('--base=')) out.base = a.slice(7).trim()
    else if (a === '--label') {
      out.label = take(i, '--label').trim()
      i++
    } else if (a.startsWith('--label=')) out.label = a.slice(8).trim()
    else if (a === '--commit' || a === '--commits') {
      const val = take(i, a)
      out.commits.push(
        ...val
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
      i++
    } else if (a.startsWith('--commits=')) {
      out.commits.push(
        ...a
          .slice(10)
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    } else if (a.startsWith('--commit=')) {
      const v = a.slice(9).trim()
      if (v) out.commits.push(v)
    }
  }
  if (out.ref && out.commits.length) throw new Error('Use either --ref or --commits, not both.')
  return out
}

export function hasDevSelection(sel) {
  return Boolean(sel.pick || sel.ref || sel.commits.length)
}

/**
 * Parses a user's interactive selection against a list of recent commits.
 * Supports:
 *  - Single index ("2") or ref ("feat/x", "pr#4", "99cde06")
 *  - Comma/space list of indices or SHAs ("1, 3, 5") -> cherry-pick commits
 *  - Inclusive range ("4..1" or "1..4") -> cherry-pick commits in oldest-first order
 */
export function parseInteractiveChoice(input, commits, branches = [], prs = []) {
  const raw = String(input ?? '').trim()
  if (!raw) return null

  const rangeMatch = /^(\d+)\s*\.\.\s*(\d+)$/.exec(raw)
  if (rangeMatch) {
    const a = Number(rangeMatch[1])
    const b = Number(rangeMatch[2])
    if (a < 1 || b < 1 || a > commits.length || b > commits.length) throw new Error(`Pick numbers between 1 and ${commits.length}.`)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    // commits[0] is newest; reverse so cherry-picks apply oldest-first.
    const picked = commits.slice(lo - 1, hi).reverse()
    return { mode: 'commits', commits: picked.map((c) => c.sha) }
  }

  // Branch shorthand: b1, b2...
  const branchIdx = /^b(\d+)$/i.exec(raw)
  if (branchIdx) {
    const b = branches[Number(branchIdx[1]) - 1]
    if (!b) throw new Error(`No branch b${branchIdx[1]}.`)
    return { mode: 'ref', ref: b.name }
  }

  // PR shorthand: p1, p2... or pr#12 / #12
  const prIdx = /^p(\d+)$/i.exec(raw)
  if (prIdx) {
    const pr = prs[Number(prIdx[1]) - 1]
    if (!pr) throw new Error(`No pull request p${prIdx[1]}.`)
    return { mode: 'ref', ref: `pr#${pr.number}`, label: `PR #${pr.number}: ${pr.title}` }
  }

  const tokens = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (tokens.length === 1) {
    const t = tokens[0]
    if (/^\d+$/.test(t)) {
      const c = commits[Number(t) - 1]
      if (!c) throw new Error(`No commit #${t}.`)
      return { mode: 'ref', ref: c.sha }
    }
    return { mode: 'ref', ref: t }
  }

  // Multiple items -> cherry-pick list (resolve numeric indices, preserve oldest-first when numeric).
  const allNumeric = tokens.every((t) => /^\d+$/.test(t))
  const resolved = tokens.map((t) => {
    if (/^\d+$/.test(t)) {
      const c = commits[Number(t) - 1]
      if (!c) throw new Error(`No commit #${t}.`)
      return { idx: Number(t), sha: c.sha }
    }
    return { idx: 0, sha: t }
  })
  if (allNumeric) resolved.sort((a, b) => b.idx - a.idx) // higher index = older commit, apply oldest first
  return { mode: 'commits', commits: resolved.map((x) => x.sha) }
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function tryGit(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return ''
  }
}

function defaultBase(repoDir) {
  const devRemote = findRemote(DEV_REPO, { cwd: repoDir })
  const candidates = [...(devRemote ? [`${devRemote}/main`] : []), 'origin/dev', 'dev', 'origin/main', 'main', 'HEAD']
  for (const candidate of candidates) {
    if (tryGit(['rev-parse', '--verify', `${candidate}^{commit}`], repoDir)) return candidate
  }
  return 'HEAD'
}

/** Resolves a ref (including pr#12 / #12) to { sha, branchLabel }. */
function resolveRef(repoDir, ref) {
  if (String(ref).startsWith('-')) throw new Error(`Invalid ref "${ref}".`)
  const pr = /^(?:pr#?|#)(\d+)$/i.exec(ref)
  if (pr) {
    const num = pr[1]
    const devRemote = findRemote(DEV_REPO, { cwd: repoDir })
    let fetched = false
    for (const remote of [...(devRemote ? [devRemote] : []), 'origin']) {
      const r = spawnSync('git', ['fetch', remote, `pull/${num}/head`], { cwd: repoDir, stdio: 'inherit' })
      if (r.status === 0) {
        fetched = true
        break
      }
    }
    if (!fetched) throw new Error(`Couldn't fetch PR #${num} from ${DEV_REPO} or origin.`)
    const sha = git(['rev-parse', 'FETCH_HEAD'], repoDir)
    return { sha, branchLabel: `PR #${num}` }
  }
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`], repoDir)
  // Keep friendly branch/tag name if ref wasn't a raw hex SHA.
  const isSha = /^[0-9a-f]{7,40}$/i.test(ref)
  return { sha, branchLabel: isSha ? '' : ref }
}

function commitInfo(repoDir, sha) {
  const out = git(['show', '-s', '--format=%h%x1f%H%x1f%s', sha], repoDir)
  const [shortSha, fullSha, subject] = out.split('\x1f')
  return { sha: shortSha, full: fullSha, subject: subject ?? '' }
}

/** Interactive terminal picker for choosing a commit, branch, PR, or set of commits to cherry-pick. */
export async function promptDevSelection(repoDir) {
  const logRaw = tryGit(['log', '-n', '20', '--format=%h%x1f%ar%x1f%D%x1f%s'], repoDir)
  const commits = logRaw
    ? logRaw.split(/\r?\n/).map((line) => {
        const [sha, rel, deco, subject] = line.split('\x1f')
        return { sha, rel, deco, subject }
      })
    : []

  const branchRaw = tryGit(['for-each-ref', '--sort=-committerdate', '--count=10', '--format=%(refname:short)%09%(objectname:short)%09%(subject)', 'refs/heads', 'refs/remotes/origin'], repoDir)
  const branches = branchRaw
    ? branchRaw
        .split(/\r?\n/)
        .map((line) => {
          const [name, sha, subject] = line.split('\t')
          return { name, sha, subject }
        })
        .filter((b) => b.name && !b.name.endsWith('/HEAD'))
    : []

  let prs = []
  try {
    const raw = execFileSync('gh', ['pr', 'list', '--repo', DEV_REPO, '--state', 'open', '--limit', '10', '--json', 'number,title,headRefName'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    prs = JSON.parse(raw || '[]')
  } catch {
    /* offline or gh unavailable */
  }

  console.log('\nRecent commits (newest first):')
  commits.forEach((c, i) => {
    const tag = c.deco ? ` (${c.deco})` : ''
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${c.sha}  ${c.subject}${tag}  [${c.rel}]`)
  })
  if (branches.length) {
    console.log('\nBranches:')
    branches.forEach((b, i) => console.log(`  b${i + 1}. ${b.name}  (${b.sha})  ${b.subject}`))
  }
  if (prs.length) {
    console.log('\nOpen pull requests:')
    prs.forEach((p, i) => console.log(`  p${i + 1}. #${p.number}  ${p.title}  (${p.headRefName})`))
  }

  console.log('\nEnter:')
  console.log('  • One number / branch / PR / SHA (e.g. 1, b2, p1, pr#12, 99cde06) to build that snapshot')
  console.log('  • Multiple numbers or a range (e.g. 1,3,5 or 4..1) to cherry-pick commits onto a clean base\n')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = await rl.question('Select commit(s) or ref: ')
    const picked = parseInteractiveChoice(ans, commits, branches, prs)
    if (!picked) throw new Error('Nothing selected.')

    let base = ''
    if (picked.mode === 'commits') {
      const def = defaultBase(repoDir)
      const baseAns = (await rl.question(`Base ref to cherry-pick onto [${def}]: `)).trim()
      base = baseAns || def
    }
    const labelAns = (await rl.question(`Optional build label${picked.label ? ` [${picked.label}]` : ''}: `)).trim()
    const label = labelAns || picked.label || ''
    return {
      ref: picked.mode === 'ref' ? picked.ref : '',
      commits: picked.mode === 'commits' ? picked.commits : [],
      base,
      label
    }
  } finally {
    rl.close()
  }
}

function fileHash(path) {
  if (!existsSync(path)) return ''
  // Normalize CRLF vs LF so Windows core.autocrlf never defeats node_modules reuse.
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Prepares a clean detached git worktree for the chosen ref or cherry-picked commits,
 * reuses node_modules when package-lock.json matches, and returns { dir, meta, cleanup }.
 */
export function prepareDevWorktree({ repoDir = process.cwd(), ref = '', commits = [], base = '', label = '' }) {
  const root = resolve(repoDir)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const workDir = join(tmpdir(), `veyra-dev-select-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)

  let checkoutSha = ''
  let branchLabel = ''
  let baseLabel = ''
  let pickedInfos = []

  if (ref) {
    const r = resolveRef(root, ref)
    checkoutSha = r.sha
    branchLabel = r.branchLabel
    pickedInfos = [commitInfo(root, checkoutSha)]
  } else if (commits.length) {
    baseLabel = base || defaultBase(root)
    checkoutSha = resolveRef(root, baseLabel).sha
    pickedInfos = commits.map((c) => commitInfo(root, c))
  } else {
    throw new Error('Specify --ref, --commits, or --pick.')
  }

  git(['worktree', 'prune'], root)
  git(['worktree', 'add', '--detach', workDir, checkoutSha], root)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    try {
      // Unlink the node_modules junction/symlink itself (never touching its target) before removing the worktree.
      const nm = join(workDir, 'node_modules')
      try {
        rmSync(nm, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* removed with workDir below */
      }
      rmSync(workDir, { recursive: true, force: true, maxRetries: 3 })
      tryGit(['worktree', 'prune'], root)
    } catch {
      console.warn(`(Temporary build folder left at ${workDir}; you can delete it safely.)`)
    }
  }
  const onSignal = (sig) => {
    cleanup()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    if (commits.length) {
      console.log(`Cherry-picking ${pickedInfos.length} commit${pickedInfos.length === 1 ? '' : 's'} onto ${baseLabel} (${checkoutSha.slice(0, 7)})…`)
      for (const info of pickedInfos) {
        const r = spawnSync('git', ['cherry-pick', info.full], { cwd: workDir, stdio: 'inherit' })
        if (r.status !== 0) {
          throw new Error(`Cherry-pick conflict on ${info.sha} (${info.subject}). Your main checkout was not touched.`)
        }
      }
    }

    // Carry over gitignored build input if present.
    const googleClient = join(root, 'google-client.json')
    if (existsSync(googleClient)) copyFileSync(googleClient, join(workDir, 'google-client.json'))

    // Keep version aligned with the current checkout so the Dev build is always newer than installed Dev apps.
    const workPkgPath = join(workDir, 'package.json')
    const workPkg = JSON.parse(readFileSync(workPkgPath, 'utf8'))
    workPkg.version = pkg.version
    writeFileSync(workPkgPath, JSON.stringify(workPkg, null, 2) + '\n')

    // Fast path: reuse node_modules via directory junction when package-lock.json is identical.
    const mainLock = fileHash(join(root, 'package-lock.json'))
    const workLock = fileHash(join(workDir, 'package-lock.json'))
    if (mainLock && mainLock === workLock && existsSync(join(root, 'node_modules'))) {
      symlinkSync(join(root, 'node_modules'), join(workDir, 'node_modules'), 'junction')
    } else {
      console.log('package-lock.json differs from your working tree; running npm ci in the build worktree…')
      const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: workDir, stdio: 'inherit', shell: process.platform === 'win32' })
      if (r.status !== 0) throw new Error('npm ci failed in temporary worktree.')
    }

    const head = commitInfo(workDir, 'HEAD')
    const meta = {
      commit: commits.length ? pickedInfos.at(-1).sha : head.sha,
      fullCommit: commits.length ? pickedInfos.at(-1).full : head.full,
      branch: branchLabel || (baseLabel ? `${baseLabel} + ${pickedInfos.length} commit${pickedInfos.length === 1 ? '' : 's'}` : undefined),
      label: label || undefined,
      base: baseLabel || undefined,
      dirty: false,
      commits: pickedInfos.map((c) => ({ sha: c.sha, subject: c.subject }))
    }

    return { dir: workDir, meta, cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}

/** Collects metadata for a direct working-tree Dev build (no --ref / --commits / --pick). */
export function currentTreeDevMeta(repoDir = process.cwd(), label = '') {
  const head = commitInfo(repoDir, 'HEAD')
  const branch = tryGit(['symbolic-ref', '--short', 'HEAD'], repoDir)
  const dirty = Boolean(tryGit(['status', '--porcelain'], repoDir))
  return {
    commit: head.sha,
    fullCommit: head.full,
    branch: branch || undefined,
    label: label || undefined,
    dirty,
    commits: [{ sha: head.sha, subject: head.subject }]
  }
}

/** Renders human-readable Dev release notes with the embedded machine-readable metadata comment. */
export function formatDevReleaseNotes(meta, version, tag) {
  const full = { ...meta, version, tag, createdAt: new Date().toISOString() }
  const where = [meta.branch, `${meta.commit}${meta.dirty ? ' + uncommitted changes' : ''}`].filter(Boolean).join(' · ')
  const lines = []
  if (meta.label) lines.push(`**${meta.label}**`)
  lines.push(`Test build from ${where}.`)
  if (Array.isArray(meta.commits) && meta.commits.length) {
    lines.push('')
    for (const c of meta.commits) lines.push(`- \`${c.sha}\` ${c.subject}`)
  }
  lines.push('')
  lines.push('Windows: Veyra-Study-Dev-Setup.exe · Android: Veyra-Study-Dev.apk ("Veyra Dev"). Installed Dev apps update themselves.')
  lines.push('')
  lines.push(formatDevMetaComment(full))
  return lines.join('\n')
}
