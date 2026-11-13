#!/usr/bin/env node
/**
 * Publishes the website: the phone app's code built for a browser (mobile/vite.config.ts
 * with VEYRA_WEB=1), as a Cloudflare Worker that only serves those files (free).
 *
 *   npm run release:web:dev   → https://veyra-study-dev.igreenrobotz.workers.dev   (test site)
 *   npm run release:web       → https://veyra-study-web.igreenrobotz.workers.dev   (Prod: only when the owner says so)
 *
 * The Worker (web/worker.js) serves the files and passes sign-in, the relay and the group
 * server through the site's own address (the account service only answers the apps).
 * It keeps people's sessions in tokens encrypted with WEB_SESSION_KEY, a secret made here
 * the first time (straight into Cloudflare; it's never shown or saved anywhere else).
 * The site never contains the Dev feed token (web builds leave it out; this checks).
 *
 * Wrangler runs in a temporary folder: run inside this repo, it "sets the project up"
 * by itself (adds packages, scripts and config files).
 *
 * Going back to an earlier version: Cloudflare keeps every upload.
 *   npx wrangler rollback --name <worker>   (the one before), or pick one in the dashboard
 *   (Workers & Pages → the Worker → Deployments), or run this script from an older commit.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dev = process.argv.includes('--dev')
const worker = dev ? 'veyra-study-dev' : 'veyra-study-web'
const run = (cmd, args, env = process.env, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, cwd, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const [a, b, c] = version.split('.').map(Number)
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
const siteVersion = dev ? `${a}.${b}.${c + 1}-dev.${stamp}` : version
const env = { ...process.env, VEYRA_WEB: '1', VEYRA_CHANNEL: dev ? 'dev' : 'prod', VEYRA_VERSION: siteVersion }

console.log(`Building the ${dev ? 'Dev ' : ''}website ${siteVersion}…`)
run('npm', ['run', 'typecheck'], env)
run('npx', ['vite', 'build', '--config', 'mobile/vite.config.ts'], env)

// Never publish the private repo's token (the site's code is public).
const out = join('web', 'dist')
const tokenFile = 'C:/dev/tools/veyra-dev-feed.token'
if (existsSync(tokenFile)) {
  const token = readFileSync(tokenFile, 'utf8').trim()
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  for (const f of walk(out)) {
    if (token && readFileSync(f, 'utf8').includes(token)) {
      console.error(`Stopped: ${f} contains the Dev feed token. Nothing was published.`)
      process.exit(1)
    }
  }
}

// A temporary folder with the site and the Worker's settings.
const tmp = mkdtempSync(join(tmpdir(), 'veyra-web-'))
cpSync(out, join(tmp, 'site'), { recursive: true })
// Safer defaults; the built files have hashed names, so browsers can keep them for good.
const headers = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Frame-Options: DENY',
  // Only the site's own scripts run, and it only talks to its own address (web/worker.js passes the rest on).
  "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  '  Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  ''
].join('\n')
writeFileSync(join(tmp, 'site', '_headers'), headers)
cpSync(join('web', 'worker.js'), join(tmp, 'worker.js'))
// /api/* runs the Worker; any other address opens the app (it has its own screens).
const config = {
  name: worker,
  main: './worker.js',
  compatibility_date: '2026-09-25',
  workers_dev: true,
  preview_urls: false,
  assets: { directory: './site', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
  // Workers on this account reach each other this way (not by their workers.dev address).
  services: [
    { binding: 'VEYRA', service: 'veyra' },
    { binding: 'RELAY', service: 'veyra-study-relay' }
  ]
}
writeFileSync(join(tmp, 'wrangler.jsonc'), JSON.stringify(config, null, 2))
const wrangler = (args, input) =>
  spawnSync('npx', ['-y', 'wrangler@4.161.0', ...args], { cwd: tmp, env: { ...process.env, CI: '1' }, input, encoding: 'utf8', shell: process.platform === 'win32' })
run('npx', ['-y', 'wrangler@4.161.0', 'deploy'], { ...process.env, CI: '1' }, tmp)
// The key for people's session tokens: made once per site, piped straight in (never printed).
const secrets = wrangler(['secret', 'list', '--format', 'json'])
if (secrets.status === 0 && !/"WEB_SESSION_KEY"/.test(secrets.stdout)) {
  const set = wrangler(['secret', 'put', 'WEB_SESSION_KEY'], randomBytes(32).toString('base64url'))
  if (set.status !== 0) {
    console.error('Couldn’t set WEB_SESSION_KEY, so signing in on the site won’t work yet.')
    process.exit(1)
  }
  console.log('Made the key for website sign-in sessions (WEB_SESSION_KEY).')
} else if (secrets.status !== 0) console.warn('Couldn’t check the site’s secrets; signing in may not work until WEB_SESSION_KEY is set.')
rmSync(tmp, { recursive: true, force: true })
console.log(`\nDone: https://${worker}.igreenrobotz.workers.dev  (${siteVersion})`)
