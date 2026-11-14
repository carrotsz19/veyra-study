import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Attachment as FileInfo } from '@shared/types'
import { cancelTranscription, transcribeInto, watchTranscription } from '../../data/voice'
import { onAndroid } from '../../lib/phone'

const files = window.veyra.files

/** Small icons for the recording player (Lucide's shapes). */
const icon16 = (body: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const SVG = {
  play: icon16('<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>'),
  pause: icon16('<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>'),
  more: icon16('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  download: icon16('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'),
  trash: icon16('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>')
}

/**
 * The website keeps attachments in the browser's own storage, which has no file address:
 * each is shown from a temporary blob address, made when it's first needed.
 */
const onWebsite = () => document.documentElement.classList.contains('web')
const blobs = new Map<string, Promise<string>>()
function blobUrl(id: string, mime: string): Promise<string> {
  let p = blobs.get(id)
  if (!p) {
    p = files.read(id).then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type: mime || 'application/octet-stream' })))
    p.catch(() => blobs.delete(id))
    blobs.set(id, p)
  }
  return p
}
/** An address that shows a file (on the website, once it has been read). */
export const fileSrc = (id: string, mime: string): Promise<string> => (onWebsite() ? blobUrl(id, mime) : Promise.resolve(fileUrl(id)))

/** Points an image or player at a file (on the website, once it has been read). */
function showFile(el: HTMLImageElement | HTMLAudioElement, id: string, mime: string, onFail: () => void) {
  if (!onWebsite()) return void (el.src = fileUrl(id))
  blobUrl(id, mime).then((u) => (el.src = u), onFail)
}

/** Saves a copy of an attached file where you choose (the phone hands it to the share sheet instead). */
async function download(id: string, name: string, mime = ''): Promise<void> {
  if (onAndroid() && !onWebsite()) return files.open(id)
  const url = onWebsite() ? await blobUrl(id, mime) : URL.createObjectURL(await (await fetch(fileUrl(id))).blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (!onWebsite()) setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const fileUrl = (id: string) => files.url?.(id) || `veyra-file://f/${encodeURIComponent(id)}`
export const isImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp|avif)$/.test(mime)
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
const icon = (mime: string, name: string) =>
  mime === 'application/pdf' ? '📕' : /presentation|powerpoint/.test(mime) ? '📊' : /sheet|excel|csv/.test(mime) ? '📈' : /word|text\//.test(mime) ? '📝' : /^audio/.test(mime) ? '🎧' : /^video/.test(mime) ? '🎬' : /zip/.test(mime) || /\.zip$/i.test(name) ? '🗜️' : '📎'

const clean = (e: unknown, fallback: string) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback)

/** Errors from attaching go here (the note page shows them as a toast). */
type Report = (message: string) => void
let report: Report = () => {}
export const onAttachError = (r: Report) => {
  report = r
  return () => {
    if (report === r) report = () => {}
  }
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    attachment: {
      insertAttachments: (list: FileInfo[], pos?: number) => ReturnType
    }
  }
}

/** Is attaching allowed in this editor? (Not in shared group notes: the files would only be on your computer.) */
export const canAttach = (editor: Editor | null) => !!editor && !!editor.extensionManager.extensions.find((e) => e.name === 'attachment')?.options.enabled

/** Opens the file dialog and puts the chosen files in at the cursor. */
export async function attachFiles(editor: Editor): Promise<void> {
  try {
    const list = await files.pick()
    if (list.length) editor.chain().focus().insertAttachments(list).run()
  } catch (e) {
    report(clean(e, 'Couldn’t attach that.'))
  }
}

async function fromTransfer(dt: DataTransfer): Promise<FileInfo[]> {
  const out: FileInfo[] = []
  const paths: string[] = []
  for (const f of Array.from(dt.files)) {
    const p = files.pathFor(f)
    if (p) paths.push(p)
    else out.push(await files.fromBytes(f.name, f.type, new Uint8Array(await f.arrayBuffer())))
  }
  if (paths.length) out.unshift(...(await files.fromPaths(paths)))
  return out
}

function take(view: EditorView, editor: Editor, dt: DataTransfer | null, pos?: number): boolean {
  if (!dt || !dt.files.length || !canAttach(editor)) return false
  fromTransfer(dt)
    .then((list) => list.length && editor.chain().focus().insertAttachments(list, pos).run())
    .catch((e) => report(clean(e, 'Couldn’t attach that.')))
  void view
  return true
}

/**
 * A file in a note: images show inline, anything else is a card you click to
 * open in its usual app. The file itself lives in this account's
 * attachments folder; the note keeps its id, name, type and size.
 */
