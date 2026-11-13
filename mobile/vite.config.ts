import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Android app's web part: src/renderer's screens with src/mobile's bridge.
// VEYRA_WEB=1 builds the same thing as a website instead (web/dist), without the phone-only parts.
const web = process.env.VEYRA_WEB === '1'
export default defineConfig({
  root: resolve(__dirname),
  base: './',
  resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
  plugins: [react()],
  define: {
    __WEB__: JSON.stringify(web),
    __APP_VERSION__: JSON.stringify(process.env.VEYRA_VERSION || JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version),
    // Which Veyra this build is (src/shared/channel.ts).
    __CHANNEL__: JSON.stringify(process.env.VEYRA_CHANNEL === 'dev' ? 'dev' : 'prod'),
    // Dev builds only: the read-only token for the private repo test builds live in (never in Prod).
    __DEV_FEED_TOKEN__: JSON.stringify(
      // never on the website: its code is public
      process.env.VEYRA_CHANNEL !== 'dev' || web
        ? ''
        : (process.env.VEYRA_DEV_FEED_TOKEN || (existsSync('C:/dev/tools/veyra-dev-feed.token') ? readFileSync('C:/dev/tools/veyra-dev-feed.token', 'utf8') : '')).trim()
    )
  },
  build: { outDir: resolve(__dirname, web ? '../web/dist' : 'www'), emptyOutDir: true, target: 'es2022' }
})
