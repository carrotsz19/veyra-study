import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { usePhone } from '../lib/phone'

/**
 * A panel that opens from a button: on a computer it springs out under (or
 * above) the button; on a phone it's a sheet from the bottom. It plays a short
 * exit when closed, closes on Esc or a click outside, and hands focus back.
 * Used by the date and time pickers.
 */
export function Popover({
  anchor,
  open,
  onClose,
  label,
  className = '',
  children
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  label: string
  className?: string
  children: ReactNode
}) {
  const phone = usePhone()
  const panel = useRef<HTMLDivElement>(null)
  // Stays on screen briefly after closing, for the exit.
  const [shown, setShown] = useState(open)
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; up: boolean } | null>(null)
  useEffect(() => {
    if (open) setShown(true)
    else if (shown) {
      const t = setTimeout(() => {
        setShown(false)
        setPlace(null)
      }, 170)
      return () => clearTimeout(t)
    }
    return undefined
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open || phone || !anchor.current || !panel.current) return
    const r = anchor.current.getBoundingClientRect()
    const h = panel.current.offsetHeight
    const w = panel.current.offsetWidth
    const below = window.innerHeight - r.bottom - 12
    const up = below < h && r.top - 12 > below
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
    setPlace(up ? { bottom: window.innerHeight - r.top + 6, left, up } : { top: r.bottom + 6, left, up })
  }, [open, shown, phone]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
      anchor.current?.focus({ preventScroll: true })
    }
    const resize = () => !phone && onClose()
    document.addEventListener('mousedown', away, true)
    document.addEventListener('touchstart', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('touchstart', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', resize)
    }
  }, [open, onClose, phone, anchor])

  if (!shown) return null
  const closing = !open
  if (phone)
    return createPortal(
      <div className={`sel-scrim ${closing ? 'closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={panel} className={`sel-sheet pop-sheet ${closing ? 'closing' : ''} ${className}`} role="dialog" aria-label={label}>
          <div className="sel-sheet-head">
            <div className="sel-grip" />
            <b>{label}</b>
          </div>
          <div className="pop-sheet-body">{children}</div>
        </div>
      </div>,
      document.body
    )
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={`pop-panel ${place?.up ? 'up' : ''} ${closing ? 'closing' : ''} ${className}`}
      style={place ? { left: place.left, top: place.top, bottom: place.bottom } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}
