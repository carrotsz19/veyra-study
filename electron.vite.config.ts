import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Which Veyra this build is (src/shared/channel.ts): "dev" for Veyra Study Dev test builds and npm run dev.
const channel = { __CHANNEL__: JSON.stringify(process.env.VEYRA_CHANNEL === 'dev' || process.env.npm_lifecycle_event === 'dev' ? 'dev' : 'prod') }

// The app's own Google OAuth client (Desktop app), from google-client.json
// (downloaded from Google Cloud, never committed) or from the environment.
function googleClient(): { id: string; secret: string; apiKey: string } {
  if (process.env['VEYRA_GOOGLE_CLIENT_ID']) {
    return { id: process.env['VEYRA_GOOGLE_CLIENT_ID'], secret: process.env['VEYRA_GOOGLE_CLIENT_SECRET'] ?? '', apiKey: process.env['VEYRA_GOOGLE_API_KEY'] ?? '' }
  }
  if (existsSync('google-client.json')) {
    const j = JSON.parse(readFileSync('google-client.json', 'utf8'))
    const c = j.installed ?? j.web ?? {}
    return { id: c.client_id ?? '', secret: c.client_secret ?? '', apiKey: j.api_key ?? process.env['VEYRA_GOOGLE_API_KEY'] ?? '' }
  }
  return { id: '', secret: '', apiKey: process.env['VEYRA_GOOGLE_API_KEY'] ?? '' }
}

export default defineConfig({
  main: {
    define: { __GOOGLE_CLIENT__: JSON.stringify(googleClient()), ...channel },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: { define: channel },
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(process.env.VEYRA_VERSION || JSON.parse(readFileSync('package.json', 'utf8')).version), ...channel }
  }
})
