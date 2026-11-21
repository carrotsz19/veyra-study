// Commit selection for Dev builds (tools/dev-select.mjs) + release metadata parsing (src/shared/dev-builds.ts).
// Run: node --test tests/dev-builds.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDevReleaseNotes, hasDevSelection, parseDevSelectArgs, parseInteractiveChoice, prepareDevWorktree } from '../tools/dev-select.mjs'

test('parseDevSelectArgs parses refs, commits, base, label, pick and web flags', () => {
  assert.deepEqual(parseDevSelectArgs(['--dev']), { pick: false, ref: '', commits: [], base: '', label: '', web: false })
  assert.equal(hasDevSelection(parseDevSelectArgs(['--dev'])), false)

  const refSel = parseDevSelectArgs(['--dev', '--ref', 'feat/billing', '--label', 'Billing UI', '--web'])
  assert.deepEqual(refSel, { pick: false, ref: 'feat/billing', commits: [], base: '', label: 'Billing UI', web: true })
  assert.equal(hasDevSelection(refSel), true)

  const multi = parseDevSelectArgs(['--dev', '--commits=aaa1111,bbb2222', '--commit', 'ccc3333', '--base=origin/main'])
  assert.deepEqual(multi.commits, ['aaa1111', 'bbb2222', 'ccc3333'])
  assert.equal(multi.base, 'origin/main')

  assert.throws(() => parseDevSelectArgs(['--ref', 'main', '--commits', 'abc1234']), /not both/i)
  assert.throws(() => parseDevSelectArgs(['--ref']), /needs a value/i)
})

test('parseInteractiveChoice handles single commit, branch, PR, ranges and cherry-pick lists', () => {
  const commits = [
    { sha: 'aaa1111', subject: 'Newest' },
    { sha: 'bbb2222', subject: 'Middle' },
    { sha: 'ccc3333', subject: 'Older' },
    { sha: 'ddd4444', subject: 'Oldest' }
  ]
  const branches = [{ name: 'feat/billing', sha: 'aaa1111', subject: 'Newest' }]
  const prs = [{ number: 42, title: 'Billing rework', headRefName: 'feat/billing' }]

  assert.deepEqual(parseInteractiveChoice('2', commits, branches, prs), { mode: 'ref', ref: 'bbb2222' })
  assert.deepEqual(parseInteractiveChoice('b1', commits, branches, prs), { mode: 'ref', ref: 'feat/billing' })
  assert.deepEqual(parseInteractiveChoice('p1', commits, branches, prs), { mode: 'ref', ref: 'pr#42', label: 'PR #42: Billing rework' })
  assert.deepEqual(parseInteractiveChoice('pr#7', commits, branches, prs), { mode: 'ref', ref: 'pr#7' })

  // Ranges and multi-index lists return commits oldest-first for clean cherry-picking.
  assert.deepEqual(parseInteractiveChoice('4..2', commits, branches, prs), { mode: 'commits', commits: ['ddd4444', 'ccc3333', 'bbb2222'] })
  assert.deepEqual(parseInteractiveChoice('1, 3', commits, branches, prs), { mode: 'commits', commits: ['ccc3333', 'aaa1111'] })
})

