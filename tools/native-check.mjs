// Stops a release when the Windows app would ship a compiled file (.exe/.dll/.node/.pyd) that
// isn't signed and isn't one of Electron's own. Smart App Control and school/work PC policies
// block unsigned compiled files, so a new native dependency must be a choice, not an accident.
//   node tools/native-check.mjs <unpacked app folder>
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'

/** Electron's own files (it ships them unsigned). Anything else unsigned fails the check. */
const ALLOWED = new Set(['dxcompiler.dll', 'electron_wer.dll', 'ffmpeg.dll', 'vk_swiftshader.dll', 'vulkan-1.dll', 'libegl.dll', 'libglesv2.dll', 'resources/elevate.exe'])
const NATIVE = /\.(exe|dll|node|pyd)$/i

const dir = process.argv[2]
if (!dir) throw new Error('usage: node tools/native-check.mjs <unpacked app folder>')

const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (NATIVE.test(e.name)) files.push(p)
  }
}
walk(dir)

// Compiled files packed inside app.asar can't even be loaded from there, so any is a mistake.
const asar = createRequire(import.meta.url)('@electron/asar')
const packed = asar.listPackage(join(dir, 'resources', 'app.asar')).filter((f) => NATIVE.test(f))

const ps = `$ErrorActionPreference='Stop'; $input | ForEach-Object { (Get-AuthenticodeSignature -LiteralPath $_).Status.ToString() }`
const status = execFileSync('powershell', ['-NoProfile', '-Command', ps], { input: files.join('\n'), encoding: 'utf8' }).trim().split(/\r?\n/)

const name = (p) => relative(dir, p).replace(/\\/g, '/')
const mainExe = (p) => !name(p).includes('/') && name(p).toLowerCase().endsWith('.exe')
const bad = files.filter((p, i) => status[i] !== 'Valid' && !mainExe(p) && !ALLOWED.has(name(p).toLowerCase())).map(name)
if (bad.length || packed.length) {
  console.error('\nUnsigned compiled files that are not Electron’s own (Smart App Control would block them):')
  for (const f of [...bad, ...packed.map((f) => `app.asar${f}`)]) console.error('  ' + f)
  console.error('\nRemove the dependency, or if it is accepted on purpose, add it to ALLOWED in tools/native-check.mjs.')
  process.exit(1)
}
console.log(`Native check: ${files.length} compiled files, none unexpected.`)
