import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// The app's own Google OAuth client (Desktop app), from google-client.json
// (downloaded from Google Cloud, never committed) or from the environment.
function googleClient(): { id: string; secret: string } {
  if (process.env['VEYRA_GOOGLE_CLIENT_ID']) {
    return { id: process.env['VEYRA_GOOGLE_CLIENT_ID'], secret: process.env['VEYRA_GOOGLE_CLIENT_SECRET'] ?? '' }
  }
  if (existsSync('google-client.json')) {
    const j = JSON.parse(readFileSync('google-client.json', 'utf8'))
    const c = j.installed ?? j.web ?? {}
    return { id: c.client_id ?? '', secret: c.client_secret ?? '' }
  }
  return { id: '', secret: '' }
}

export default defineConfig({
  main: {
    define: { __GOOGLE_CLIENT__: JSON.stringify(googleClient()) },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react()]
  }
})
