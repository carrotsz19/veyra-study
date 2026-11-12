import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown } from 'lucide-react'
import { usePhone } from '../lib/phone'

/**
 * Veyra's own drop-down, in place of the system one (which ignores the app's
 * theme: a white list in dark mode). On a computer it opens a small menu that
 * springs out of the button; on a phone, a sheet that slides up from the
 * bottom and can be swiped away. Keyboard: arrows, Home/End, typing a letter,
 * Enter to pick, Esc to close.
 */

export type SelectOption = {
  value: string
  label: string
  /** Smaller text under or beside the label. */
  hint?: string
  /** A colour dot (subjects). */
  dot?: string
  icon?: ReactNode
  /** How the label looks in the list (e.g. heading sizes). */
  style?: CSSProperties
  disabled?: boolean
}

type Props = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Read out by screen readers; also the phone sheet's title. */
  label: string
  id?: string
  className?: string
  /** Shown when the value isn't one of the options. */
  placeholder?: string
  /** Don't take focus from a text editor (toolbars). */
  keepFocus?: boolean
  /** Hide the up/down chevrons (tight toolbars use their own). */
  bare?: boolean
  disabled?: boolean
}

type Place = { top: number; left: number; minWidth: number; maxHeight: number; up: boolean }

export function Select({ value, options, onChange, label, id, className = '', placeholder = 'Choose…', keepFocus, bare, disabled }: Props) {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<Place | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)

  const show = () => {
    if (disabled) return
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setClosing(false)
    setOpen(true)
  }
  // Closing plays a short fade before the menu goes.
  const hide = useCallback((refocus = true) => {
    setClosing(true)
    setTimeout(() => {
      setOpen(false)
      setClosing(false)
      setPlace(null)
    }, 150)
    if (refocus && !keepFocus) btn.current?.focus({ preventScroll: true })
  }, [keepFocus])
  const pick = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    if (o.value !== value) onChange(o.value)
    hide()
  }

  // Where the menu goes: under the button, or above it when there's no room below.
  useLayoutEffect(() => {
    if (!open || phone || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const want = Math.min(menu.current?.scrollHeight ?? 320, 340)
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < want && above > below
    const maxHeight = Math.max(120, Math.min(340, up ? above : below))
    const minWidth = Math.max(r.width, 160)
    const left = Math.min(Math.max(8, r.left - 4), window.innerWidth - minWidth - 8)
    setPlace({ top: up ? r.top - 6 : r.bottom + 6, left, minWidth, maxHeight, up })
  }, [open, phone])

  // Click away, scroll the page, or resize: close.
  useEffect(() => {
    if (!open || closing) return
    const away = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) hide(false)
    }
    const scroll = (e: Event) => !menu.current?.contains(e.target as Node) && !phone && hide(false)
    // Phones resize when the keyboard comes and goes: only a computer window resizing closes the menu.
    const resize = () => !phone && hide(false)
    document.addEventListener('mousedown', away, true)
    document.addEventListener('touchstart', away, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('touchstart', away, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [open, closing, hide, phone])

  // Focus the list when it opens (unless a text editor must keep focus), and keep the chosen row in view.
  useEffect(() => {
    if (open && !closing && !keepFocus) menu.current?.focus({ preventScroll: true })
  }, [open, closing, keepFocus, place])
  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, place])

  // Typing letters jumps to the first option that starts with them.
  const typed = useRef({ text: '', at: 0 })
  const typeAhead = (key: string) => {
    const now = Date.now()
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + key.toLowerCase(), at: now }
    const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text))
    if (i >= 0) setActive(i)
  }
  const step = (from: number, by: number) => {
    for (let n = 1; n <= options.length; n++) {
      const i = (from + by * n + options.length * n) % options.length
      if (!options[i].disabled) return i
    }
    return from
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        show()
      }
      return
    }
    if (e.key === 'ArrowDown') setActive((i) => step(i, 1))
    else if (e.key === 'ArrowUp') setActive((i) => step(i, -1))
    else if (e.key === 'Home') setActive(step(-1, 1))
    else if (e.key === 'End') setActive(step(options.length, -1))
    else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else if (e.key === 'Escape') hide()
    else if (e.key === 'Tab') return hide(false)
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) typeAhead(e.key)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  // A text editor keeps its selection: don't let clicks here take focus from it.
  const hold = keepFocus ? (e: React.MouseEvent) => e.preventDefault() : undefined

  const rows = options.map((o, i) => (
    <div
      key={o.value}
      id={`${listId}-${i}`}
      data-i={i}
      role="option"
      aria-selected={o.value === value}
      aria-disabled={o.disabled || undefined}
      className={`sel-opt ${i === active ? 'active' : ''}`}
      onMouseMove={() => i !== active && !o.disabled && setActive(i)}
      onMouseDown={hold}
      onClick={() => pick(i)}
    >
      <span className="sel-check">{o.value === value && <Check size={14} strokeWidth={2.6} />}</span>
      {o.dot && <i className="sel-dot" style={{ background: o.dot }} />}
      {o.icon}
      <span className="sel-text">
        <span className="sel-label" style={o.style}>
          {o.label}
        </span>
        {o.hint && <span className="sel-hint">{o.hint}</span>}
      </span>
    </div>
  ))

  const list = open
    ? phone
      ? createPortal(<SelectSheet label={label} closing={closing} onClose={() => hide()} menuRef={menu} listId={listId} activeId={`${listId}-${active}`} onKey={onKey}>{rows}</SelectSheet>, document.body)
      : createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={`${listId}-${active}`}
            className={`sel-menu ${place?.up ? 'up' : ''} ${closing ? 'closing' : ''}`}
            style={place ? { left: place.left, minWidth: place.minWidth, maxHeight: place.maxHeight, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) } : { visibility: 'hidden', left: 0, top: 0 }}
            onKeyDown={onKey}
            onMouseDown={hold}
          >
            {rows}
          </div>,
          document.body
        )
    : null

  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`sel ${bare ? 'bare' : ''} ${open && !closing ? 'open' : ''} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? placeholder}`}
        disabled={disabled}
        onMouseDown={hold}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKey}
      >
        {current?.dot && <i className="sel-dot" style={{ background: current.dot }} />}
        <span className={`sel-value ${current ? '' : 'placeholder'}`}>{current?.label ?? placeholder}</span>
        {!bare && <ChevronsUpDown size={14} className="sel-chev" aria-hidden />}
      </button>
      {list}
    </>
  )
}

