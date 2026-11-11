import type { CapacitorConfig } from '@capacitor/cli'

// The Android app: the same screens as the desktop app (src/renderer), with
// src/mobile standing in for the desktop's main process.
const config: CapacitorConfig = {
  appId: 'app.veyra.study',
  appName: 'Veyra Study',
  webDir: 'mobile/www',
  android: { allowMixedContent: false },
  plugins: {
    // Network requests go through Android, not the web view: Veyra's server
    // refuses browser-origin requests, and the relay and phone server send no CORS headers.
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true }
  }
}

export default config
