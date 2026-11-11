#!/usr/bin/env node
/**
 * One-time setup for group work, run on your PC from the repo folder:
 *
 *   npx wrangler login        (once; opens the browser)
 *   npm run relay:setup
 *
 * It makes the two secrets on this computer (they never go through a chat or
 * a website), saves them in server/.env for the phone, creates the relay's
 * storage, deploys the relay Worker and gives it the secrets. Safe to run
 * again: it keeps the secrets and storage it already made.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELAY = dirname(fileURLToPath(import.meta.url))
const ENV = join(RELAY, '..', 'server', '.env')
const TOML = join(RELAY, 'wrangler.toml')

const wrangler = (args, input) => {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: RELAY, input, encoding: 'utf8', shell: process.platform === 'win32', stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr)
    throw new Error(`wrangler ${args.join(' ')} failed`)
  }
  return r.stdout + r.stderr
}

// 1. Secrets, kept in server/.env (git ignores it).
const env = {}
if (existsSync(ENV)) for (const l of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}
env.SIGNING_KEY ||= randomBytes(32).toString('base64url')
env.RELAY_SECRET ||= randomBytes(32).toString('base64url')

// 2. Storage for the phone's address.
let toml = readFileSync(TOML, 'utf8')
if (toml.includes('PASTE_THE_KV_NAMESPACE_ID_HERE')) {
  console.log('Creating the relay’s storage…')
  const out = wrangler(['kv', 'namespace', 'create', 'RELAY'])
  const id = (out.match(/[0-9a-f]{32}/) || [])[0]
  if (!id) throw new Error('Couldn’t read the storage id from wrangler:\n' + out)
  toml = toml.replace('PASTE_THE_KV_NAMESPACE_ID_HERE', id)
  writeFileSync(TOML, toml)
}

// 3. Deploy, then the secrets.
console.log('Deploying the relay…')
const deployed = wrangler(['deploy'])
const url = (deployed.match(/https:\/\/veyra-study-relay\.[a-z0-9-]+\.workers\.dev/) || [])[0]
console.log('Giving the relay its secrets…')
wrangler(['secret', 'put', 'SIGNING_KEY'], env.SIGNING_KEY)
wrangler(['secret', 'put', 'RELAY_SECRET'], env.RELAY_SECRET)

if (url) env.RELAY_URL = url
else if (!env.RELAY_URL) {
  writeFileSync(ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  console.error('\nThe relay deployed, but its address wasn’t in wrangler’s output. Add it to server/.env as\nRELAY_URL=https://veyra-study-relay.<your-subdomain>.workers.dev  (shown above), or the phone can’t publish its address.')
  process.exit(1)
}
writeFileSync(ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')

console.log(`
Done.
  Relay:        ${url || '(see the wrangler output above)'}
  Phone config: ${ENV}

Next: copy server/group-server.mjs and server/.env to the phone (see README, "Group work").`)
if (url && url !== 'https://veyra-study-relay.igreenrobotz.workers.dev')
  console.log(`\nNote: the app expects the relay at https://veyra-study-relay.igreenrobotz.workers.dev.\nSet VEYRA_RELAY=${url} or change RELAY_URL in src/main/group.ts.`)
