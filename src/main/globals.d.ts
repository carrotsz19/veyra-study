/** The built-in Google OAuth client, injected at build time (electron.vite.config.ts). */
/** The built-in Google client, from google-client.json at build time. apiKey is for the Drive file picker. */
declare const __GOOGLE_CLIENT__: { id: string; secret: string; apiKey: string }

/** electron-vite: a file next to the build, as a path. */
declare module '*?asset' {
  const path: string
  export default path
}
