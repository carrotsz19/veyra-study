import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Android app's web part: src/renderer's screens with src/mobile's bridge.
export default defineConfig({
  root: resolve(__dirname),
  base: './',
  resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VEYRA_VERSION || JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version),
    // Which Veyra this build is (src/shared/channel.ts).
    __CHANNEL__: JSON.stringify(process.env.VEYRA_CHANNEL === 'dev' ? 'dev' : 'prod')
  },
  build: { outDir: resolve(__dirname, 'www'), emptyOutDir: true, target: 'es2022' }
})