test('formatDevReleaseNotes embeds parseable metadata comment without breaking human notes', async () => {
  const { parseDevMeta, parseDevRelease, stripDevMetaComment, compareVeyraVersions } = await import('../src/shared/dev-builds.ts')
  const body = formatDevReleaseNotes(
    {
      commit: '99cde06',
      fullCommit: '99cde06000000000000000000000000000000000',
      branch: 'feat/billing',
      label: 'Billing rework',
      dirty: false,
      commits: [{ sha: '99cde06', subject: 'Rework Plan & billing screen' }]
    },
    '26.11.5-dev.202611210145',
    'dev-26.11.5-dev.202611210145'
  )

  assert.match(body, /\*\*Billing rework\*\*/)
  assert.doesNotMatch(stripDevMetaComment(body), /veyra-dev-meta/)

  const meta = parseDevMeta(body)
  assert.equal(meta.commit, '99cde06')
  assert.equal(meta.branch, 'feat/billing')
  assert.equal(meta.label, 'Billing rework')
  assert.equal(meta.commits?.[0]?.subject, 'Rework Plan & billing screen')

  const rel = parseDevRelease(
    {
      tag_name: 'dev-26.11.5-dev.202611210145',
      body,
      published_at: '2026-11-21T01:45:00Z',
      assets: [{ name: 'Veyra-Study-Dev-Setup.exe' }, { name: 'latest.yml' }, { name: 'Veyra-Study-Dev.apk' }]
    },
    '26.11.5-dev.202611210145'
  )
  assert.ok(rel)
  assert.equal(rel.current, true)
  assert.equal(rel.hasWindows, true)
  assert.equal(rel.hasAndroid, true)
  assert.equal(rel.commit, '99cde06')

  // Legacy Dev release notes (before metadata comments) still parse commit & dirty flag.
  const legacy = parseDevRelease(
    {
      tag_name: 'dev-26.11.5-dev.202611200900',
      body: 'Test build from d5eb9b6 + uncommitted changes.\n\nWindows: Veyra-Study-Dev-Setup.exe',
      published_at: '2026-11-20T09:00:00Z',
      assets: [{ name: 'Veyra-Study-Dev-Setup.exe' }, { name: 'latest.yml' }]
    },
    '26.11.5-dev.202611210145'
  )
  assert.ok(legacy)
  assert.equal(legacy.commit, 'd5eb9b6')
  assert.equal(legacy.dirty, true)
  assert.equal(legacy.hasWindows, true)
  assert.equal(legacy.hasAndroid, false)

  // Version comparison orders newer Dev timestamps ahead of older ones.
  assert.ok(compareVeyraVersions('26.11.5-dev.202611210145', '26.11.5-dev.202611200900') > 0)
  assert.ok(compareVeyraVersions('26.11.5-dev.202611200900', '26.11.5-dev.202611210145') < 0)
  assert.ok(compareVeyraVersions('26.12.1-dev.202612010000', '26.11.9-dev.202611302359') > 0)
})

test('prepareDevWorktree checks out a single ref or cherry-picks selected commits without touching main repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'veyra-dev-select-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '26.11.4' }, null, 2) + '\n')
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
    mkdirSync(join(repo, 'node_modules', 'dummy'), { recursive: true })
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial base')
    const baseSha = git('rev-parse', 'HEAD')

    writeFileSync(join(repo, 'a.txt'), 'feature A\n')
    git('add', 'a.txt')
    git('commit', '-m', 'Add feature A')
    const shaA = git('rev-parse', 'HEAD')

    writeFileSync(join(repo, 'b.txt'), 'feature B\n')
    git('add', 'b.txt')
    git('commit', '-m', 'Add feature B')
    const shaB = git('rev-parse', 'HEAD')

    // Dirty uncommitted file in main checkout must remain untouched!
    writeFileSync(join(repo, 'dirty.txt'), 'keep me\n')

    // 1) Single ref checkout at shaA: has a.txt, not b.txt, not dirty.txt, and links node_modules.
    const one = prepareDevWorktree({ repoDir: repo, ref: shaA, label: 'Only A' })
    try {
      assert.equal(existsSync(join(one.dir, 'a.txt')), true)
      assert.equal(existsSync(join(one.dir, 'b.txt')), false)
      assert.equal(existsSync(join(one.dir, 'dirty.txt')), false)
      assert.equal(existsSync(join(one.dir, 'node_modules', 'dummy')), true)
      assert.equal(one.meta.label, 'Only A')
      assert.equal(one.meta.commit, shaA.slice(0, 7))
    } finally {
      one.cleanup()
    }
    assert.equal(existsSync(one.dir), false)

    // 2) Cherry-pick ONLY shaB onto baseSha: has b.txt, NOT a.txt!
    const picked = prepareDevWorktree({ repoDir: repo, commits: [shaB], base: baseSha, label: 'Just B' })
    try {
      assert.equal(existsSync(join(picked.dir, 'b.txt')), true)
      assert.equal(existsSync(join(picked.dir, 'a.txt')), false)
      assert.equal(picked.meta.commits.length, 1)
      assert.equal(picked.meta.commits[0].subject, 'Add feature B')
    } finally {
      picked.cleanup()
    }

    // Main repo's dirty file, node_modules, and HEAD are completely untouched.
    assert.equal(existsSync(join(repo, 'node_modules', 'dummy')), true)
    assert.equal(readFileSync(join(repo, 'dirty.txt'), 'utf8'), 'keep me\n')
    assert.equal(git('rev-parse', 'HEAD'), shaB)
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
