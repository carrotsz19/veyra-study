#!/usr/bin/env node
/**
 * Ships a Prod release in one go:  npm run ship
 *
 *  1. picks the next version itself (year.month.n: 26.11.1, 26.11.2, then 26.12.1; tools/version.mjs)
 *  2. turns "## Unreleased" in CHANGELOG.md into that version's section (its "What's new").
 *     With no Unreleased section, the commits since the last release are listed instead.
 *  3. sets the version in package.json, commits "Veyra Study <version>" and pushes
 *  4. publishes Windows (npm run release), then Android (npm run release:android)
 *
 *  --windows-only skips Android.  --dry-run shows the version and notes, and changes nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nextVersion } from './version.mjs'
import { assertProdChannel } from './channels.mjs'

const dry = process.argv.includes('--dry-run')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const run = (script, args = []) => {
  const r = spawnSync('node', [join(import.meta.dirname, script), ...args], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n${script} failed. The version commit is already pushed: fix the problem, then run "node tools/${script}" again (it publishes the same version).`)
    process.exit(r.status ?? 1)
  }
}

try {
  assertProdChannel({ cwd: process.cwd() })
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = nextVersion(pkg.version)

// What's new: the Unreleased section, or else the commits since the last release.
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const unreleased = /^## Unreleased[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog)
let notes = unreleased?.[1].trim()
if (!notes) {
  const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
  notes = git('log', `${last}..HEAD`, '--no-merges', '--format=%s')
    .split('\n')
    .filter((s) => s && !/^(\d+\.\d+\.\d+|Veyra Study \d)/.test(s))
    .map((s) => `- ${s}`)
    .join('\n')
}
if (!notes) {
  console.error('Nothing new since the last release.')
  process.exit(1)
}
console.log(`Veyra Study ${pkg.version} → ${version}\n\n${notes}\n`)
if (dry) process.exit(0)

const section = `## ${version}\n\n${notes}\n\n`
const updated = unreleased ? changelog.replace(unreleased[0], section) : changelog.replace(/^## /m, `${section}## `)
writeFileSync('CHANGELOG.md', updated)
pkg.version = version
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
try {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
} catch {
  /* no lockfile */
}
git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md')
git('commit', '--quiet', '-m', `Veyra Study ${version}`)
git('push', '--quiet')

run('release.mjs')
if (!process.argv.includes('--windows-only')) run('release-android.mjs')
console.log(`\nShipped Veyra Study ${version} (Windows${process.argv.includes('--windows-only') ? '' : ' and Android'}).`)
console.log('Next: run `npm run release:web` to publish the Prod website, then sync `main` back into Dev via PR if needed.')
