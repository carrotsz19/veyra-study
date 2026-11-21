// Commit selection for Dev builds (tools/dev-select.mjs) + release metadata parsing (src/shared/dev-builds.ts).
// Run: node --test tests/dev-builds.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDevReleaseNotes, hasDevSelection, parseDevSelectArgs, parseInteractiveChoice, pickerInit, pickerItems, pickerKey, pickerRender, prepareDevWorktree, previewDevSelection } from '../tools/dev-select.mjs'

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

test('terminal picker: arrow keys, Space to select, filtering, tabs and Enter', () => {
  const c = {
    defaultBase: 'dev-repo/main',
    commits: [
      { sha: 'aaa1111', full: 'a'.repeat(40), subject: 'Newest billing fix', deco: 'HEAD -> dev', rel: '1 hour ago', author: 'me' },
      { sha: 'bbb2222', full: 'b'.repeat(40), subject: 'Middle export tweak', deco: '', rel: '2 hours ago', author: 'me' },
      { sha: 'ccc3333', full: 'c'.repeat(40), subject: 'Older billing copy', deco: '', rel: '3 hours ago', author: 'me' }
    ],
    branches: [
      { name: 'feat/billing', sha: 'aaa1111', subject: 'Newest billing fix', rel: '1 hour ago' },
      { name: 'dev-repo/main', sha: 'ccc3333', subject: 'Older billing copy', rel: '3 hours ago' }
    ],
    prs: [{ number: 9, title: 'Billing rework', headRefName: 'feat/billing', author: 'me' }]
  }
  const press = (s, ...keys) => keys.reduce((st, k) => pickerKey(st, c, typeof k === 'string' ? { name: k } : k), s)

  // Enter with nothing selected builds the highlighted commit as is.
  let s = press(pickerInit(c), 'down', 'return')
  assert.deepEqual(s.result, { mode: 'ref', ref: 'b'.repeat(40) })

  // Space selects (and moves down); Enter cherry-picks oldest first regardless of selection order.
  s = press(pickerInit(c), 'down', 'down', 'space', 'up', 'up', 'space', 'return')
  assert.deepEqual(s.result, { mode: 'commits', commits: ['c'.repeat(40), 'a'.repeat(40)] })

  // Typing filters; selections survive filtering; Esc clears the filter, then the selection, then quits.
  s = press(pickerInit(c), { name: 'b', str: 'b' }, { name: 'i', str: 'i' }, { name: 'l', str: 'l' }, { name: 'l', str: 'l' })
  assert.deepEqual(pickerItems(s, c).map((x) => x.sha), ['aaa1111', 'ccc3333'])
  s = press(s, 'down', 'space')
  assert.deepEqual(s.selected, ['c'.repeat(40)])
  s = press(s, 'escape')
  assert.equal(s.filter, '')
  assert.equal(pickerItems(s, c).length, 3)
  s = press(s, 'escape')
  assert.deepEqual(s.selected, [])
  assert.equal(press(s, 'escape').cancelled, true)
  assert.equal(press(pickerInit(c), { name: 'c', ctrl: true }).cancelled, true)

  // Tabs: branches and PRs build that ref; the PR gets a default label.
  assert.deepEqual(press(pickerInit(c), 'right', 'return').result, { mode: 'ref', ref: 'feat/billing' })
  assert.deepEqual(press(pickerInit(c), 'left', 'return').result, { mode: 'ref', ref: 'pr#9', label: 'PR #9: Billing rework' })

  // Base mode starts on the default base and only lists branches.
  const b = pickerInit(c, { mode: 'base' })
  assert.deepEqual(b.tabs, ['branches'])
  assert.deepEqual(press(b, 'return').result, { mode: 'ref', ref: 'dev-repo/main' })

  // Rendering fits the terminal and marks selected commits.
  const out = pickerRender(press(pickerInit(c), 'space'), c, { rows: 12, cols: 60 })
  assert.equal(out.split('\n').length, 12)
  assert.match(out, /\[x\] aaa1111/)
  assert.match(out, /1 selected/)
})

