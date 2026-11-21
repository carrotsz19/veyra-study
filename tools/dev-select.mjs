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
import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
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
  const out = git(['show', '-s', '--format=%h%x1f%H%x1f%P%x1f%s', sha], repoDir)
  const [shortSha, fullSha, parents, subject] = out.split('\x1f')
  return { sha: shortSha, full: fullSha, subject: subject ?? '', merge: String(parents ?? '').trim().split(/\s+/).length > 1 }
}

/**
 * Lists what a Dev build can be made from: recent commits on every local and remote branch
 * (newest first), branches, and open Dev PRs. Shared by the terminal picker and the in-app
 * builder (`node tools/dev-select.mjs --list-json`).
 */
export function listDevCandidates(repoDir, { limit = 200, prs: wantPrs = true, fetch = false } = {}) {
  if (fetch) spawnSync('git', ['fetch', '--all', '--prune', '--quiet'], { cwd: repoDir, stdio: 'ignore', timeout: 60_000 })
  const n = Math.max(1, Math.min(2000, Number(limit) || 200))
  const logRaw = tryGit(['log', '--branches', '--remotes', '--date-order', '-n', String(n), '--format=%h%x1f%H%x1f%ar%x1f%aI%x1f%an%x1f%D%x1f%P%x1f%s'], repoDir)
  const commits = logRaw
    ? logRaw.split(/\r?\n/).map((line) => {
        const [sha, full, rel, date, author, deco, parents, subject] = line.split('\x1f')
        return { sha, full, rel, date, author, deco: deco ?? '', subject: subject ?? '', merge: String(parents ?? '').trim().split(/\s+/).length > 1 }
      })
    : []

  const branchRaw = tryGit(
    ['for-each-ref', '--sort=-committerdate', '--count=60', '--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(committerdate:relative)%09%(subject)', 'refs/heads', 'refs/remotes'],
    repoDir
  )
  const branches = branchRaw
    ? branchRaw
        .split(/\r?\n/)
        .map((line) => {
          const [full, name, sha, rel, subject] = line.split('\t')
          return { full, name, sha, rel, subject: subject ?? '', remote: String(full).startsWith('refs/remotes/') }
        })
        .filter((b) => b.name && !String(b.full).endsWith('/HEAD'))
        .map(({ full, ...b }) => b)
    : []

  let prs = []
  let prError = ''
  if (wantPrs) {
    try {
      const raw = execFileSync('gh', ['pr', 'list', '--repo', DEV_REPO, '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,author,updatedAt'], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15_000
      }).trim()
      prs = (JSON.parse(raw || '[]') ?? []).map((p) => ({ number: p.number, title: p.title, headRefName: p.headRefName, author: p.author?.login ?? '', updatedAt: p.updatedAt ?? '' }))
    } catch {
      prError = 'Couldn’t list pull requests (offline, or gh isn’t signed in).'
    }
  }

  return {
    repoDir: resolve(repoDir),
    head: tryGit(['symbolic-ref', '--short', 'HEAD'], repoDir) || tryGit(['rev-parse', '--short', 'HEAD'], repoDir),
    defaultBase: defaultBase(repoDir),
    commits,
    branches,
    prs,
    prError: prError || undefined
  }
}

/**
 * Describes what a selection will build before anything runs: the commits it adds on top of
 * the base (or the cherry-picked list) and a diff summary. Never fetches or changes anything.
 */
