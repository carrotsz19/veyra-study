#!/usr/bin/env node
/**
 * Scans release files on VirusTotal and adds the results to the GitHub release's notes.
 *
 *   node tools/virustotal.mjs v1.0.1 release/Veyra-Study-Setup-1.0.1.exe
 *   node tools/virustotal.mjs android-v1.0.1 release-android/Veyra-Study-1.0.1.apk
 *
 * The API key is read from VIRUSTOTAL_KEY or C:\dev\tools\virustotal.key (never in the repo).
 * Files already known to VirusTotal (by their SHA-256) aren't uploaded again. A free key allows
 * 4 requests a minute, so this waits between checks. Release scripts run it after publishing.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

const REPO = 'carrotsz19/veyra-study'
const KEY_FILE = 'C:/dev/tools/virustotal.key'
const key = (process.env.VIRUSTOTAL_KEY || (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8') : '')).trim()
const API = 'https://www.virustotal.com/api/v3'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function vt(path, init = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, { ...init, headers: { 'x-apikey': key, ...(init.headers || {}) } })
    // Over the free limit (4 a minute): wait and try again.
    if (res.status === 429 && i < 10) {
      await sleep(20_000)
      continue
    }
    return res
  }
}

/** The file's finished scan on VirusTotal (uploading it first if VirusTotal hasn't seen it). */
export async function scan(file) {
  const bytes = readFileSync(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const name = basename(file)
  let report = await vt(`/files/${sha256}`)
  if (report.status === 404) {
    console.log(`Uploading ${name} to VirusTotal…`)
    // Bigger than 32 MB needs a one-off upload address.
    let url = `${API}/files`
    if (bytes.length > 32 * 1024 * 1024) url = (await (await vt('/files/upload_url')).json()).data
    const form = new FormData()
    form.append('file', new Blob([bytes]), name)
    const up = await vt(url, { method: 'POST', body: form })
    if (!up.ok) throw new Error(`VirusTotal refused the upload (${up.status}): ${(await up.text()).slice(0, 200)}`)
    const analysis = (await up.json()).data.id
    // Wait for the engines (usually a few minutes).
    for (let i = 0; i < 60; i++) {
      await sleep(20_000)
      const a = await (await vt(`/analyses/${analysis}`)).json()
      if (a.data?.attributes?.status === 'completed') break
      if (i % 3 === 2) console.log(`  still scanning ${name}…`)
    }
    report = await vt(`/files/${sha256}`)
  }
  if (!report.ok) throw new Error(`VirusTotal answered ${report.status} for ${name}.`)
  const s = (await report.json()).data.attributes.last_analysis_stats
  const total = (s.malicious || 0) + (s.suspicious || 0) + (s.undetected || 0) + (s.harmless || 0)
  return { name, sha256, malicious: s.malicious || 0, suspicious: s.suspicious || 0, total, link: `https://www.virustotal.com/gui/file/${sha256}` }
}

/** The "VirusTotal" part of the release notes (replaced, not repeated, when run again). */
export function notesSection(results) {
  const lines = results.map((r) => {
    const flagged = r.malicious + r.suspicious
    const verdict = flagged === 0 ? `no detections (0 of ${r.total} engines)` : `${flagged} of ${r.total} engines flagged it`
    return `- [${r.name}](${r.link}): ${verdict}\n  SHA-256 \`${r.sha256}\``
  })
  return `### VirusTotal\n\n${lines.join('\n')}`
}

export async function addToRelease(tag, files) {
  if (!key) {
    console.warn('No VirusTotal key (C:\\dev\\tools\\virustotal.key): skipped the scan.')
    return
  }
  const results = []
  for (const f of files) results.push(await scan(f))
  const body = execFileSync('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'body', '--jq', '.body'], { encoding: 'utf8' }).replace(/\r\n/g, '\n').trimEnd()
  const without = body.replace(/\n*### VirusTotal\n[\s\S]*$/, '')
  execFileSync('gh', ['release', 'edit', tag, '--repo', REPO, '--notes', `${without}\n\n${notesSection(results)}\n`], { stdio: 'inherit' })
  for (const r of results) console.log(`${r.name}: ${r.malicious + r.suspicious} of ${r.total} flagged · ${r.link}`)
}

if (process.argv[1] && basename(process.argv[1]) === 'virustotal.mjs') {
  const [tag, ...files] = process.argv.slice(2)
  if (!tag || !files.length) {
    console.error('Usage: node tools/virustotal.mjs <release tag> <file> [file…]')
    process.exit(1)
  }
  await addToRelease(tag, files)
}
