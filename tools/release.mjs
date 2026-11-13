#!/usr/bin/env node
/**
 * Publishes the Windows app. Two kinds of build:
 *
 *  Prod: the real Veyra Study everyone uses.
 *   1. bump "version" in package.json (e.g. 0.2.0 → 0.2.1), add its section
 *      to CHANGELOG.md, and commit
 *   2. npm run release
 *  It builds the app and the installer and publishes them as a GitHub release
 *  (tag v<version>) on carrotsz19/veyra-study. Installed copies find it at their
 *  next start, through GitHub's release pages (not its rate-limited API).
 *
 *  Dev: "Veyra Study Dev", a test build that installs next to the real app
 *  (its own name, data and updates), for trying changes before they go out.
 *   npm run release:dev     (no version bump or changelog needed; uncommitted work is fine)
 *  It's versioned <next version>-dev.<date and time> and published as a release in
 *  the private repo carrotsz19/veyra-study-dev (only you can see it; the newest 10
 *  are kept). Veyra Study Dev reads it with a read-only token built into Dev
 *  builds (C:dev	oolseyra-dev-feed.token); Prod never sees it.
 *
 * Android builds are published separately (tools/release-android.mjs) and always
 * as pre-releases, so the Windows updater (which follows the latest full release)
 * never mistakes one for a Windows update.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'carrotsz19/veyra-study'
/** Private: Dev test builds (only you can see them). */
const DEV_REPO = 'carrotsz19/veyra-study-dev'
const dev = process.argv.includes('--dev')
const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const gh = (args, env) => execFileSync('gh', args, { encoding: 'utf8', env })

let token = process.env.GH_TOKEN
if (!token) {
  try {
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    console.error('Sign in with the GitHub CLI first (gh auth login), or set GH_TOKEN.')
    process.exit(1)
  }
}
const ghEnv = { ...process.env, GH_TOKEN: token }
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

if (dev) {
  // The next version, marked as a test build: 0.2.12 → 0.2.13-dev.202611121905.
  const [a, b, c] = version.split('.').map(Number)
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
  const devVersion = `${a}.${b}.${c + 1}-dev.${stamp}`
  const commit = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? ' + uncommitted changes' : '')
  console.log(`Publishing Veyra Study Dev ${devVersion} (${commit})…`)
  const env = { ...process.env, VEYRA_CHANNEL: 'dev', VEYRA_VERSION: devVersion }
  run('npm', ['run', 'typecheck'], env)
  // Start clean, so nothing from an earlier test build is published by mistake.
  rmSync('release-dev', { recursive: true, force: true })
  run('npx', ['electron-vite', 'build'], env)
  run('npx', ['electron-builder', '--win', '--publish', 'never', '--config', 'electron-builder.dev.cjs'], env)

  // A release in the private test-build repo (only you can see it), marked newest:
  // Dev apps read it with their read-only token. Windows looks for latest.yml there.
  // (Written here from the installer just built: for a private repo electron-builder leaves it out.)
  const exe = join('release-dev', 'Veyra-Study-Dev-Setup.exe')
  const sha512 = createHash('sha512').update(readFileSync(exe)).digest('base64')
  const size = statSync(exe).size
  const yml = `version: ${devVersion}\nfiles:\n  - url: Veyra-Study-Dev-Setup.exe\n    sha512: ${sha512}\n    size: ${size}\npath: Veyra-Study-Dev-Setup.exe\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`
  writeFileSync(join('release-dev', 'latest.yml'), yml)
  const tag = `dev-${devVersion}`
  const notesFile = join('release-dev', 'notes.md')
  writeFileSync(notesFile, `Test build from ${commit}.\n\nWindows: Veyra-Study-Dev-Setup.exe · Android: Veyra-Study-Dev.apk ("Veyra Dev"). Installed Dev apps update themselves.`)
  const files = ['Veyra-Study-Dev-Setup.exe', 'Veyra-Study-Dev-Setup.exe.blockmap', 'latest.yml'].map((f) => join('release-dev', f))
  execFileSync('gh', ['release', 'create', tag, ...files, '--repo', DEV_REPO, '--title', `Veyra Study Dev ${devVersion}`, '--notes-file', notesFile, '--latest'], { stdio: 'inherit', env: ghEnv })
  // Then the Android test build, onto the same release (unless --windows-only).
  if (!process.argv.includes('--windows-only')) run('node', ['tools/release-android.mjs', '--dev'], { ...env, GH_TOKEN: token, VEYRA_DEV_TAG: tag })
  // Keep the newest 10 test builds.
  const old = gh(['release', 'list', '--repo', DEV_REPO, '--limit', '100', '--json', 'tagName', '--jq', '.[].tagName'], ghEnv)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(10)
  for (const t of old) execFileSync('gh', ['release', 'delete', t, '--repo', DEV_REPO, '--cleanup-tag', '--yes'], { stdio: 'inherit', env: ghEnv })
  console.log(`\nDone: Veyra Study Dev ${devVersion}\nhttps://github.com/${DEV_REPO}/releases/tag/${tag}`)
  process.exit(0)
}

if (git('status', '--porcelain')) {
  console.error('Commit your changes first, so the release matches what is in git.')
  process.exit(1)
}
const tags = git('ls-remote', '--tags', 'origin', `v${version}`)
if (tags) {
  console.error(`v${version} is already released. Bump "version" in package.json first.`)
  process.exit(1)
}
// The notes are this version's section of CHANGELOG.md (shown in Settings → Software update).
const changelog = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n')
const section = changelog.split(/^## /m).find((part) => part.split('\n')[0].trim() === version)
const notes = section?.split('\n').slice(1).join('\n').trim()
if (!notes) {
  console.error(`Add a "## ${version}" section to CHANGELOG.md first: it becomes the release notes.`)
  process.exit(1)
}
console.log(`Publishing Veyra Study ${version}…`)
// Always a Prod build, whatever is set in the environment.
const prodEnv = { ...process.env, VEYRA_CHANNEL: 'prod', VEYRA_VERSION: '' }
run('npm', ['run', 'build'], prodEnv)
// Make the release first: electron-builder uploads its files in parallel, and when the release
// doesn't exist yet two uploads each try to create it and one fails.
// Run directly (not through the shell, which would split the notes at every space).
execFileSync('gh', ['release', 'create', `v${version}`, '--target', git('rev-parse', 'HEAD'), '--title', `Veyra Study ${version}`, '--notes', `${notes}

**Install:** download Veyra-Study-Setup-${version}.exe below and run it. Installed copies update themselves.`], { stdio: 'inherit', env: ghEnv })
run('npx', ['electron-builder', '--win', '--publish', 'always'], { ...prodEnv, GH_TOKEN: token })
// Scan the installer on VirusTotal and add the result to the notes (never stops the release).
try {
  await (await import('./virustotal.mjs')).addToRelease(`v${version}`, [join('release', `Veyra-Study-Setup-${version}.exe`)])
} catch (e) {
  console.warn('VirusTotal scan skipped:', e.message)
}
console.log(`\nDone: https://github.com/${REPO}/releases/tag/v${version}`)
