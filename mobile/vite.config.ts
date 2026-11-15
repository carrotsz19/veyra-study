import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The Android app's web part: src/renderer's screens with src/mobile's bridge.
// VEYRA_WEB=1 builds the same thing as a website instead (web/dist), without the phone-only parts.
const web = process.env.VEYRA_WEB === '1'
const dev = process.env.VEYRA_CHANNEL === 'dev'
const version = process.env.VEYRA_VERSION || JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version

/**
 * The website as an installable app ("Install Veyra Study" in the browser, or Add to Home Screen):
 * its manifest, and a service worker that opens the app without a connection. The service
 * worker never touches /api (sign-in, sync and groups always go to the network); pages load
 * from the network when they can, and the hashed script and style files, which never change,
 * from the browser's copy.
 */
function webApp(): Plugin {
  return {
    name: 'veyra-web-app',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' }],
    generateBundle(_, bundle) {
      const manifest = {
        id: '/',
        name: dev ? 'Veyra Study Dev' : 'Veyra Study',
        short_name: dev ? 'Veyra Dev' : 'Veyra Study',
        description: 'Your tasks, notes, calendar and focus timer in one place.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f3f1ec',
        theme_color: '#f3f1ec',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) })
      // Every script, style and font (about 4 MB), kept when the site is first opened, so the app opens offline.
      const all = Object.values(bundle).map((f) => f.fileName).filter((n) => n.startsWith('assets/'))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker(version, all) })
    }
  }
}

const serviceWorker = (version: string, all: string[]) => `// Veyra Study website ${version}: made by mobile/vite.config.ts.
const PAGES = 'veyra-pages-${version}'
const ASSETS = 'veyra-assets'
const ALL = ${JSON.stringify(all.map((n) => '/' + n))}
const STATIC = ['/', '/icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(Promise.all([caches.open(PAGES).then((c) => c.addAll(STATIC)), caches.open(ASSETS).then((c) => c.addAll(ALL))]).then(() => self.skipWaiting()))
})

// A new version: drop the old page copies, and script files no version uses any more.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== PAGES && k !== ASSETS) await caches.delete(k)
      const assets = await caches.open(ASSETS)
      for (const req of await assets.keys()) if (!ALL.includes(new URL(req.url).pathname)) await assets.delete(req)
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') {
    // Every page is the app (share links too): the newest from the network, else the kept copy.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === '/') {
            const copy = res.clone()
            caches.open(PAGES).then((c) => c.put('/', copy))
          }
          return res
        })
        .catch(() => caches.match('/', { cacheName: PAGES }).then((r) => r || Response.error()))
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req, { cacheName: ASSETS }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(ASSETS).then((c) => c.put(req, copy))
            }
            return res
          })
      )
    )
    return
  }
  if (STATIC.includes(url.pathname)) e.respondWith(fetch(req).catch(() => caches.match(url.pathname, { cacheName: PAGES }).then((r) => r || Response.error())))
})
`
export default defineConfig({
  root: resolve(__dirname),
  // The website has pages under /s/ (share links), so its files load from the root; the phone app's from its folder.
  base: web ? '/' : './',
  resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
  plugins: [react(), ...(web ? [webApp()] : [])],
  define: {
    __WEB__: JSON.stringify(web),
    __APP_VERSION__: JSON.stringify(version),
    // Which Veyra this build is (src/shared/channel.ts).
    __CHANNEL__: JSON.stringify(dev ? 'dev' : 'prod'),
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
