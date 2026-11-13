#!/usr/bin/env node
/**
 * Publishes the website: the phone app's code built for a browser (mobile/vite.config.ts
 * with VEYRA_WEB=1), as a Cloudflare Worker that only serves those files (free).
 *
 *   npm run release:web:dev   → https://veyra-study-dev.igreenrobotz.workers.dev   (test site)
 *   npm run release:web       → https://veyra-study-web.igreenrobotz.workers.dev   (Prod: only when the owner says so)
 *
 * The site has no sign-in yet (the account service only answers the apps): it runs
 * without an account, and its data stays in the browser. It never contains the Dev
 * feed token (mobile/vite.config.ts leaves it out of web builds), and this script checks.
 *
 * Wrangler runs in a temporary folder: run inside this repo, it "sets the project up"
 * by itself (adds packages, scripts and config files).
 *
 * Going back to an earlier version: Cloudflare keeps every upload.
 *   npx wrangler rollback --name <worker>   (the one before), or pick one in the dashboard
 *   (Workers & Pages → the Worker → Deployments), or run this script from an older commit.
 */
import { spawnSync } from 'node:child_process'
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
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  ''
].join('\n')
writeFileSync(join(tmp, 'site', '_headers'), headers)
// Any address opens the app (it has its own screens).
const config = {
  name: worker,
  compatibility_date: '2026-09-25',
  workers_dev: true,
  preview_urls: false,
  assets: { directory: './site', not_found_handling: 'single-page-application' }
}
writeFileSync(join(tmp, 'wrangler.jsonc'), JSON.stringify(config, null, 2))
run('npx', ['-y', 'wrangler@4.161.0', 'deploy'], { ...process.env, CI: '1' }, tmp)
rmSync(tmp, { recursive: true, force: true })
console.log(`\nDone: https://${worker}.igreenrobotz.workers.dev  (${siteVersion})`)
