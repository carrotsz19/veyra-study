/**
 * Branch and repository channel rules for Veyra Study's two-repo publishing scheme:
 *
 *   feature branch ──(PR: npm run pr:dev)──▶ carrotsz19/veyra-study-dev (main)
 *                                                    │ once merged
 *                                                    ▼
 *                                  Dev builds (npm run release:dev, release:web:dev)
 *                                                    │ after testing & verification
 *                                                    ▼
 *   carrotsz19/veyra-study (dev) ──(PR: npm run pr:prod)──▶ carrotsz19/veyra-study (main)
 *                                                                   │ once merged (owner says ship)
 *                                                                   ▼
 *                                                     Prod builds (npm run ship, release:web)
 *
 * Local `dev` tracks carrotsz19/veyra-study-dev `main` (and mirrors to origin/dev for Prod PRs).
 * Local `main` tracks carrotsz19/veyra-study `main` (Prod only).
 */
import { execFileSync } from 'node:child_process'

export const PROD_REPO = 'carrotsz19/veyra-study'
export const DEV_REPO = 'carrotsz19/veyra-study-dev'
export const PROD_REMOTE_URL = `https://github.com/${PROD_REPO}.git`
export const DEV_REMOTE_URL = `https://github.com/${DEV_REPO}.git`
export const DEV_BRANCH = 'dev'
export const PROD_BRANCH = 'main'

const defaultGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function tryGit(gitFn, args, cwd) {
  try {
    return gitFn(args, cwd)
  } catch {
    return ''
  }
}

/** Matches a GitHub remote URL (HTTPS or SSH) against an `owner/repo` slug. */
export function remoteMatchesRepo(url, repoSlug) {
  const escaped = repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`github\\.com[:/]${escaped}(?:\\.git)?/?$`, 'i').test(String(url ?? '').trim())
}

/** Finds the git remote pointing at `repoSlug` (e.g. `origin` for prod, `dev-repo` for dev). */
export function findRemote(repoSlug, { cwd = process.cwd(), git = defaultGit } = {}) {
  const out = tryGit(git, ['remote', '-v'], cwd)
  if (!out) return ''
  const matches = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    if (remoteMatchesRepo(m[2], repoSlug) && !matches.includes(m[1])) matches.push(m[1])
  }
  if (!matches.length) return ''
  const preferred = repoSlug === PROD_REPO ? 'origin' : 'dev-repo'
  return matches.includes(preferred) ? preferred : matches[0]
}

/** Ensures a git remote pointing at carrotsz19/veyra-study-dev exists and returns its name. */
export function ensureDevRemote({ cwd = process.cwd(), git = defaultGit } = {}) {
  const existing = findRemote(DEV_REPO, { cwd, git })
  if (existing) return existing
  git(['remote', 'add', 'dev-repo', DEV_REMOTE_URL], cwd)
  return 'dev-repo'
}

/** Ensures a git remote pointing at carrotsz19/veyra-study exists and returns its name. */
export function ensureProdRemote({ cwd = process.cwd(), git = defaultGit } = {}) {
  const existing = findRemote(PROD_REPO, { cwd, git })
  if (existing) return existing
  throw new Error(`No git remote points to ${PROD_REPO}. Add origin (${PROD_REMOTE_URL}) first.`)
}

/**
 * Enforces the Dev channel guard before publishing a Dev build (Windows, Android, or Web):
 *  - Isolated worktree builds (`VEYRA_DEV_SELECTED=1`, e.g. `--pick`/`--ref`/`--commits`) are allowed.
 *  - Never publishes a Dev build from `main` (the Prod branch).
 *  - By default requires branch `dev`, a clean working tree, and `HEAD` synced with
 *    `carrotsz19/veyra-study-dev` `main` (so only accepted/merged Dev PRs go out).
 *  - Pass `allowLocal: true` (`--local`) to publish an unmerged local experiment (still never from `main`).
 */
