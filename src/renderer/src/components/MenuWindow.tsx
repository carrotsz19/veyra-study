import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

/**
 * The page inside the acrylic menu window (see main/popup.ts). It draws the
 * menu the app asked for, reports its size so the window fits it exactly, and
 * sends back what was picked. Windows paints the blurred backdrop behind it.
 */
export function MenuWindow() {
  const [spec, setSpec] = useState<MenuSpec | null>(null)
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const menu = window.veyra.menu!

  useEffect(() => {
    document.documentElement.classList.add('menu-window')
    return menu.onRender((s) => {
      setSpec(s)
      setActive(-1)
    })
  }, [menu])

  // Match the app's look, then tell the window how big the menu came out.
  useLayoutEffect(() => {
    if (!spec || !box.current) return
    const root = document.documentElement
    root.classList.toggle('dark', spec.dark)
    root.style.setProperty('--accent', spec.accent)
    const r = box.current.getBoundingClientRect()
    menu.size(Math.ceil(r.width), Math.ceil(r.height))
  }, [spec, menu])

  const items = spec?.items ?? []
  const step = (by: 1 | -1) => {
    let i = active
    for (let n = 0; n < items.length; n++) {
      i = (i + by + items.length) % items.length
      if (!('sep' in items[i])) return setActive(i)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') step(1)
      else if (e.key === 'ArrowUp') step(-1)
      else if (e.key === 'ArrowRight') menu.step(1)
      else if (e.key === 'ArrowLeft') menu.step(-1)
      else if (e.key === 'Escape') menu.dismiss()
      else if (e.key === 'Enter') {
        const it = items[active]
        if (it && !('sep' in it)) menu.pick(it.id)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!spec) return null
  return (
    <div ref={box} className="menu-win" role="menu" onMouseLeave={() => setActive(-1)}>
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={`s${i}`} className="wb-menu-sep" role="separator" />
        ) : (
          <button
            key={it.id}
            role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={it.checked}
            className={`wb-menu-item ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => menu.pick(it.id)}
          >
            <span className="wb-check">{it.checked && <Check size={13} strokeWidth={2.6} />}</span>
            <span className="grow">{it.label}</span>
            {it.keys && <span className="wb-keys">{it.keys}</span>}
          </button>
        )
      )}
    </div>
  )
}