export function previewDevSelection(repoDir, { ref = '', commits = [], base = '' } = {}) {
  const against = base || defaultBase(repoDir)
  const shortstat = (args) => tryGit(['diff', '--shortstat', ...args], repoDir)
  if (ref) {
    if (String(ref).startsWith('-')) throw new Error(`Invalid ref "${ref}".`)
    const pr = /^(?:pr#?|#)(\d+)$/i.exec(ref)
    if (pr) return { kind: 'ref', ref, title: `Pull request #${pr[1]}`, base: against, commits: [], note: 'Fetched from GitHub when the build starts.' }
    const sha = tryGit(['rev-parse', '--verify', `${ref}^{commit}`], repoDir)
    if (!sha) throw new Error(`Unknown commit or branch "${ref}".`)
    const head = commitInfo(repoDir, sha)
    const aheadRaw = tryGit(['log', '--format=%h%x1f%s', '-n', '50', `${against}..${sha}`], repoDir)
    const ahead = aheadRaw ? aheadRaw.split(/\r?\n/).map((l) => ({ sha: l.split('\x1f')[0], subject: l.split('\x1f')[1] ?? '' })) : []
    const total = Number(tryGit(['rev-list', '--count', `${against}..${sha}`], repoDir) || ahead.length)
    return { kind: 'ref', ref, title: `${head.sha} ${head.subject}`, base: against, commits: ahead, aheadCount: total, shortstat: shortstat([`${against}...${sha}`]) }
  }
  if (!commits.length) throw new Error('Nothing selected.')
  const infos = commits.map((c) => {
    if (String(c).startsWith('-')) throw new Error(`Invalid commit "${c}".`)
    const info = commitInfo(repoDir, c)
    return { sha: info.sha, subject: info.subject, stat: tryGit(['show', '--shortstat', '--format=', info.full], repoDir) }
  })
  return { kind: 'commits', title: `${infos.length} commit${infos.length === 1 ? '' : 's'} onto ${against}`, base: against, commits: infos }
}

/* ---------- terminal picker (npm run release:dev:pick) ---------- */

const TABS = { commits: 'Commits', branches: 'Branches', prs: 'Pull requests' }

/** Fresh picker state. `mode: 'base'` shows only branches, to choose what cherry-picks go onto. */
export function pickerInit(c, { mode = 'full' } = {}) {
  const tabs = mode === 'base' ? ['branches'] : ['commits', 'branches', ...(c.prs?.length ? ['prs'] : [])]
  const state = { mode, tabs, tab: 0, cursor: { commits: 0, branches: 0, prs: 0 }, filter: '', selected: [], result: null, cancelled: false }
  if (mode === 'base') {
    const i = baseItems(c).findIndex((b) => b.name === c.defaultBase)
    state.cursor.branches = Math.max(0, i)
  }
  return state
}

function baseItems(c) {
  const list = c.branches ?? []
  return c.defaultBase && !list.some((b) => b.name === c.defaultBase) ? [{ name: c.defaultBase, sha: '', subject: '', rel: '' }, ...list] : list
}

/** Items on the current tab after the filter (every space-separated word must match). */
export function pickerItems(state, c) {
  const tab = state.tabs[state.tab]
  const all = tab === 'commits' ? c.commits : tab === 'prs' ? c.prs : state.mode === 'base' ? baseItems(c) : c.branches
  const words = state.filter.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return all ?? []
  const text = (it) => (tab === 'commits' ? `${it.sha} ${it.subject} ${it.deco} ${it.author}` : tab === 'prs' ? `#${it.number} ${it.title} ${it.headRefName} ${it.author}` : `${it.name} ${it.sha} ${it.subject}`).toLowerCase()
  return (all ?? []).filter((it) => words.every((w) => text(it).includes(w)))
}

/** Applies one keypress ({ name, ctrl, str }) and returns the next state. Pure, for tests. */
export function pickerKey(state, c, key) {
  const s = { ...state, cursor: { ...state.cursor }, selected: [...state.selected] }
  const tab = s.tabs[s.tab]
  const items = pickerItems(s, c)
  const move = (d) => {
    s.cursor[tab] = Math.max(0, Math.min(items.length - 1, (s.cursor[tab] ?? 0) + d))
  }
  const name = key?.name
  if (key?.ctrl && name === 'c') return { ...s, cancelled: true }
  if (name === 'up') move(-1)
  else if (name === 'down') move(1)
  else if (name === 'pageup') move(-10)
  else if (name === 'pagedown') move(10)
  else if (name === 'home') s.cursor[tab] = 0
  else if (name === 'end') s.cursor[tab] = Math.max(0, items.length - 1)
  else if (name === 'tab' || name === 'right' || name === 'left') {
    const d = name === 'left' || key?.shift ? -1 : 1
    s.tab = (s.tab + d + s.tabs.length) % s.tabs.length
    s.filter = ''
  } else if (name === 'space') {
    if (tab === 'commits' && items[s.cursor[tab]]) {
      const full = items[s.cursor[tab]].full
      s.selected = s.selected.includes(full) ? s.selected.filter((x) => x !== full) : [...s.selected, full]
      move(1)
    }
  } else if (name === 'return' || name === 'enter') {
    if (tab === 'commits' && s.selected.length) {
      // Oldest first: later in the newest-first list means older.
      const order = new Map(c.commits.map((it, i) => [it.full, i]))
      const commits = [...s.selected].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0))
      return { ...s, result: { mode: 'commits', commits } }
    }
    const it = items[s.cursor[tab]]
    if (!it) return s
    if (tab === 'commits') return { ...s, result: { mode: 'ref', ref: it.full } }
    if (tab === 'prs') return { ...s, result: { mode: 'ref', ref: `pr#${it.number}`, label: `PR #${it.number}: ${it.title}` } }
    return { ...s, result: { mode: 'ref', ref: it.name } }
  } else if (name === 'escape') {
    if (s.filter) s.filter = ''
    else if (s.selected.length) s.selected = []
    else return { ...s, cancelled: true }
  } else if (name === 'backspace') {
    s.filter = s.filter.slice(0, -1)
  } else if (!key?.ctrl && typeof key?.str === 'string' && key.str.length === 1 && key.str >= ' ' && key.str !== '\x7f') {
    s.filter += key.str
  } else return state
  // Keep the cursor inside the (possibly re-filtered) list.
  const now = pickerItems(s, c)
  const t = s.tabs[s.tab]
  s.cursor[t] = Math.max(0, Math.min(now.length - 1, s.cursor[t] ?? 0))
  return s
}

