import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useExit } from '../lib/motion'

export function Dialog({
  title,
  onClose,
  children,
  width
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // However it's closed, it sinks away instead of vanishing.
  const ref = useRef<HTMLDivElement>(null)
  useExit(ref)
  return (
    <div ref={ref} className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width ? { maxWidth: width } : undefined}>
        <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 14 }}>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={22} />
      </div>
      <b>{title}</b>
      <div className="sm">{text}</div>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%`, background: color ?? 'var(--accent)' }} />
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={v === value} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/* ---------- right-click menus ---------- */
/** A row is [label, icon, what it does, danger?]; 'sep' draws a line between groups. */
export type MenuItem = [string, ReactNode, () => void, boolean?] | 'sep'

/** A menu at the pointer (right-click on a note, a task, a subject). Clicking away or Esc closes it. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as globalThis.Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => document.addEventListener('mousedown', away))
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])
  // Kept inside the window: rows are about 36px tall, lines about 9px.
  const height = items.reduce((h, it) => h + (it === 'sep' ? 9 : 36), 16)
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 220)), top: Math.max(8, Math.min(y, window.innerHeight - height)) }}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep${i}`} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={it[0]}
            role="menuitem"
            className={`menu-row ${it[3] ? 'danger' : ''}`}
            onClick={() => {
              it[2]()
              onClose()
            }}
          >
            {it[1]} {it[0]}
          </button>
        )
      )}
    </div>
  )
}

/* ---------- toasts ---------- */
interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}
const ToastCtx = createContext<(text: string, action?: Toast['action']) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  // Each toast's countdown: it stops while you point at the toasts, so one can't vanish as you reach for it.
  const clocks = useRef(new Map<number, { timer: ReturnType<typeof setTimeout> | null; left: number; since: number }>())
  const dismiss = useCallback((id: number) => {
    const c = clocks.current.get(id)
    if (c?.timer) clearTimeout(c.timer)
    clocks.current.delete(id)
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])
  const run = (id: number) => {
    const c = clocks.current.get(id)
    if (!c || c.timer) return
    c.since = Date.now()
    c.timer = setTimeout(() => dismiss(id), c.left)
  }
  const hold = (id: number) => {
    const c = clocks.current.get(id)
    if (!c?.timer) return
    clearTimeout(c.timer)
    c.timer = null
    // Always a moment left once you move away again.
    c.left = Math.max(1500, c.left - (Date.now() - c.since))
  }
  const push = useCallback((text: string, action?: Toast['action']) => {
    const id = next.current++
    setToasts((t) => [...t, { id, text, action }])
    clocks.current.set(id, { timer: null, left: action ? 6000 : 3000, since: 0 })
    run(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+Z takes back the last thing a toast offers to undo (unless you're typing: then it's the text's own undo).
  const shown = useRef(toasts)
  shown.current = toasts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const t = [...shown.current].reverse().find((x) => x.action?.label === 'Undo')
      if (!t) return
      e.preventDefault()
      t.action!.run()
      dismiss(t.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  const all = (f: (id: number) => void) => () => clocks.current.forEach((_, id) => f(id))
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div id="toast-root" aria-live="polite" onMouseEnter={all(hold)} onMouseLeave={all(run)} onFocus={all(hold)} onBlur={all(run)}>
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
            {t.action && (
              <button
                title={t.action.label === 'Undo' ? 'Undo (Ctrl+Z)' : undefined}
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
