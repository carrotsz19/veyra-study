#!/usr/bin/env node
/**
 * Publishes a new version of the Windows app:
 *   1. bump "version" in package.json (e.g. 0.2.0 → 0.2.1) and commit
 *   2. npm run release
 * It builds the app and the installer and publishes them as a GitHub release
 * (tag v<version>) on carrotsz19/veyra-study. Installed copies find it at their
 * next start, through GitHub's release pages (not its rate-limited API).
 *
 * Android builds are published separately and always as pre-releases, so the
 * Windows updater (which follows the latest full release) never mistakes one
 * for a Windows update.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
if (git('status', '--porcelain')) {
  console.error('Commit your changes first, so the release matches what is in git.')
  process.exit(1)
}
const tags = git('ls-remote', '--tags', 'origin', `v${version}`)
if (tags) {
  console.error(`v${version} is already released. Bump "version" in package.json first.`)
  process.exit(1)
}
let token = process.env.GH_TOKEN
if (!token) {
  try {
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    console.error('Sign in with the GitHub CLI first (gh auth login), or set GH_TOKEN.')
    process.exit(1)
  }
}
console.log(`Publishing Veyra Study ${version}…`)
run('npm', ['run', 'build'])
// Make the release first: electron-builder uploads its files in parallel, and when the release
// doesn't exist yet two uploads each try to create it and one fails.
// Run directly (not through the shell, which would split the notes at every space).
execFileSync('gh', ['release', 'create', `v${version}`, '--target', git('rev-parse', 'HEAD'), '--title', `Veyra Study ${version}`, '--notes', `Install: download Veyra-Study-Setup-${version}.exe below and run it. Installed copies update themselves.`], { stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } })
run('npx', ['electron-builder', '--win', '--publish', 'always'], { ...process.env, GH_TOKEN: token })
console.log(`\nDone: https://github.com/carrotsz19/veyra-study/releases/tag/v${version}`)
