import { Node, mergeAttributes } from '@tiptap/core'

/**
 * Handwriting and sketches: a drawing block in a note. Strokes are kept in
 * the note itself (so they sync and work in shared notes) in a 1000-wide
 * space, scaled to the page. Pen pressure sets the width; while a pen is in
 * use, touches (a resting palm) are ignored.
 */
export interface Stroke {
  /** Colour. */
  c: string
  /** Base width, in drawing units. */
  w: number
  /** Highlighter: wide and see-through. */
  h?: 1
  /** Points: x, y (0–1000 wide space), pressure (0–1). Flat list. */
  p: number[]
}

const W = 1000
const COLORS = ['ink', '#d9633e', '#2f6fd6', '#2f9a5b']
const SIZES = [2, 4, 8]
const ink = () => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1b1a18'
const colorOf = (c: string) => (c === 'ink' ? ink() : c)

function draw(ctx: CanvasRenderingContext2D, s: Stroke, scale: number) {
  const p = s.p
  ctx.strokeStyle = colorOf(s.c)
  ctx.globalAlpha = s.h ? 0.35 : 1
  ctx.lineCap = s.h ? 'butt' : 'round'
  ctx.lineJoin = 'round'
  if (p.length === 3) {
    ctx.beginPath()
    ctx.fillStyle = colorOf(s.c)
    ctx.arc(p[0] * scale, p[1] * scale, (s.w * (0.5 + p[2]) * scale) / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  for (let i = 3; i < p.length; i += 3) {
    ctx.beginPath()
    ctx.lineWidth = Math.max(0.6, s.h ? s.w * 4 * scale : s.w * (0.4 + p[i + 2]) * scale)
    // A curve through the midpoints keeps fast strokes smooth.
    const x0 = p[i - 3], y0 = p[i - 2], x1 = p[i], y1 = p[i + 1]
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
    if (i === 3) ctx.moveTo(x0 * scale, y0 * scale)
    else ctx.moveTo(((p[i - 6] + x0) / 2) * scale, ((p[i - 5] + y0) / 2) * scale)
    ctx.quadraticCurveTo(x0 * scale, y0 * scale, mx * scale, my * scale)
    if (i === p.length - 3) ctx.lineTo(x1 * scale, y1 * scale)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Distance from a point to a stroke, for the eraser. */
function near(s: Stroke, x: number, y: number, r: number): boolean {
  const reach = r + (s.h ? s.w * 2 : s.w)
  const p = s.p
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) < reach
  // Distance to each segment, so long straight strokes erase anywhere along them.
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], dx = p[i] - ax, dy = p[i + 1] - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < reach) return true
  }
  return false
}

