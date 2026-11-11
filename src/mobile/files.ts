/**
 * Files attached to notes on Android: kept in the app's private storage
 * (attachments/<id>), shown through Capacitor's local file URLs, and opened
 * in whatever app on the phone handles that kind of file. Like the desktop,
 * files stay on the device they were added on; notes only point at them.
 */
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { FileOpener } from '@capacitor-community/file-opener'
import type { Attachment } from '@shared/types'

const DIR = 'attachments'
const MAX = 150 * 1024 * 1024
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'video/mp4'
}
const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/

let base = ''
/** Finds the app's storage folder (once, at start-up), so file URLs can be made without waiting. */
export async function startFiles(): Promise<void> {
  try {
    base = (await Filesystem.getUri({ path: DIR, directory: Directory.Data })).uri
  } catch {
    base = ''
  }
}
export const url = (id: string) => (ID.test(id) && base ? Capacitor.convertFileSrc(`${base}/${id}`) : '')

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function save(name: string, mime: string, bytes: Uint8Array): Promise<Attachment> {
  if (bytes.byteLength > MAX) throw new Error(`“${name}” is over 150 MB, which is too big to attach on the phone.`)
  const clean = (String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'File').slice(0, 160)
  const id = `${crypto.randomUUID()}.${extOf(clean)}`
  await Filesystem.writeFile({ path: `${DIR}/${id}`, data: toB64(bytes), directory: Directory.Data, recursive: true })
  return { id, name: clean, mime: MIME[extOf(clean)] ?? mime ?? 'application/octet-stream', size: bytes.byteLength }
}

/** The phone's file picker (photos, documents, downloads…). */
export function pick(): Promise<Attachment[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      try {
        const out: Attachment[] = []
        for (const f of Array.from(input.files ?? [])) out.push(await save(f.name, f.type, new Uint8Array(await f.arrayBuffer())))
        resolve(out)
      } catch (e) {
        reject(e)
      }
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

export async function read(id: string): Promise<Uint8Array> {
  if (!ID.test(id)) throw new Error('That file isn’t on this phone.')
  const r = await Filesystem.readFile({ path: `${DIR}/${id}`, directory: Directory.Data }).catch(() => {
    throw new Error('That file isn’t on this phone.')
  })
  return Uint8Array.from(atob(typeof r.data === 'string' ? r.data : ''), (c) => c.charCodeAt(0))
}

export async function open(id: string): Promise<void> {
  if (!ID.test(id)) throw new Error('That file isn’t on this phone.')
  const { uri } = await Filesystem.getUri({ path: `${DIR}/${id}`, directory: Directory.Data })
  await FileOpener.open({ filePath: uri, contentType: MIME[extOf(id)], openWithDefault: true }).catch(() => {
    throw new Error('No app on this phone opens that kind of file.')
  })
}
