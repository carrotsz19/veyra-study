/**
 * Export and import on Android. There's no save dialog on a phone, so files
 * are written to the app's cache and handed to the share sheet, where they
 * can go to Files, Google Drive, email or another app. Import uses the
 * phone's file picker.
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import * as idb from './idb'
import { ON_WEB } from '@shared/channel'

/** The website: an ordinary browser download. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const safe = (n: string) => (n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'Untitled').slice(0, 120)
const cancelled = (e: unknown) => /cancel/i.test(String((e as Error)?.message ?? e))

async function write(name: string, text: string): Promise<string> {
  const r = await Filesystem.writeFile({ path: `exports/${name}`, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
  return r.uri
}

/** Shares the files; false when the person backed out of the share sheet. */
async function share(title: string, files: string[]): Promise<boolean> {
  try {
    await Share.share({ title, files, dialogTitle: title })
    return true
  } catch (e) {
    if (cancelled(e)) return false
    throw e
  }
}

export async function exportData(version: string): Promise<{ saved: boolean; path?: string; count?: number }> {
  const records = (await idb.changesSince(0)).filter((r) => !r.deletedAt)
  const name = `veyra-study-${new Date().toISOString().slice(0, 10)}.json`
  if (ON_WEB) {
    download(name, JSON.stringify({ app: 'veyra-study', version, exportedAt: new Date().toISOString(), records }, null, 2), 'application/json')
    return { saved: true, path: name, count: records.length }
  }
  const uri = await write(name, JSON.stringify({ app: 'veyra-study', version, exportedAt: new Date().toISOString(), records }, null, 2))
  const saved = await share('Save your Veyra Study data', [uri])
  return saved ? { saved: true, path: name, count: records.length } : { saved: false }
}

export async function exportNotes(files: { name: string; text: string }[]): Promise<{ saved: number }> {
  if (!files.length) return { saved: 0 }
  const used = new Set<string>()
  const uris: string[] = []
  for (const f of files) {
    let base = safe(f.name)
    for (let i = 2; used.has(base.toLowerCase()); i++) base = `${safe(f.name)} (${i})`
    used.add(base.toLowerCase())
    if (ON_WEB) download(`${base}.md`, f.text, 'text/markdown')
    else uris.push(await write(`${base}.md`, f.text))
  }
  if (ON_WEB) return { saved: files.length }
  return { saved: (await share(files.length === 1 ? 'Export note' : `Export ${files.length} notes`, uris)) ? files.length : 0 }
}

/** Opens the phone's file picker for a .json file and returns its text (null if nothing was picked). */
function pickText(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    let settled = false
    const finish = (v: string | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      resolve(v)
    }
    // No 'cancel' event on older web views: treat coming back with no file as cancelled.
    const onFocus = () => setTimeout(() => !input.files?.length && finish(null), 1500)
    input.addEventListener('cancel', () => finish(null))
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) return finish(null)
      f.text().then(finish, () => finish(null))
    })
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

const KINDS = new Set(['subject', 'task', 'note', 'session', 'settings', 'folder', 'noteVersion'])
export async function importData(): Promise<{ imported: number }> {
  const text = await pickText()
  if (text == null) return { imported: 0 }
  let file: { app?: string; records?: unknown }
  try {
    file = JSON.parse(text)
  } catch {
    throw new Error('That file isn’t a Veyra Study backup.')
  }
  if (file?.app !== 'veyra-study' || !Array.isArray(file.records)) throw new Error('That file isn’t a Veyra Study backup.')
  let n = 0
  for (const r of file.records as { id?: unknown; kind?: unknown; data?: unknown }[]) {
    if (!r || typeof r.id !== 'string' || typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.data !== 'object' || !r.data) continue
    await idb.put(r.kind as never, r.data as never, r.id)
    n++
  }
  return { imported: n }
}
