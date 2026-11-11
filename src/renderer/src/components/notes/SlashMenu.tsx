import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { onSlash, type SlashState } from './extensions'

/** The "/" command list, positioned under the caret. */
export function SlashMenu() {
  const [s, setS] = useState<SlashState | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })

  useEffect(() => onSlash(setS), [])

  useLayoutEffect(() => {
    if (!s?.rect || !ref.current) return
    const h = ref.current.offsetHeight
    const w = ref.current.offsetWidth
    const below = s.rect.bottom + 6
    const top = below + h > window.innerHeight - 8 ? Math.max(8, s.rect.top - h - 6) : below
    setPos({ left: Math.min(s.rect.left, window.innerWidth - w - 8), top })
  }, [s])

  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [s?.index])

  if (!s) return null
  return createPortal(
    <div ref={ref} className="slash-menu" role="listbox" aria-label="Insert block" style={{ left: pos.left, top: pos.top }}>
      <div className="slash-head">Insert</div>
      {s.items.map((item, i) => (
        <button
          key={item.title}
          role="option"
          aria-selected={i === s.index}
          className="slash-item"
          onMouseDown={(e) => {
            e.preventDefault()
            s.pick(item)
          }}
        >
          <span className="slash-icon">{item.icon}</span>
          <span className="grow">
            <span className="slash-title">{item.title}</span>
            <span className="slash-hint">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body
  )
}