test('previewDevSelection lists what a ref adds over the base, and cherry-picks merge commits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'veyra-dev-preview-repo-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  try {
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '26.11.4' }, null, 2) + '\n')
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n')
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    git('add', '.')
    git('commit', '-m', 'Base')
    git('checkout', '-b', 'feat/x')
    writeFileSync(join(repo, 'x.txt'), 'x\n')
    git('add', 'x.txt')
    git('commit', '-m', 'Add x')
    git('checkout', 'main')
    git('merge', '--no-ff', '-m', 'Merge feat/x', 'feat/x')
    const mergeSha = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'other', 'HEAD~1')

    const p = previewDevSelection(repo, { ref: 'feat/x', base: 'other' })
    assert.equal(p.kind, 'ref')
    assert.equal(p.aheadCount, 1)
    assert.equal(p.commits[0].subject, 'Add x')
    assert.throws(() => previewDevSelection(repo, { ref: '--evil' }), /Invalid ref/)

    // A merge commit cherry-picks onto a base without it (applied against its first parent).
    const w = prepareDevWorktree({ repoDir: repo, commits: [mergeSha], base: 'other' })
    try {
      assert.equal(existsSync(join(w.dir, 'x.txt')), true)
    } finally {
      w.cleanup()
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('in-app builder turns a selection into release.mjs arguments and refuses unsafe values', async () => {
  const { buildReleaseArgs, cleanLabel, describeRequest, isSafeRef } = await import('../src/shared/dev-builder.ts')
  const sha = 'a'.repeat(40)

  assert.deepEqual(buildReleaseArgs({ mode: 'ref', ref: 'feat/billing', label: 'Billing UI' }), ['tools/release.mjs', '--dev', '--ref', 'feat/billing', '--label', 'Billing UI'])
  assert.deepEqual(buildReleaseArgs({ mode: 'ref', ref: 'pr#12', windowsOnly: true, web: true }), ['tools/release.mjs', '--dev', '--ref', 'pr#12', '--windows-only', '--web'])
  assert.deepEqual(buildReleaseArgs({ mode: 'commits', commits: [sha, 'bbb2222'], base: 'dev-repo/main' }), ['tools/release.mjs', '--dev', '--commits', `${sha},bbb2222`, '--base', 'dev-repo/main'])

  // Anything that could be read as a flag, a range, or shell syntax is refused.
  for (const ref of ['--upload-pack=evil', '-x', 'main..dev', 'a b', 'x;calc', 'x&calc', '$(x)', 'x|y', '', 'feat/', 'a//b', 'x.lock']) {
    assert.equal(isSafeRef(ref), false, ref)
    assert.throws(() => buildReleaseArgs({ mode: 'ref', ref }), /isn’t valid/, ref)
  }
  assert.throws(() => buildReleaseArgs({ mode: 'commits', commits: ['main'] }), /from the list/)
  assert.throws(() => buildReleaseArgs({ mode: 'commits', commits: [] }), /at least one/)
  assert.throws(() => buildReleaseArgs({ mode: 'commits', commits: [sha, sha] }), /twice/)
  assert.throws(() => buildReleaseArgs({ mode: 'commits', commits: [sha], base: '--evil' }), /base/)
  assert.throws(() => buildReleaseArgs({ mode: 'nope' }), /Choose/)

  // Labels: one line, no leading dashes (they would read as a flag), at most 80 characters.
  assert.equal(cleanLabel('  --  Billing\nrework\t  '), 'Billing rework')
  assert.equal(cleanLabel('x'.repeat(200)).length, 80)
  assert.deepEqual(buildReleaseArgs({ mode: 'ref', ref: 'dev', label: '--web' }), ['tools/release.mjs', '--dev', '--ref', 'dev', '--label', 'web'])
  assert.deepEqual(buildReleaseArgs({ mode: 'ref', ref: 'dev', label: '  ' }), ['tools/release.mjs', '--dev', '--ref', 'dev'])

  assert.equal(describeRequest({ mode: 'ref', ref: 'pr#9', label: 'Billing' }), 'Billing (PR #9)')
  assert.equal(describeRequest({ mode: 'commits', commits: [sha, sha], base: 'dev' }), '2 commits onto dev')
})
