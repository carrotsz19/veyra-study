#!/usr/bin/env node
/**
 * Publishes the Android app.
 *
 *  Prod: npm run release:android
 *   After the Windows release of the same version (package.json + CHANGELOG.md).
 *   Builds the APK and publishes it as the pre-release android-v<version>
 *   (asset Veyra-Study-<version>.apk); the phone app finds it in
 *   Settings → Software update. Always a pre-release, so the Windows updater
 *   (which follows the latest full release) never mistakes it for its own.
 *
 *  Dev: npm run release:dev (with the Windows Dev build), or this with --dev
 *   Builds "Veyra Dev" (app.veyra.study.dev: installs next to the real app,
 *   with its own data) and adds Veyra-Study-Dev.apk to the test build's release
 *   in the private repo carrotsz19/veyra-study-dev.
 *
 *  --install also puts the build on the phone plugged in by USB (with USB debugging on).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'carrotsz19/veyra-study'
/** Private: Dev test builds (only you can see them). */
const DEV_REPO = 'carrotsz19/veyra-study-dev'
const dev = process.argv.includes('--dev')
const install = process.argv.includes('--install')
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
let token = process.env.GH_TOKEN
if (!token) token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
const ghEnv = { ...process.env, GH_TOKEN: token }
const gh = (args) => execFileSync('gh', args, { stdio: 'inherit', env: ghEnv })

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
// Dev: the same version scheme as the Windows Dev build (0.2.12 → 0.2.13-dev.<date and time>).
const [a, b, c] = version.split('.').map(Number)
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
const appVersion = dev ? process.env.VEYRA_VERSION || `${a}.${b}.${c + 1}-dev.${stamp}` : version
const env = { ...process.env, VEYRA_CHANNEL: dev ? 'dev' : 'prod', VEYRA_VERSION: dev ? appVersion : '' }

if (!dev) {
  if (git('status', '--porcelain')) {
    console.error('Commit your changes first, so the release matches what is in git.')
    process.exit(1)
  }
  if (git('ls-remote', '--tags', 'origin', `android-v${version}`)) {
    console.error(`android-v${version} is already released. Bump "version" in package.json first.`)
    process.exit(1)
  }
}

console.log(`Building ${dev ? 'Veyra Dev' : 'Veyra Study'} ${appVersion} for Android…`)
const r = spawnSync('node', ['tools/android-build.mjs', ...(install ? ['--install'] : [])], { stdio: 'inherit', env, shell: process.platform === 'win32' })
if (r.status !== 0) process.exit(r.status ?? 1)
const built = join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
mkdirSync('release-android', { recursive: true })

if (dev) {
  // Onto the test build's release in the private repo: the one release:dev just made, or else the newest.
  const apk = join('release-android', 'Veyra-Study-Dev.apk')
  copyFileSync(built, apk)
  const tag = process.env.VEYRA_DEV_TAG || execFileSync('gh', ['release', 'view', '--repo', DEV_REPO, '--json', 'tagName', '--jq', '.tagName'], { encoding: 'utf8', env: ghEnv }).trim()
  gh(['release', 'upload', tag, apk, '--clobber', '--repo', DEV_REPO])
  console.log(`\nDone: Veyra Dev ${appVersion} for Android\nhttps://github.com/${DEV_REPO}/releases/tag/${tag}`)
} else {
  const apk = join('release-android', `Veyra-Study-${version}.apk`)
  copyFileSync(built, apk)
  const changelog = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n')
  const section = changelog.split(/^## /m).find((part) => part.split('\n')[0].trim() === version)
  const notes = section?.split('\n').slice(1).join('\n').trim() || `Veyra Study ${version} for Android.`
  const notesFile = join('release-android', 'notes.md')
  writeFileSync(notesFile, `${notes}\n\nInstall this APK once by hand if you're on 0.2.3 or older; after that, updates come from Settings → Software update.`)
  // GitHub's releases feed (which installed apps read) lists one tag per commit, and the Windows
  // tag v<version> sits on HEAD: so the Android tag gets a commit of its own (same files), or it's left out.
  const tagName = `android-v${version}`
  const own = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', `Veyra Study ${version} for Android`)
  git('tag', '-f', tagName, own)
  git('push', 'origin', `+refs/tags/${tagName}`)
  gh(['release', 'create', tagName, apk, '--repo', REPO, '--prerelease', '--verify-tag', '--title', `Veyra Study ${version} for Android`, '--notes-file', notesFile])
  console.log(`\nDone: https://github.com/${REPO}/releases/tag/android-v${version}`)
}
