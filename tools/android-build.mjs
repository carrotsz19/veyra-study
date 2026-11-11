#!/usr/bin/env node
// Builds the Android app (an APK you can install) with the tools from setup-android.mjs.
//   node tools/android-build.mjs [--install]   (--install: onto the phone plugged in by USB)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = process.env.VEYRA_TOOLS || 'C:/dev/tools'
const env = { ...process.env, JAVA_HOME: join(TOOLS, 'jdk-21'), ANDROID_HOME: join(TOOLS, 'android-sdk'), ANDROID_SDK_ROOT: join(TOOLS, 'android-sdk') }
if (!existsSync(join(env.JAVA_HOME, 'bin', 'java.exe'))) throw new Error('Run node tools/setup-android.mjs first.')
const run = (cmd, args, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npx', ['vite', 'build', '--config', 'mobile/vite.config.ts'])
run('npx', ['cap', 'sync', 'android'])
run(join(process.cwd(), 'android', 'gradlew.bat'), ['assembleDebug', '--console=plain'], join(process.cwd(), 'android'))
const apk = join(process.cwd(), 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
console.log('\nAPK:', apk)
if (process.argv.includes('--install')) {
  const adb = join(env.ANDROID_HOME, 'platform-tools', 'adb.exe')
  execFileSync(adb, ['install', '-r', apk], { stdio: 'inherit' })
}