export function assertDevChannel({
  cwd = process.cwd(),
  allowLocal = false,
  allowSelected = process.env.VEYRA_DEV_SELECTED === '1',
  skipFetch = false,
  git = defaultGit
} = {}) {
  if (allowSelected) {
    return { branch: tryGit(git, ['symbolic-ref', '--short', 'HEAD'], cwd), headSha: tryGit(git, ['rev-parse', 'HEAD'], cwd), devRemote: findRemote(DEV_REPO, { cwd, git }), selected: true }
  }

  const branch = tryGit(git, ['symbolic-ref', '--short', 'HEAD'], cwd)
  if (branch === PROD_BRANCH) {
    throw new Error(
      `Refusing to publish a Dev build from '${PROD_BRANCH}' (the Prod branch). Switch to '${DEV_BRANCH}' (synced with ${DEV_REPO} main), or use --pick / --ref to build in a temporary worktree.`
    )
  }

  if (allowLocal) {
    return { branch, headSha: tryGit(git, ['rev-parse', 'HEAD'], cwd), devRemote: findRemote(DEV_REPO, { cwd, git }), local: true }
  }

  if (branch !== DEV_BRANCH) {
    const where = branch ? `'${branch}'` : 'detached HEAD'
    throw new Error(
      `Dev builds publish from '${DEV_BRANCH}' (currently on ${where}). Open a PR to ${DEV_REPO} main first (npm run pr:dev), merge it, run 'npm run sync:dev', then run 'npm run release:dev'. (Pass --local to publish an unmerged experiment.)`
    )
  }

  const dirty = tryGit(git, ['status', '--porcelain'], cwd)
  if (dirty) {
    throw new Error(`Commit your changes and merge a PR into ${DEV_REPO} main before publishing a Dev build. (Pass --local to include uncommitted edits.)\n${dirty}`)
  }

  const devRemote = ensureDevRemote({ cwd, git })
  if (!skipFetch) {
    try {
      git(['fetch', '--quiet', '--no-tags', devRemote, 'main'], cwd)
    } catch (e) {
      throw new Error(`Couldn't fetch ${DEV_REPO} main (${e instanceof Error ? e.message : e}). Check your connection or pass --local.`)
    }
  }

  const headSha = git(['rev-parse', 'HEAD'], cwd)
  const remoteSha = tryGit(git, ['rev-parse', '--verify', `${devRemote}/main^{commit}`], cwd)
  if (!remoteSha) {
    throw new Error(`Couldn't find ${devRemote}/main. Push '${DEV_BRANCH}' to ${DEV_REPO} main first.`)
  }

  const behind = Number(git(['rev-list', '--count', `HEAD..${remoteSha}`], cwd) || 0)
  if (behind > 0) {
    throw new Error(`Your '${DEV_BRANCH}' branch is ${behind} commit(s) behind ${DEV_REPO} main. Run 'npm run sync:dev' first.`)
  }

  const ahead = Number(git(['rev-list', '--count', `${remoteSha}..HEAD`], cwd) || 0)
  if (ahead > 0) {
    throw new Error(
      `Your '${DEV_BRANCH}' branch has ${ahead} commit(s) not yet accepted on ${DEV_REPO} main. Open and merge a PR into ${DEV_REPO} main first (npm run pr:dev), or pass --local.`
    )
  }

  return { branch, headSha, devRemote }
}

/**
 * Enforces the Prod channel guard before shipping or publishing a Prod release (Windows, Android, or Web):
 *  - Isolated rollback worktrees (`VEYRA_ROLLBACK=1`, from `tools/rollback.mjs`) are allowed.
 *  - Requires branch `main`, a clean working tree, and `HEAD` in sync with `carrotsz19/veyra-study` `main`
 *    (so only accepted/merged Prod PRs go out).
 */
export function assertProdChannel({
  cwd = process.cwd(),
  allowRollback = process.env.VEYRA_ROLLBACK === '1',
  skipFetch = false,
  git = defaultGit
} = {}) {
  if (allowRollback) {
    return { branch: tryGit(git, ['symbolic-ref', '--short', 'HEAD'], cwd), headSha: tryGit(git, ['rev-parse', 'HEAD'], cwd), prodRemote: findRemote(PROD_REPO, { cwd, git }), rollback: true }
  }

  const branch = tryGit(git, ['symbolic-ref', '--short', 'HEAD'], cwd)
  if (branch !== PROD_BRANCH) {
    const where = branch ? `'${branch}'` : 'detached HEAD'
    throw new Error(
      `Refusing to publish a Prod release from ${where}. Prod releases only publish from '${PROD_BRANCH}' after a PR to ${PROD_REPO} main is accepted (npm run pr:prod).`
    )
  }

  const dirty = tryGit(git, ['status', '--porcelain'], cwd)
  if (dirty) {
    throw new Error(`Commit your changes first, so the Prod release matches what is in git.\n${dirty}`)
  }

  const prodRemote = ensureProdRemote({ cwd, git })
  if (!skipFetch) {
    try {
      git(['fetch', '--quiet', prodRemote, 'main'], cwd)
    } catch (e) {
      throw new Error(`Couldn't fetch ${PROD_REPO} main (${e instanceof Error ? e.message : e}).`)
    }
  }

  const headSha = git(['rev-parse', 'HEAD'], cwd)
  const remoteSha = tryGit(git, ['rev-parse', '--verify', `${prodRemote}/main^{commit}`], cwd)
  if (!remoteSha) {
    throw new Error(`Couldn't find ${prodRemote}/main.`)
  }

  const behind = Number(git(['rev-list', '--count', `HEAD..${remoteSha}`], cwd) || 0)
  if (behind > 0) {
    throw new Error(`This '${PROD_BRANCH}' branch is ${behind} commit(s) behind ${PROD_REPO} main. Pull first.`)
  }

  const ahead = Number(git(['rev-list', '--count', `${remoteSha}..HEAD`], cwd) || 0)
  if (ahead > 0) {
    throw new Error(
      `This '${PROD_BRANCH}' branch has ${ahead} unpushed commit(s) not on ${PROD_REPO} main. Merge changes via a PR into ${PROD_REPO} main (npm run pr:prod) before shipping Prod.`
    )
  }

  return { branch, headSha, prodRemote }
}
