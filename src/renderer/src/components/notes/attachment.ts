import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Attachment as FileInfo } from '@shared/types'
import { cancelTranscription, transcribeInto, watchTranscription } from '../../data/voice'

const files = window.veyra.files

export const fileUrl = (id: string) => `veyra-file://f/${encodeURIComponent(id)}`
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
      if (/^audio\//.test(mime)) {
        // A voice recording: a player, and Transcribe (offline, on this computer).
        dom.classList.add('att-audio')
        dom.innerHTML = `<div class="att-audio-head"><span class="att-icon">🎙️</span><span class="att-text"><b></b><small></small></span><button type="button" class="att-open att-transcribe">Transcribe</button><button type="button" class="att-open att-cancel" hidden>Cancel</button></div><audio controls preload="metadata"></audio>`
        dom.querySelector('b')!.textContent = name
        const small = dom.querySelector('small')!
        small.textContent = fileSize(size)
        const audio = dom.querySelector('audio')!
        audio.src = fileUrl(id)
        audio.addEventListener('error', missing)
        const showLength = () => {
          if (Number.isFinite(audio.duration)) small.textContent = `${Math.floor(audio.duration / 60)}:${String(Math.floor(audio.duration % 60)).padStart(2, '0')} · ${fileSize(size)}`
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
        btn.hidden = !canAttach(editor)
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
        img.src = fileUrl(id)
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
        stopEvent: (e) => e.type === 'dblclick' || !!(e.target as HTMLElement)?.closest?.('.att-open, audio'),
        destroy: () => unwatch?.()
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