const ESC = '\x1b['
const style = (code, text) => `${ESC}${code}m${text}${ESC}0m`
const cut = (text, width) => (text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text)

/** Draws the picker into a string sized for a rows × cols terminal. */
export function pickerRender(state, c, { rows = 24, cols = 80 } = {}) {
  const tab = state.tabs[state.tab]
  const items = pickerItems(state, c)
  const width = Math.max(20, cols - 1)
  const out = []
  out.push(style('1', cut(state.mode === 'base' ? 'Apply the selected commits onto which base?' : 'Veyra Study Dev · choose what to build', width)))
  if (state.tabs.length > 1) {
    const counts = { commits: c.commits.length, branches: c.branches.length, prs: c.prs.length }
    out.push(state.tabs.map((t, i) => (i === state.tab ? style('7', ` ${TABS[t]} ${counts[t]} `) : style('2', ` ${TABS[t]} ${counts[t]} `))).join(' ') + style('2', '   ←/→ switch'))
  }
  out.push(`Filter: ${state.filter}${style('2', state.filter ? '' : '(type to search)')}`)
  out.push('')

  const height = Math.max(3, rows - out.length - 3)
  const cur = state.cursor[tab] ?? 0
  const top = Math.max(0, Math.min(cur - Math.floor(height / 2), items.length - height))
  const view = items.slice(top, top + height)
  if (!items.length) out.push(style('2', state.filter ? '  Nothing matches.' : '  Nothing here.'))
  view.forEach((it, i) => {
    const at = top + i === cur
    let line
    if (tab === 'commits') {
      const mark = state.selected.includes(it.full) ? '[x]' : '[ ]'
      const deco = it.deco ? `  (${it.deco})` : ''
      line = `${at ? '›' : ' '} ${mark} ${it.sha}  ${it.subject}  · ${it.rel}${deco}`
    } else if (tab === 'prs') {
      line = `${at ? '›' : ' '} #${it.number}  ${it.title}  (${it.headRefName})`
    } else {
      const isDefault = state.mode === 'base' && it.name === c.defaultBase ? '  [default]' : ''
      line = `${at ? '›' : ' '} ${it.name}${it.sha ? `  ${it.sha}` : ''}${it.subject ? `  ${it.subject}` : ''}${it.rel ? `  · ${it.rel}` : ''}${isDefault}`
    }
    line = cut(line, width)
    const picked = tab === 'commits' && state.selected.includes(it.full)
    out.push(at ? style('7', line.padEnd(width)) : picked ? style('32', line) : line)
  })
  while (out.length < rows - 1) out.push('')

  const help =
    tab === 'commits'
      ? state.selected.length
        ? `${state.selected.length} selected · Space toggle · Enter cherry-pick these · Esc clear`
        : 'Space select commits to cherry-pick · Enter build this commit as is · Esc quit'
      : state.mode === 'base'
        ? 'Enter use this base · Esc quit'
        : tab === 'prs'
          ? 'Enter build this pull request · Esc quit'
          : 'Enter build this branch · Esc quit'
  out.push(style('2', cut(help, width)))
  return out.join('\n')
}

function runPicker(c, opts) {
  return new Promise((done) => {
    const input = process.stdin
    const output = process.stdout
    let state = pickerInit(c, opts)
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    output.write(`${ESC}?1049h${ESC}?25l`)
    const draw = () => output.write(`${ESC}H${ESC}2J` + pickerRender(state, c, { rows: output.rows || 24, cols: output.columns || 80 }))
    const finish = () => {
      input.off('keypress', onKey)
      output.off('resize', draw)
      input.setRawMode(false)
      input.pause()
      output.write(`${ESC}?25h${ESC}?1049l`)
      done(state)
    }
    const onKey = (str, key = {}) => {
      state = pickerKey(state, c, { name: key.name, ctrl: key.ctrl, shift: key.shift, str })
      if (state.result || state.cancelled) finish()
      else draw()
    }
    input.on('keypress', onKey)
    output.on('resize', draw)
    draw()
  })
}

