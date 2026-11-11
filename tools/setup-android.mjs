#!/usr/bin/env node
/**
 * Installs what building the Android app needs, without admin rights and
 * without touching the system PATH:
 *   C:\dev\tools\jdk-21         Microsoft Build of OpenJDK 21
 *   C:\dev\tools\android-sdk    Android command-line tools, platform 36, build tools, platform tools (adb)
 * Every download is checked against the checksum its publisher lists.
 *
 *   node tools/setup-android.mjs
 * Then build with: npm run android:build
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = process.env.VEYRA_TOOLS || 'C:\\dev\\tools'
const JDK = join(TOOLS, 'jdk-21')
const SDK = join(TOOLS, 'android-sdk')
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const PACKAGES = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0']

const log = (...a) => console.log('•', ...a)
async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'VeyraStudy-setup' }, redirect: 'follow' })
  if (!r.ok) throw new Error(`${url} answered ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
function check(buf, algo, want, what) {
  const got = createHash(algo).update(buf).digest('hex')
  if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`${what} didn’t match its ${algo} checksum (got ${got}, expected ${want}). Nothing was installed.`)
  log(`${what}: ${algo} checksum OK`)
}
function unzip(buf, dest, name) {
  mkdirSync(TOOLS, { recursive: true })
  const zip = join(TOOLS, `${name}.zip`)
  writeFileSync(zip, buf)
  const tmp = join(TOOLS, `${name}.tmp`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  execFileSync(TAR, ['-xf', zip, '-C', tmp])
  rmSync(zip, { force: true })
  return tmp
}

// 1. Java 21
if (!existsSync(join(JDK, 'bin', 'java.exe'))) {
  log('Downloading Java 21 (Microsoft Build of OpenJDK)…')
  const url = 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip'
  const sum = (await get(url + '.sha256sum.txt')).toString().trim().split(/\s+/)[0]
  const zip = await get(url)
  check(zip, 'sha256', sum, 'Java 21')
  const tmp = unzip(zip, JDK, 'jdk')
  const inner = readdirSync(tmp).find((d) => existsSync(join(tmp, d, 'bin', 'java.exe')))
  if (!inner) throw new Error('Java didn’t unpack as expected.')
  rmSync(JDK, { recursive: true, force: true })
  renameSync(join(tmp, inner), JDK)
  rmSync(tmp, { recursive: true, force: true })
} else log('Java 21 is already there.')

// 2. Android command-line tools (sdkmanager)
const sdkmanager = join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat')
if (!existsSync(sdkmanager)) {
  log('Finding the latest Android command-line tools…')
  const xml = (await get('https://dl.google.com/android/repository/repository2-3.xml')).toString()
  const pkg = xml.match(/<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/)?.[1]
  const archive = pkg && [...pkg.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((m) => m[1]).find((a) => /<host-os>windows<\/host-os>/.test(a))
  const file = archive?.match(/<url>([^<]+)<\/url>/)?.[1]
  const sha1 = archive?.match(/<checksum type="sha1">([^<]+)<\/checksum>/)?.[1]
  if (!file || !sha1) throw new Error('Couldn’t find the Android command-line tools download.')
  log('Downloading', file)
  const zip = await get('https://dl.google.com/android/repository/' + file)
  check(zip, 'sha1', sha1, 'Android command-line tools')
  const tmp = unzip(zip, SDK, 'cmdline-tools')
  mkdirSync(join(SDK, 'cmdline-tools'), { recursive: true })
  rmSync(join(SDK, 'cmdline-tools', 'latest'), { recursive: true, force: true })
  renameSync(join(tmp, 'cmdline-tools'), join(SDK, 'cmdline-tools', 'latest'))
  rmSync(tmp, { recursive: true, force: true })
} else log('Android command-line tools are already there.')

// 3. Licences and packages (sdkmanager checks its own downloads)
const env = { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK }
log('Accepting the Android SDK licences…')
spawnSync('cmd.exe', ['/c', sdkmanager, '--licenses', `--sdk_root=${SDK}`], { env, input: 'y\n'.repeat(30), stdio: ['pipe', 'ignore', 'inherit'] })
log('Installing', PACKAGES.join(', '), '(a few minutes)…')
// Quoted: cmd.exe would split "platforms;android-36" at the semicolon.
const line = `"${sdkmanager}" --sdk_root="${SDK}" ${PACKAGES.map((p) => `"${p}"`).join(' ')}`
const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, input: 'y\n'.repeat(10), stdio: ['pipe', 'inherit', 'inherit'], windowsVerbatimArguments: true })
if (r.status !== 0) throw new Error('sdkmanager failed.')
for (const p of PACKAGES) if (!existsSync(join(SDK, ...p.split(';')))) throw new Error(`${p} didn’t install.`)
writeFileSync(join(process.cwd(), 'android', 'local.properties'), `sdk.dir=${SDK.replace(/\\/g, '\\\\')}\n`)
log('Done. Java:', JDK, ' SDK:', SDK)