/** The phone's version: a sheet from the bottom that follows your finger and can be flicked away. */
function SelectSheet({
  label,
  closing,
  onClose,
  menuRef,
  listId,
  activeId,
  onKey,
  children
}: {
  label: string
  closing: boolean
  onClose: () => void
  menuRef: React.RefObject<HTMLDivElement | null>
  listId: string
  activeId: string
  onKey: (e: React.KeyboardEvent) => void
  children: ReactNode
}) {
  const sheet = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; t: number; dy: number; v: number } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    // Only from the grip or the title, so the list itself still scrolls.
    if (!(e.target as HTMLElement).closest('.sel-sheet-head')) return
    drag.current = { y: e.clientY, t: e.timeStamp, dy: 0, v: 0 }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* the pointer is already gone */
    }
    sheet.current?.classList.add('dragging')
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || !sheet.current) return
    const raw = e.clientY - d.y
    // Down moves 1:1; up meets resistance (rubber band).
    const dy = raw > 0 ? raw : (raw * 0.55) / (1 + (-raw * 0.55) / 120)
    const dt = Math.max(8, e.timeStamp - d.t)
    d.v = d.v * 0.5 + ((dy - d.dy) / dt) * 0.5
    d.dy = dy
    d.t = e.timeStamp
    sheet.current.style.transform = `translateY(${dy}px)`
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    const el = sheet.current
    if (!d || !el) return
    el.classList.remove('dragging')
    // Far enough, or flicked down: away it goes, carrying on at the speed it was thrown.
    if (d.dy > 110 || (d.v > 0.6 && d.dy > 40)) {
      el.style.setProperty('--from', `${d.dy}px`)
      el.style.transform = ''
      onClose()
    } else el.style.transform = ''
  }
  return (
    <div className={`sel-scrim ${closing ? 'closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheet} className={`sel-sheet ${closing ? 'closing' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="sel-sheet-head">
          <div className="sel-grip" />
          <b>{label}</b>
        </div>
        <div ref={menuRef} id={listId} role="listbox" aria-label={label} tabIndex={-1} aria-activedescendant={activeId} className="sel-sheet-list" onKeyDown={onKey}>
          {children}
        </div>
      </div>
    </div>
  )
}
