// Branch & repository channel guards (tools/channels.mjs). Run: node --test tests/channels.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEV_REPO, PROD_REPO, assertDevChannel, assertProdChannel, findRemote, remoteMatchesRepo } from '../tools/channels.mjs'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'veyra-channels-test-'))
  const prodBare = join(root, 'prod.git')
  const devBare = join(root, 'dev.git')
  const work = join(root, 'work')
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  run(root, 'init', '--bare', prodBare)
  run(root, 'init', '--bare', devBare)
  run(root, 'init', '-b', 'main', work)
  run(work, 'config', 'user.email', 'test@example.com')
  run(work, 'config', 'user.name', 'Test')
  writeFileSync(join(work, 'file.txt'), 'v1\n')
  run(work, 'add', '.')
  run(work, 'commit', '-m', 'Initial')

  // Point remotes at local bare repos, with fake GitHub URLs tested via remoteMatchesRepo separately.
  run(work, 'remote', 'add', 'origin', prodBare)
  run(work, 'remote', 'add', 'dev-repo', devBare)
  run(work, 'push', '-u', 'origin', 'main')
  run(work, 'checkout', '-b', 'dev')
  run(work, 'push', '-u', 'dev-repo', 'dev:main')
  run(work, 'fetch', 'dev-repo', 'main')

  // Custom git wrapper that maps remote -v to GitHub URLs so findRemote identifies origin & dev-repo.
  const git = (args, cwd) => {
    if (args[0] === 'remote' && args[1] === '-v') {
      return [
        `origin\thttps://github.com/${PROD_REPO}.git (fetch)`,
        `origin\thttps://github.com/${PROD_REPO}.git (push)`,
        `dev-repo\thttps://github.com/${DEV_REPO}.git (fetch)`,
        `dev-repo\thttps://github.com/${DEV_REPO}.git (push)`
      ].join('\n')
    }
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  return { root, work, run: (...a) => run(work, ...a), git, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

test('remoteMatchesRepo matches HTTPS and SSH GitHub URLs cleanly', () => {
  assert.equal(remoteMatchesRepo('https://github.com/carrotsz19/veyra-study.git', PROD_REPO), true)
  assert.equal(remoteMatchesRepo('git@github.com:carrotsz19/veyra-study-dev.git', DEV_REPO), true)
  assert.equal(remoteMatchesRepo('https://github.com/carrotsz19/veyra-study-dev.git', PROD_REPO), false)
  assert.equal(remoteMatchesRepo('https://github.com/carrotsz19/veyra-study.git', DEV_REPO), false)
})

test('assertDevChannel enforces dev branch synced with veyra-study-dev main', () => {
  const f = makeFixture()
  try {
    assert.equal(findRemote(DEV_REPO, { cwd: f.work, git: f.git }), 'dev-repo')
    assert.equal(findRemote(PROD_REPO, { cwd: f.work, git: f.git }), 'origin')

    // On clean `dev` matching dev-repo/main: allowed.
    const ok = assertDevChannel({ cwd: f.work, git: f.git })
    assert.equal(ok.branch, 'dev')
    assert.equal(ok.devRemote, 'dev-repo')

    // Dirty tree on `dev`: refused unless --local.
    writeFileSync(join(f.work, 'dirty.txt'), 'wip\n')
    assert.throws(() => assertDevChannel({ cwd: f.work, git: f.git }), /Commit your changes/i)
    assert.equal(assertDevChannel({ cwd: f.work, allowLocal: true, git: f.git }).local, true)
    rmSync(join(f.work, 'dirty.txt'))

    // Unpushed commit on `dev` (not yet merged via PR to veyra-study-dev main): refused unless --local.
    writeFileSync(join(f.work, 'file.txt'), 'v2\n')
    f.run('add', '.')
    f.run('commit', '-m', 'Unaccepted dev commit')
    assert.throws(() => assertDevChannel({ cwd: f.work, git: f.git }), /not yet accepted/i)
    assert.equal(assertDevChannel({ cwd: f.work, allowLocal: true, git: f.git }).local, true)

    // After merging/pushing to dev-repo/main: allowed again.
    f.run('push', 'dev-repo', 'dev:main')
    assert.equal(assertDevChannel({ cwd: f.work, git: f.git }).branch, 'dev')

    // Feature branch: refused unless --local.
    f.run('checkout', '-b', 'feat/test')
    assert.throws(() => assertDevChannel({ cwd: f.work, git: f.git }), /pr:dev/i)
    assert.equal(assertDevChannel({ cwd: f.work, allowLocal: true, git: f.git }).local, true)

    // Prod `main` branch: ALWAYS refused (even with --local), unless isolated worktree (`allowSelected`).
    f.run('checkout', 'main')
    assert.throws(() => assertDevChannel({ cwd: f.work, git: f.git }), /Prod branch/i)
    assert.throws(() => assertDevChannel({ cwd: f.work, allowLocal: true, git: f.git }), /Prod branch/i)
    assert.equal(assertDevChannel({ cwd: f.work, allowSelected: true, git: f.git }).selected, true)
  } finally {
    f.cleanup()
  }
})

test('assertProdChannel enforces clean main synced with origin/main', () => {
  const f = makeFixture()
  try {
    // On `dev`: refused.
    assert.throws(() => assertProdChannel({ cwd: f.work, git: f.git }), /Prod releases only publish from 'main'/i)

    // On clean `main` matching origin/main: allowed.
    f.run('checkout', 'main')
    const ok = assertProdChannel({ cwd: f.work, git: f.git })
    assert.equal(ok.branch, 'main')
    assert.equal(ok.prodRemote, 'origin')

    // Dirty tree on `main`: refused.
    writeFileSync(join(f.work, 'dirty.txt'), 'wip\n')
    assert.throws(() => assertProdChannel({ cwd: f.work, git: f.git }), /Commit your changes/i)
    rmSync(join(f.work, 'dirty.txt'))

    // Unpushed commit on `main` (bypassing PR): refused.
    writeFileSync(join(f.work, 'file.txt'), 'bypass\n')
    f.run('add', '.')
    f.run('commit', '-m', 'Direct commit on main')
    assert.throws(() => assertProdChannel({ cwd: f.work, git: f.git }), /unpushed commit/i)

    // Rollback worktree escape hatch works.
    assert.equal(assertProdChannel({ cwd: f.work, allowRollback: true, git: f.git }).rollback, true)
  } finally {
    f.cleanup()
  }
})
