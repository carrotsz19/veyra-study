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
 *  It's versioned <next version>-dev.<date and time> and replaces the files of
 *  one GitHub pre-release, "dev-latest". Only Veyra Study Dev looks there.
 *
 * Android builds are published separately (tools/release-android.mjs) and always
 * as pre-releases, so the Windows updater (which follows the latest full release)
 * never mistakes one for a Windows update.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'carrotsz19/veyra-study'
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
  run('npx', ['electron-vite', 'build'], env)
  run('npx', ['electron-builder', '--win', '--publish', 'never', '--config', 'electron-builder.dev.cjs'], env)

  // One pre-release, "dev-latest", whose files are replaced each time.
  try {
    gh(['release', 'view', 'dev-latest', '--repo', REPO], ghEnv)
  } catch {
    gh(['release', 'create', 'dev-latest', '--repo', REPO, '--prerelease', '--title', 'Veyra Study Dev (test builds)', '--notes', 'Test builds.'], ghEnv)
  }
  const files = readdirSync('release-dev')
    .filter((f) => (f.endsWith('.yml') && f !== 'builder-debug.yml') || f.startsWith('Veyra-Study-Dev-Setup'))
    .map((f) => join('release-dev', f))
  execFileSync('gh', ['release', 'upload', 'dev-latest', ...files, '--clobber', '--repo', REPO], { stdio: 'inherit', env: ghEnv })
  // Then the Android test build, with the same version (unless --windows-only).
  const android = !process.argv.includes('--windows-only')
  if (android) run('node', ['tools/release-android.mjs', '--dev'], { ...env, GH_TOKEN: token })
  const notesFile = join('release-dev', 'notes.md')
  writeFileSync(
    notesFile,
    `**Test builds, not for everyday use.** Veyra Study Dev installs next to Veyra Study, with its own data, and updates itself from here.\n\n- Version ${devVersion} (${commit})\n\n**Install:** on Windows, Veyra-Study-Dev-Setup.exe${android ? '; on Android, Veyra-Study-Dev.apk ("Veyra Dev")' : ''}.`
  )
  execFileSync('gh', ['release', 'edit', 'dev-latest', '--repo', REPO, '--prerelease', '--notes-file', notesFile], { stdio: 'inherit', env: ghEnv })
  console.log(`\nDone: Veyra Study Dev ${devVersion}\nhttps://github.com/${REPO}/releases/tag/dev-latest`)
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
console.log(`\nDone: https://github.com/${REPO}/releases/tag/v${version}`)
