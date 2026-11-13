#!/usr/bin/env node
/**
 * Rolls everyone back to an earlier, good version, when a release turns out bad.
 *
 * Installed apps only ever move up: Windows follows the newest release and Android
 * refuses to install a lower version over a higher one. So a rollback publishes the
 * good version's code again under a new, higher version number, and every device
 * "updates" back to it by itself (Windows and Android alike). Data stays: the older
 * code keeps fields it doesn't know about, and sync carries on.
 *
 *   Prod:  node tools/rollback.mjs 1.0.0
 *          Rebuilds v1.0.0's code as the next version (e.g. 1.0.2 after a bad 1.0.1),
 *          releases it for Windows and Android, and moves package.json here past it.
 *          Only when the owner says to: it is a Prod release.
 *
 *   Dev:   node tools/rollback.mjs --dev <commit or tag>
 *          Publishes that commit as a new Dev test build (Dev apps move to it).
 *
 * Works in a separate checkout (a git worktree next to this folder), so this one isn't touched
 * until the release is out. The release itself uses the current tools (tools/release*.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dev = process.argv.includes('--dev')
const target = process.argv.slice(2).find((a) => !a.startsWith('--'))
const git = (args, cwd = HERE) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const run = (cmd, args, cwd, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`\nStopped: ${cmd} ${args.join(' ')} failed. The checkout is at ${cwd}; nothing here was changed.`)
    process.exit(r.status ?? 1)
  }
}

if (!target) {
  console.error('Which version? node tools/rollback.mjs 1.0.0   (or: --dev <commit or tag>)')
  process.exit(1)
}
if (!dev && git(['status', '--porcelain'])) {
  console.error('Commit your changes first: the rollback moves package.json and CHANGELOG.md here past the new version.')
  process.exit(1)
}

const ref = dev ? target : `v${target}`
try {
  git(['fetch', '--tags', '--quiet', 'origin'])
} catch {
  /* offline: use what's here */
}
let commit
try {
  commit = git(['rev-parse', '--verify', `${ref}^{commit}`])
} catch {
  console.error(`${ref} isn't known here. ${dev ? 'Use a commit or tag.' : `Is ${target} a released version (tag v${target})?`}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const [a, b, c] = pkg.version.split('.').map(Number)
// Prod: the next version after the one out now (the bad one).
const next = `${a}.${b}.${c + 1}`
const dir = resolve(HERE, '..', `veyra-rollback-${dev ? commit.slice(0, 8) : next}`)

console.log(dev ? `Publishing ${ref} (${commit.slice(0, 8)}) as a new Dev build…` : `Rolling back: v${target}'s code as Veyra Study ${next}…`)
if (existsSync(dir)) {
  try {
    git(['worktree', 'remove', '--force', dir])
  } catch {
    rmSync(dir, { recursive: true, force: true })
  }
}
git(['worktree', 'add', '--detach', dir, commit])

// What a build needs that isn't in git.
if (existsSync(join(HERE, 'google-client.json'))) copyFileSync(join(HERE, 'google-client.json'), join(dir, 'google-client.json'))
run('npm', ['ci', '--no-audit', '--no-fund'], dir)

if (dev) {
  // Dev builds are numbered from package.json: use today's, so the build counts as newer than the one installed.
  const old = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  old.version = pkg.version
  writeFileSync(join(dir, 'package.json'), JSON.stringify(old, null, 2) + '\n')
  run('node', [join(HERE, 'tools', 'release.mjs'), '--dev'], dir)
} else {
  // The version number and a changelog section (the release notes), committed on a branch of its own.
  const old = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  old.version = next
  writeFileSync(join(dir, 'package.json'), JSON.stringify(old, null, 2) + '\n')
  const note = `## ${next}\n\nThis is Veyra Study ${target} again: version ${pkg.version} had a problem, so it has been taken back. Your data is kept.\n\n`
  const log = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
  const at = log.indexOf('\n## ')
  writeFileSync(join(dir, 'CHANGELOG.md'), at < 0 ? log + '\n' + note : log.slice(0, at + 1) + note + log.slice(at + 1))
  git(['add', 'package.json', 'CHANGELOG.md'], dir)
  git(['commit', '-m', `Roll back to ${target} as ${next}`], dir)
  // GitHub needs the commit before a release can point at it.
  git(['push', 'origin', `HEAD:refs/heads/rollback/${next}`], dir)
  run('node', [join(HERE, 'tools', 'release.mjs')], dir)
  run('node', [join(HERE, 'tools', 'release-android.mjs')], dir)

  // Here: the next real release has to be above the rollback.
  const here = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  here.version = next
  writeFileSync(join(HERE, 'package.json'), JSON.stringify(here, null, 2) + '\n')
  const mine = readFileSync(join(HERE, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n')
  const i = mine.indexOf('\n## ')
  writeFileSync(join(HERE, 'CHANGELOG.md'), i < 0 ? mine + '\n' + note : mine.slice(0, i + 1) + note + mine.slice(i + 1))
  git(['add', 'package.json', 'CHANGELOG.md'])
  git(['commit', '-m', `Rolled back to ${target} as ${next}; the next release is above it`])
}

try {
  git(['worktree', 'remove', '--force', dir])
} catch {
  console.log(`(The checkout at ${dir} can be deleted.)`)
}
console.log(
  dev
    ? `\nDone: Dev apps will move to ${ref}'s build at their next check.`
    : `\nDone: Veyra Study ${next} (= ${target}) is out for Windows and Android; installed apps move to it by themselves.\nThe next release must be ${a}.${b}.${c + 2} or higher (package.json here says ${next}: bump it as usual).`
)