export const AttachmentNode = Node.create<{ enabled: boolean }>({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions: () => ({ enabled: true }),
  addAttributes() {
    return {
      // Written out as data-* in renderHTML only, so exported HTML stays clean.
      id: { default: '', rendered: false },
      name: { default: 'File', rendered: false },
      mime: { default: 'application/octet-stream', rendered: false },
      size: { default: 0, rendered: false }
    }
  },
  parseHTML: () => [
    {
      tag: 'div[data-attachment]',
      getAttrs: (el) => ({ id: el.getAttribute('data-id') ?? '', name: el.getAttribute('data-name') ?? 'File', mime: el.getAttribute('data-mime') ?? '', size: Number(el.getAttribute('data-size') ?? 0) })
    }
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-attachment': '', 'data-id': node.attrs.id, 'data-name': node.attrs.name, 'data-mime': node.attrs.mime, 'data-size': node.attrs.size }),
    `📎 ${node.attrs.name}`
  ],
  addCommands() {
    return {
      insertAttachments:
        (list, pos) =>
        ({ chain }) => {
          const nodes = list.map((a) => ({ type: this.name, attrs: { id: a.id, name: a.name, mime: a.mime, size: a.size } }))
          return pos === undefined ? chain().insertContent(nodes).run() : chain().insertContentAt(pos, nodes).run()
        }
    }
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const { id, name, mime, size } = node.attrs as FileInfo
      const dom = document.createElement('div')
      dom.className = 'att'
      dom.contentEditable = 'false'
      const open = () => files.open(id).catch((e: unknown) => report(clean(e, 'Couldn’t open it.')))
      const missing = () => {
        dom.className = 'att att-missing'
        dom.textContent = ''
        const t = document.createElement('span')
        t.textContent = `📎 ${name} isn’t on this computer`
        dom.append(t)
      }
      let unwatch: (() => void) | null = null
      let menuCleanup: (() => void) | null = null
      if (/^audio\//.test(mime)) {
        // A voice recording: a player, and Transcribe (offline, on this computer).
        dom.classList.add('att-audio')
        // Veyra's own player (the browser's has an unstyled menu): play, time bar, speed, and ••• with Download and Delete.
        dom.innerHTML = `<div class="att-audio-head"><span class="att-icon">🎙️</span><span class="att-text"><b></b><small></small></span><button type="button" class="att-open att-transcribe">Transcribe</button><button type="button" class="att-open att-cancel" hidden>Cancel</button><span class="att-more-wrap"><button type="button" class="att-more" aria-label="More for this recording" aria-haspopup="menu" aria-expanded="false">${SVG.more}</button><div class="att-menu" role="menu" hidden><button type="button" role="menuitem" class="att-menu-row att-dl">${SVG.download}<span>Download</span></button><button type="button" role="menuitem" class="att-menu-row danger att-del">${SVG.trash}<span>Delete recording</span></button></div></span></div><div class="att-player"><button type="button" class="att-play" aria-label="Play">${SVG.play}</button><span class="att-time num">0:00</span><input type="range" class="att-seek" min="0" max="1000" value="0" step="1" aria-label="Position in the recording" /><span class="att-dur num">0:00</span><button type="button" class="att-speed" aria-label="Playback speed" title="Playback speed">1×</button></div><audio preload="metadata"></audio>`
        dom.querySelector('b')!.textContent = name
        const small = dom.querySelector('small')!
        small.textContent = fileSize(size)
        const audio = dom.querySelector('audio')!
        showFile(audio, id, mime, missing)
        audio.addEventListener('error', missing)
        const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
        const playBtn = dom.querySelector('.att-play') as HTMLButtonElement
        const seek = dom.querySelector('.att-seek') as HTMLInputElement
        const timeEl = dom.querySelector('.att-time')!
        const durEl = dom.querySelector('.att-dur')!
        const speedBtn = dom.querySelector('.att-speed') as HTMLButtonElement
        let seeking = false
        const paint = () => {
          const d = Number.isFinite(audio.duration) ? audio.duration : 0
          timeEl.textContent = mmss(audio.currentTime)
          if (!seeking) seek.value = String(d ? Math.round((audio.currentTime / d) * 1000) : 0)
          seek.style.setProperty('--fill', `${Number(seek.value) / 10}%`)
        }
        const paintPlay = () => {
          playBtn.innerHTML = audio.paused ? SVG.play : SVG.pause
          playBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause')
          dom.classList.toggle('playing', !audio.paused)
        }
        playBtn.addEventListener('click', () => void (audio.paused ? audio.play().catch(() => {}) : audio.pause()))
        audio.addEventListener('play', paintPlay)
        audio.addEventListener('pause', paintPlay)
        audio.addEventListener('ended', paintPlay)
        audio.addEventListener('timeupdate', paint)
        seek.addEventListener('input', () => {
          seeking = true
          const d = Number.isFinite(audio.duration) ? audio.duration : 0
          timeEl.textContent = mmss((Number(seek.value) / 1000) * d)
          seek.style.setProperty('--fill', `${Number(seek.value) / 10}%`)
        })
        seek.addEventListener('change', () => {
          const d = Number.isFinite(audio.duration) ? audio.duration : 0
          if (d) audio.currentTime = (Number(seek.value) / 1000) * d
          seeking = false
        })
        const SPEEDS = [1, 1.25, 1.5, 2, 0.75]
        speedBtn.addEventListener('click', () => {
          const next = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length]
          audio.playbackRate = next
          speedBtn.textContent = `${next}×`
        })
        // ••• menu
        const moreBtn = dom.querySelector('.att-more') as HTMLButtonElement
        const menu = dom.querySelector('.att-menu') as HTMLDivElement
        const away = (e: MouseEvent) => !(e.target as HTMLElement).closest?.('.att-more-wrap') && setMenu(false)
        const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
        const setMenu = (on: boolean) => {
          menu.hidden = !on
          moreBtn.setAttribute('aria-expanded', String(on))
          if (on) {
            document.addEventListener('mousedown', away)
            document.addEventListener('keydown', esc)
          } else {
            document.removeEventListener('mousedown', away)
            document.removeEventListener('keydown', esc)
          }
        }
        menuCleanup = () => setMenu(false)
        moreBtn.addEventListener('click', () => setMenu(menu.hidden))
        dom.querySelector('.att-dl')!.addEventListener('click', () => {
          setMenu(false)
          void download(id, name, mime).catch((e: unknown) => report(clean(e, 'Couldn’t download it.')))
        })
        dom.querySelector('.att-del')!.addEventListener('click', () => {
          setMenu(false)
          audio.pause()
          const pos = typeof getPos === 'function' ? getPos() : undefined
          if (typeof pos !== 'number') return
          editor.chain().focus().command(({ tr }) => {
            tr.delete(pos, pos + node.nodeSize)
            return true
          }).run()
          report('Recording deleted from the note. Press Ctrl+Z to bring it back.')
        })
        // Read-only notes (or no files here) can't change: no Delete.
        ;(dom.querySelector('.att-del') as HTMLButtonElement).hidden = !editor.isEditable
        const showLength = () => {
          if (Number.isFinite(audio.duration)) {
            small.textContent = `${mmss(audio.duration)} · ${fileSize(size)}`
            durEl.textContent = mmss(audio.duration)
            paint()
          }
        }
        audio.addEventListener('loadedmetadata', () => {
          // In-app recordings (WebM) don't say how long they are; seeking to the end makes the player work it out.
          if (audio.duration === Infinity) {
            const fix = () => {
              audio.removeEventListener('timeupdate', fix)
              audio.currentTime = 0
              showLength()
            }
            audio.addEventListener('timeupdate', fix)
            audio.currentTime = 1e9
          } else showLength()
        })
        audio.addEventListener('durationchange', showLength)
        const btn = dom.querySelector('.att-transcribe') as HTMLButtonElement
        const cancel = dom.querySelector('.att-cancel') as HTMLButtonElement
        // Transcription runs on a computer (whisper.cpp); the phone records and plays.
        btn.hidden = !canAttach(editor) || onAndroid()
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          void transcribeInto(editor, () => (typeof getPos === 'function' ? getPos() : undefined), { id, name, mime, size })
        })
        cancel.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          void cancelTranscription(id)
        })
        unwatch = watchTranscription(id, (st) => {
          btn.disabled = !!st?.running
          btn.textContent = st?.running ? (st.progress == null ? 'Transcribing…' : `Transcribing ${Math.round(st.progress * 100)}%`) : st?.error ? 'Try again' : 'Transcribe'
          cancel.hidden = !st?.running
          btn.title = st?.error ?? ''
          if (st?.error) report(st.error)
        })
      } else if (isImage(mime)) {
        dom.classList.add('att-image')
        const img = document.createElement('img')
        showFile(img, id, mime, missing)
        img.alt = name
        img.draggable = false
        img.title = `${name}. Double-click to open.`
        img.addEventListener('dblclick', open)
        img.addEventListener('error', missing)
        dom.append(img)
      } else {
        dom.classList.add('att-file')
        dom.title = 'Double-click to open'
        dom.innerHTML = `<span class="att-icon"></span><span class="att-text"><b></b><small></small></span><button type="button" class="att-open">Open</button>`
        dom.querySelector('.att-icon')!.textContent = icon(mime, name)
        dom.querySelector('b')!.textContent = name
        dom.querySelector('small')!.textContent = `${fileSize(size)} · ${(name.split('.').pop() || '').toUpperCase()}`
        dom.querySelector('.att-open')!.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          void open()
        })
        dom.addEventListener('dblclick', open)
      }
      return {
        dom,
        ignoreMutation: () => true,
        // Clicks on the player and buttons are theirs, not the editor's.
        stopEvent: (e) => e.type === 'dblclick' || !!(e.target as HTMLElement)?.closest?.('.att-open, audio, .att-player, .att-more-wrap'),
        destroy: () => {
          unwatch?.()
          menuCleanup?.()
        }
      }
    }
  }
})

/** Drop or paste files into a note to attach them. */
export const AttachmentDrop = Extension.create({
  name: 'attachmentDrop',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('attachmentDrop'),
        props: {
          handleDrop: (view, event) => {
            const dt = (event as DragEvent).dataTransfer
            if (!dt?.files.length) return false
            const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })
            const ok = take(view, editor, dt, at?.pos)
            if (ok) event.preventDefault()
            return ok
          },
          // Text wins: Word and others also put a picture of what you copied on the clipboard.
          handlePaste: (view, event) => !event.clipboardData?.getData('text/plain') && take(view, editor, event.clipboardData)
        }
      })
    ]
  }
})