/** The drawing as an SVG (for exports). */
export function drawingSvg(strokes: Stroke[], height: number): string {
  const paths = strokes
    .map((s) => {
      const pts = []
      for (let i = 0; i < s.p.length; i += 3) pts.push(`${s.p[i]},${s.p[i + 1]}`)
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.c === 'ink' ? '#1b1a18' : s.c}" stroke-width="${s.h ? s.w * 4 : s.w}" stroke-linecap="round" stroke-linejoin="round"${s.h ? ' opacity="0.35"' : ''}/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">${paths}</svg>`
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    drawing: {
      insertDrawing: () => ReturnType
    }
  }
}

export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      strokes: { default: [], rendered: false },
      height: { default: 600, rendered: false }
    }
  },
  parseHTML: () => [{ tag: 'div[data-drawing]', getAttrs: (el) => ({ strokes: safeParse(el.getAttribute('data-strokes')), height: Number(el.getAttribute('data-height')) || 600 }) }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-drawing': '', 'data-height': node.attrs.height, 'data-strokes': JSON.stringify(node.attrs.strokes) }),
    '✏️ Drawing'
  ],
  addCommands() {
    return {
      insertDrawing:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs: { strokes: [], height: 600 } }).run()
    }
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let strokes: Stroke[] = (node.attrs.strokes as Stroke[]) ?? []
      let height: number = node.attrs.height ?? 600
      let tool: 'pen' | 'hl' | 'erase' = 'pen'
      let color = 'ink'
      let size = 4
      let current: Stroke | null = null
      let penSeen = false
      const undo: Stroke[][] = []

      const dom = document.createElement('div')
      dom.className = 'drw'
      dom.contentEditable = 'false'
      dom.innerHTML = `<div class="drw-bar"></div><div class="drw-wrap"><canvas></canvas></div><div class="drw-grip" title="Drag to make the drawing taller or shorter"></div>`
      const bar = dom.querySelector('.drw-bar') as HTMLDivElement
      const wrap = dom.querySelector('.drw-wrap') as HTMLDivElement
      const canvas = dom.querySelector('canvas') as HTMLCanvasElement
      const grip = dom.querySelector('.drw-grip') as HTMLDivElement
      const ctx = canvas.getContext('2d')!
      const editable = () => editor.isEditable

      const save = () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (pos === undefined) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, strokes, height }))
      }
      const scale = () => wrap.clientWidth / W
      const render = () => {
        const s = scale()
        const dpr = window.devicePixelRatio || 1
        const w = wrap.clientWidth
        const h = Math.round(height * s)
        wrap.style.height = `${h}px`
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr)
          canvas.height = Math.round(h * dpr)
          canvas.style.width = `${w}px`
          canvas.style.height = `${h}px`
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        for (const st of strokes) draw(ctx, st, s)
        if (current) draw(ctx, current, s)
      }

      // ----- toolbar -----
      const btn = (label: string, html: string, on: () => void, cls = '') => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `drw-btn ${cls}`
        b.title = label
        b.setAttribute('aria-label', label)
        b.innerHTML = html
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          on()
          paintBar()
        })
        bar.append(b)
        return b
      }
      const toolBtns = {
        pen: btn('Pen', '✒️', () => (tool = 'pen')),
        hl: btn('Highlighter', '🖍️', () => (tool = 'hl')),
        erase: btn('Eraser (removes whole strokes)', '🧽', () => (tool = 'erase'))
      }
      bar.append(Object.assign(document.createElement('span'), { className: 'drw-sep' }))
      const colorBtns = COLORS.map((c) => btn(c === 'ink' ? 'Black' : 'Colour', `<i style="background:${c === 'ink' ? 'var(--ink)' : c}"></i>`, () => ((color = c), tool === 'erase' && (tool = 'pen')), 'drw-color'))
      bar.append(Object.assign(document.createElement('span'), { className: 'drw-sep' }))
      const sizeBtns = SIZES.map((z) => btn(`Size ${z}`, `<b style="width:${z + 3}px;height:${z + 3}px"></b>`, () => (size = z), 'drw-size'))
      bar.append(Object.assign(document.createElement('span'), { className: 'drw-grow' }))
      btn('Undo', '↶', () => {
        const prev = undo.pop()
        if (prev) {
          strokes = prev
          render()
          save()
        }
      })
      btn('Clear drawing', '🗑️', () => {
        if (!strokes.length) return
        undo.push(strokes)
        strokes = []
        render()
        save()
      })
      const paintBar = () => {
        for (const [k, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(tool === k))
        colorBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(color === COLORS[i] && tool !== 'erase')))
        sizeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(size === SIZES[i])))
        bar.hidden = !editable()
        grip.hidden = !editable()
        canvas.style.cursor = !editable() ? 'default' : tool === 'erase' ? 'cell' : 'crosshair'
      }

      // ----- drawing -----
      const point = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect()
        const s = scale()
        return [Math.round(((e.clientX - r.left) / s) * 10) / 10, Math.round(((e.clientY - r.top) / s) * 10) / 10, e.pointerType === 'pen' ? Math.round(e.pressure * 100) / 100 : 0.5]
      }
      const eraseAt = (e: PointerEvent) => {
        const [x, y] = point(e)
        const left = strokes.filter((st) => !near(st, x, y, 8))
        if (left.length !== strokes.length) {
          strokes = left
          render()
        }
      }
      canvas.addEventListener('pointerdown', (e) => {
        if (!editable() || e.button > 0) return
        if (e.pointerType === 'pen') penSeen = true
        else if (e.pointerType === 'touch' && penSeen) return // palm
        e.preventDefault()
        canvas.setPointerCapture(e.pointerId)
        undo.push(strokes)
        if (undo.length > 50) undo.shift()
        const eraser = tool === 'erase' || (e.pointerType === 'pen' && (e.buttons & 32) !== 0) // the pen's eraser end
        if (eraser) {
          current = null
          canvas.dataset.erasing = '1'
          eraseAt(e)
          return
        }
        current = { c: color, w: tool === 'hl' ? size * 2 : size, ...(tool === 'hl' ? { h: 1 as const } : {}), p: point(e) }
        render()
      })
      canvas.addEventListener('pointermove', (e) => {
        if (canvas.dataset.erasing) return eraseAt(e)
        if (!current) return
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
        for (const ev of events.length ? events : [e]) {
          const [x, y, pr] = point(ev)
          const n = current.p.length
          if (Math.hypot(x - current.p[n - 3], y - current.p[n - 2]) < 1.2) continue
          current.p.push(x, y, pr)
        }
        render()
      })
      const end = () => {
        if (canvas.dataset.erasing) {
          delete canvas.dataset.erasing
          save()
          return
        }
        if (!current) return
        strokes = [...strokes, current]
        current = null
        render()
        save()
      }
      canvas.addEventListener('pointerup', end)
      canvas.addEventListener('pointercancel', end)

      // ----- taller / shorter -----
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        grip.setPointerCapture(e.pointerId)
        const startY = e.clientY
        const startH = height
        const move = (ev: PointerEvent) => {
          height = Math.max(120, Math.min(4000, Math.round(startH + (ev.clientY - startY) / scale())))
          render()
        }
        const up = () => {
          grip.removeEventListener('pointermove', move)
          grip.removeEventListener('pointerup', up)
          save()
        }
        grip.addEventListener('pointermove', move)
        grip.addEventListener('pointerup', up)
      })

      const ro = new ResizeObserver(() => render())
      ro.observe(wrap)
      const themeWatch = new MutationObserver(() => render())
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      paintBar()
      requestAnimationFrame(render)

      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'drawing') return false
          node = n
          // Someone else (or undo in the editor) changed it.
          if (!current) {
            strokes = (n.attrs.strokes as Stroke[]) ?? []
            height = n.attrs.height ?? 600
            render()
          }
          paintBar()
          return true
        },
        stopEvent: (e) => !!(e.target as HTMLElement)?.closest?.('.drw-bar, canvas, .drw-grip'),
        ignoreMutation: () => true,
        destroy: () => {
          ro.disconnect()
          themeWatch.disconnect()
        }
      }
    }
  }
})

function safeParse(v: string | null): Stroke[] {
  try {
    const j = JSON.parse(v ?? '[]')
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}
