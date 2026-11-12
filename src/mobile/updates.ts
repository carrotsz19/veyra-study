/**
 * Updates for the Android app. New versions are published on GitHub as
 * pre-releases tagged android-v<version>, with the APK attached. The app
 * reads GitHub's releases feed (not its rate-limited API), downloads the APK
 * into its cache and hands it to Android's installer, which asks you to
 * confirm (Android never lets a sideloaded app update silently).
 */
import { CapacitorHttp } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileOpener } from '@capacitor-community/file-opener'
import type { UpdateState } from '@shared/types'
import { registerPlugin } from '@capacitor/core'

/** The app's own bit of Android code (android/.../UpdateInstallerPlugin.java). */
const Installer = registerPlugin<{
  canInstall(): Promise<{ allowed: boolean }>
  openPermission(): Promise<void>
  install(o: { path: string }): Promise<void>
}>('UpdateInstaller')

const REPO = 'https://github.com/carrotsz19/veyra-study'
const current = __APP_VERSION__

let state: UpdateState = { supported: true, current, status: 'idle' }
let apk = '' // download address of the newer APK
let file = '' // where it was downloaded
const subs = new Set<(s: UpdateState) => void>()
function publish(s: Partial<UpdateState>) {
  state = { ...state, ...s }
  subs.forEach((f) => f(state))
}
export const getState = async () => state
export function onState(cb: (s: UpdateState) => void): () => void {
  subs.add(cb)
  return () => void subs.delete(cb)
}

const parts = (v: string) => v.split('.').map((x) => parseInt(x, 10) || 0)
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const toText = (html: string) =>
  unescape(html)
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** Looks for a newer Android version on GitHub. */
export async function check(): Promise<UpdateState> {
  if (state.status === 'downloading' || state.status === 'ready') return state
  publish({ status: 'checking', error: undefined })
  try {
    const r = await CapacitorHttp.request({ method: 'GET', url: `${REPO}/releases.atom`, headers: { Accept: 'application/atom+xml' }, connectTimeout: 15000, readTimeout: 15000 })
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`)
    const xml = String(r.data)
    let best: { version: string; notes: string; date: string } | null = null
    for (const entry of xml.split('<entry>').slice(1)) {
      const tag = /releases\/tag\/android-v(\d+\.\d+\.\d+)/.exec(entry)?.[1]
      if (!tag || (best && !newer(tag, best.version))) continue
      best = { version: tag, notes: toText(/<content[^>]*>([\s\S]*?)<\/content>/.exec(entry)?.[1] ?? ''), date: /<updated>([^<]+)</.exec(entry)?.[1] ?? '' }
    }
    if (best && newer(best.version, current)) {
      apk = `${REPO}/releases/download/android-v${best.version}/Veyra-Study-${best.version}.apk`
      publish({ status: 'available', latest: best.version, notes: best.notes.replace(/^Install:[^\n]*\n*/, ''), releaseDate: best.date, checkedAt: Date.now() })
    } else publish({ status: 'up-to-date', latest: current, notes: undefined, checkedAt: Date.now() })
  } catch (e) {
    publish({ status: 'error', error: /timeout|host|network|connect/i.test(String(e)) ? 'Can’t reach GitHub. Check your connection.' : 'Couldn’t check for updates. Try again later.' })
  }
  return state
}

/** Downloads the newer APK, with progress. */
export async function download(): Promise<UpdateState> {
  if (state.status !== 'available' || !apk) return state
  publish({ status: 'downloading', progress: 0, transferred: 0, total: 0, error: undefined })
  const started = Date.now()
  const listener = await Filesystem.addListener('progress', (p) => {
    const secs = (Date.now() - started) / 1000
    publish({ progress: p.contentLength ? p.bytes / p.contentLength : 0, transferred: p.bytes, total: p.contentLength, speed: secs > 0 ? p.bytes / secs : 0 })
  })
  try {
    // (straight into the cache folder: downloadFile doesn't create folders)
    const path = `Veyra-Study-${state.latest}.apk`
    const r = await Filesystem.downloadFile({ url: apk, path, directory: Directory.Cache, progress: true, connectTimeout: 20000, readTimeout: 60000 })
    file = r.path ?? (await Filesystem.getUri({ path, directory: Directory.Cache })).uri
    publish({ status: 'ready', progress: 1 })
  } catch {
    publish({ status: 'available', error: 'The download didn’t finish. Try again.' })
  } finally {
    void listener.remove()
  }
  return state
}

/** Opens Android's installer for the downloaded version. */
export async function install(): Promise<void> {
  if (state.status !== 'ready' || !file) return
  publish({ error: undefined })
  try {
    // The first time, Android needs you to let Veyra Study install apps: open that switch.
    if (!(await Installer.canInstall()).allowed) {
      publish({ error: 'Turn on “Allow from this source” for Veyra Study, come back, then tap Install update again.' })
      await Installer.openPermission()
      return
    }
    await Installer.install({ path: file })
  } catch {
    // Older builds without the installer bridge: let Android pick the app.
    try {
      await FileOpener.open({ filePath: file, contentType: 'application/vnd.android.package-archive' })
    } catch {
      publish({ error: 'Android didn’t open the installer. Allow Veyra Study to install apps (Settings → Apps → Special access → Install unknown apps), then try again.' })
    }
  }
}

/** A quiet check when the app starts (at most every 6 hours); Settings shows the result. */
export function checkAtStart(onFound: (version: string) => void): void {
  try {
    const last = Number(localStorage.getItem('veyra.updateCheck') ?? 0)
    if (Date.now() - last < 6 * 3600_000) return
    localStorage.setItem('veyra.updateCheck', String(Date.now()))
  } catch {
    /* storage unavailable: check anyway */
  }
  setTimeout(() => void check().then((s) => s.status === 'available' && s.latest && onFound(s.latest)), 4000)
}
