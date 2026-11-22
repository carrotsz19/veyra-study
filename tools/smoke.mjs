// Stops a release when the built app can't open. Starts the unpacked app once with a
// throwaway profile (no update check, no real data), lets it draw its first screen, takes a
// screenshot and quits, then reads the app's own diagnostics log to see how it went.
//   node tools/smoke.mjs <unpacked app folder>
// Fails on: no exit within 90 s, no screenshot, no "window ready" in the log, or a crash,
// error, blank screen or failed load logged while opening (src/main/index.ts watchOpening).
// Versions from before the diagnostics log (26.11.4 and older, e.g. in a rollback) write no log:
// for them it checks only that the app exited by itself after drawing its screenshot.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node tools/smoke.mjs <unpacked app folder>')
const exe = readdirSync(dir).find((f) => f.endsWith('.exe') && !/^uninstall/i.test(f))
if (!exe) throw new Error(`No app .exe in ${dir}`)

const profile = mkdtempSync(join(tmpdir(), 'veyra-smoke-'))
const shot = join(profile, 'shot.png')
console.log(`Test launch: ${exe} (profile ${profile})`)

// Wait past the app's own "did it draw?" check (8 s after load) before the screenshot is taken.
const evalScript = 'new Promise((r) => setTimeout(r, 9500))'
// Not as plain Node, even if this shell has that set (an empty value still counts).
const env = { ...process.env, VEYRA_USERDATA: profile, VEYRA_NO_UPDATE: '1', VEYRA_SCREENSHOT: shot, VEYRA_EVAL: evalScript }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(join(dir, exe), [], {
  env,
  stdio: 'ignore',
  windowsHide: false
})
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => {
    child.kill()
    resolve(false)
  }, 90_000)
  child.on('exit', () => {
    clearTimeout(t)
    resolve(true)
  })
})

const logFile = join(profile, 'logs', 'diagnostics.log')
const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
const problems = []
if (!exited) problems.push('it didn’t finish within 90 seconds (stuck while opening?)')
if (log && !/ window ready name=main/.test(log)) problems.push('its main window never became ready')
for (const bad of ['couldn’t open', 'screen process gone', 'main error', 'main unhandled rejection', 'window failed to load', 'window preload error']) {
  const line = log.split('\n').find((l) => l.includes(` ${bad}`))
  if (line) problems.push(`log: ${line.replace(/^\S+ /, '')}`)
}
if (!existsSync(shot) || statSync(shot).size < 5000) problems.push('no screenshot of its first screen')

if (!log) console.log('No diagnostics log (an older version): checking only that it opened, drew its screen and closed.')
if (problems.length) {
  console.error('\nThe app failed its test launch, so nothing was released:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(`\nIts profile and log are kept for a look: ${profile}`)
  process.exit(1)
}
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
console.log('Test launch passed: the app opened and drew its first screen.')