function printPreview(p) {
  console.log('')
  console.log(style('1', p.kind === 'ref' ? `Build ${p.ref}` : `Cherry-pick ${p.title}`))
  if (p.kind === 'ref') console.log(`  ${p.title}`)
  if (p.note) console.log(style('2', `  ${p.note}`))
  if (p.kind === 'ref' && p.aheadCount !== undefined) {
    console.log(style('2', `  ${p.aheadCount} commit${p.aheadCount === 1 ? '' : 's'} not on ${p.base}${p.shortstat ? ` · ${p.shortstat}` : ''}`))
  }
  for (const cm of p.commits.slice(0, 15)) console.log(`   ${cm.sha}  ${cm.subject}${cm.stat ? style('2', `  (${cm.stat})`) : ''}`)
  if (p.commits.length > 15) console.log(style('2', `   … and ${p.commits.length - 15} more`))
  console.log('')
}

/** Interactive picker for choosing a commit, branch, PR, or set of commits to cherry-pick. */
export async function promptDevSelection(repoDir) {
  const c = listDevCandidates(repoDir)
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.VEYRA_PLAIN_PICKER) return promptDevSelectionTyped(repoDir, c)

  const first = await runPicker(c)
  if (first.cancelled || !first.result) throw new Error('Nothing selected.')
  const picked = first.result
  let base = ''
  if (picked.mode === 'commits') {
    const second = await runPicker(c, { mode: 'base' })
    if (second.cancelled || !second.result) throw new Error('Nothing selected.')
    base = second.result.ref
  }

  printPreview(previewDevSelection(repoDir, { ref: picked.ref, commits: picked.commits, base }))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const labelAns = (await rl.question(`Build label (optional)${picked.label ? ` [${picked.label}]` : ''}: `)).trim()
    const ok = (await rl.question('Build and publish this Dev build? [Y/n] ')).trim().toLowerCase()
    if (ok && !['y', 'yes'].includes(ok)) throw new Error('Cancelled.')
    return { ref: picked.mode === 'ref' ? picked.ref : '', commits: picked.mode === 'commits' ? picked.commits : [], base, label: labelAns || picked.label || '' }
  } finally {
    rl.close()
  }
}

/** The typed fallback when there is no interactive terminal (or VEYRA_PLAIN_PICKER=1). */
async function promptDevSelectionTyped(repoDir, c) {
  const commits = c.commits.slice(0, 20)
  const branches = c.branches.slice(0, 10)
  const prs = c.prs.slice(0, 10)

  console.log('\nRecent commits (newest first):')
  commits.forEach((cm, i) => {
    const tag = cm.deco ? ` (${cm.deco})` : ''
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${cm.sha}  ${cm.subject}${tag}  [${cm.rel}]`)
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
      const baseAns = (await rl.question(`Base ref to cherry-pick onto [${c.defaultBase}]: `)).trim()
      base = baseAns || c.defaultBase
    }
    const labelAns = (await rl.question(`Optional build label${picked.label ? ` [${picked.label}]` : ''}: `)).trim()
    return {
      ref: picked.mode === 'ref' ? picked.ref : '',
      commits: picked.mode === 'commits' ? picked.commits : [],
      base,
      label: labelAns || picked.label || ''
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
  // The in-app builder chooses the folder itself (VEYRA_DEV_WORKDIR) so it can tidy up after a cancel.
  const wanted = process.env.VEYRA_DEV_WORKDIR ? resolve(process.env.VEYRA_DEV_WORKDIR) : ''
  const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (wanted && (!/[\\/]veyra-dev-select-[\w-]+$/.test(wanted) || !samePath(resolve(wanted, '..'), resolve(tmpdir())) || existsSync(wanted))) {
    throw new Error('VEYRA_DEV_WORKDIR must be a new veyra-dev-select-* folder in the temp folder.')
  }
  const workDir = wanted || join(tmpdir(), `veyra-dev-select-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)

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
        // A merge commit is applied as its changes against its first parent (the branch it was merged into).
        const r = spawnSync('git', ['cherry-pick', ...(info.merge ? ['-m', '1'] : []), info.full], { cwd: workDir, stdio: 'inherit' })
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

/*
 * Machine-readable helpers for the in-app builder (Veyra Study Dev → Settings → Software update):
 *   node tools/dev-select.mjs --list-json [--limit 300] [--fetch] [--no-prs]
 *   node tools/dev-select.mjs --preview-json (--ref <ref> | --commits <a,b> [--base <ref>])
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  try {
    if (argv.includes('--list-json')) {
      const i = argv.indexOf('--limit')
      const limit = i >= 0 ? Number(argv[i + 1]) : 200
      process.stdout.write(JSON.stringify(listDevCandidates(process.cwd(), { limit, fetch: argv.includes('--fetch'), prs: !argv.includes('--no-prs') })))
    } else if (argv.includes('--preview-json')) {
      const sel = parseDevSelectArgs(argv)
      process.stdout.write(JSON.stringify(previewDevSelection(process.cwd(), sel)))
    } else {
      console.error('Usage: node tools/dev-select.mjs --list-json | --preview-json --ref <ref>')
      process.exit(2)
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    process.exit(1)
  }
}
