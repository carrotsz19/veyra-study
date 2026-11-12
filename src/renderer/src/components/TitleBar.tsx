import { useEffect, useRef, useState } from 'react'
import { Check, GraduationCap } from 'lucide-react'
import type { NavId, ThemeMode } from '@shared/settings'
import { useSettings } from '../data/settings'
import { useNav, type Route } from '../nav'
import { newNote } from '../views/Notes'
import { TaskDialog } from './editors'
import { useToast } from './ui'
import { IS_DEV } from '@shared/channel'

/**
 * Veyra's own title bar on Windows: the app's mark and name, then File, Edit,
 * View and Help menus, on the same surface as the app (glass or solid).
 * Windows still draws minimise / maximise / close at the right. The bar can
 * be dragged to move the window, and double-clicked to maximise.
 */

type Item = { label: string; keys?: string; run: () => void; checked?: boolean; danger?: boolean } | 'sep'
const SCREENS: [NavId, string][] = [
  ['today', 'Today'],
  ['tasks', 'Tasks'],
  ['notes', 'Notes'],
  ['calendar', 'Calendar'],
  ['groups', 'Group work'],
  ['timer', 'Focus timer'],
  ['stats', 'Stats']
]
const REPO = 'https://github.com/carrotsz19/veyra-study'
// Windows 11: menus open in an acrylic window of their own, so what's behind them is truly blurred.
const NATIVE = !!window.veyra.menu?.supported()
const win = (cmd: Parameters<NonNullable<typeof window.veyra.app.win>>[0]) => void window.veyra.app.win?.(cmd)

export function TitleBar() {
  const { go } = useNav()
  const { s, set } = useSettings()
  const toast = useToast()
  const [open, setOpen] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const [newTask, setNewTask] = useState(false)
  const bar = useRef<HTMLDivElement>(null)

  const settings = (section?: string) => {
    if (section) sessionStorage.setItem('veyra.settingsSection', section)
    go({ name: 'settings' })
    if (section) window.dispatchEvent(new CustomEvent('veyra:settings-section', { detail: section }))
  }
  const zoom = (by: number | null) => set({ zoom: by === null ? 1 : Math.round(Math.min(1.4, Math.max(0.8, s.zoom + by)) * 10) / 10 })
  const theme = (t: ThemeMode) => set({ theme: t })

  const menus: [string, Item[]][] = [
    [
      'File',
      [
        { label: 'New task', run: () => setNewTask(true) },
        { label: 'New note', run: () => void newNote(null, s).then((id) => go({ name: 'notes', noteId: id })) },
        'sep',
        { label: 'Import data…', run: () => void window.veyra.app.importData().then((r) => r.imported && toast(`Brought in ${r.imported} items`)) },
        { label: 'Export data…', run: () => void window.veyra.app.exportData().then((r) => r.saved && toast('Exported')) },
        'sep',
        { label: 'Settings', keys: 'Ctrl+,', run: () => settings() },
        'sep',
        { label: 'Close window', run: () => win('close') },
        { label: 'Quit Veyra Study', keys: 'Ctrl+Q', run: () => win('quit') }
      ]
    ],
    [
      'Edit',
      [
        { label: 'Undo', keys: 'Ctrl+Z', run: () => win('undo') },
        { label: 'Redo', keys: 'Ctrl+Y', run: () => win('redo') },
        'sep',
        { label: 'Cut', keys: 'Ctrl+X', run: () => win('cut') },
        { label: 'Copy', keys: 'Ctrl+C', run: () => win('copy') },
        { label: 'Paste', keys: 'Ctrl+V', run: () => win('paste') },
        { label: 'Select all', keys: 'Ctrl+A', run: () => win('selectAll') },
        'sep',
        { label: 'Search everything', keys: 'Ctrl+K', run: () => window.dispatchEvent(new Event('veyra:palette')) }
      ]
    ],
    [
      'View',
      [
        ...SCREENS.map(([id, label], i): Item => ({ label, keys: `Ctrl+${i + 1}`, run: () => go({ name: id } as Route) })),
        'sep',
        { label: 'Light', checked: s.theme === 'light', run: () => theme('light') },
        { label: 'Dark', checked: s.theme === 'dark', run: () => theme('dark') },
        { label: 'Match Windows', checked: s.theme === 'system', run: () => theme('system') },
        'sep',
        { label: 'Bigger', keys: 'Ctrl+=', run: () => zoom(0.1) },
        { label: 'Smaller', keys: 'Ctrl+−', run: () => zoom(-0.1) },
        { label: 'Actual size', keys: 'Ctrl+0', run: () => zoom(null) },
        'sep',
        { label: 'Full screen', keys: 'F11', run: () => win('fullscreen') }
      ]
    ],
    [
      'Help',
      [
        { label: 'What’s new', run: () => settings('updates') },
        { label: 'Check for updates', run: () => (settings('updates'), void window.veyra.update.check()) },
        'sep',
        { label: 'Report a problem', run: () => void window.veyra.open(`${REPO}/issues/new`) },
        { label: 'All versions on GitHub', run: () => void window.veyra.open(`${REPO}/releases`) },
        'sep',
        { label: `About Veyra Study ${__APP_VERSION__}`, run: () => settings('updates') }
      ]
    ]
  ]

  // Keyboard shortcuts the menus show.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (e.key === 'F11') {
        e.preventDefault()
        win('fullscreen')
      } else if (ctrl && !e.shiftKey && !e.altKey && /^[1-7]$/.test(e.key)) {
        e.preventDefault()
        go({ name: SCREENS[Number(e.key) - 1][0] } as Route)
      } else if (ctrl && e.key === ',') {
        e.preventDefault()
        settings()
      } else if (ctrl && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoom(0.1)
      } else if (ctrl && e.key === '-') {
        e.preventDefault()
        zoom(-0.1)
      } else if (ctrl && e.key === '0') {
        e.preventDefault()
        zoom(null)
      } else if (ctrl && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        win('quit')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Clicking elsewhere, Esc, or the window losing focus closes a menu drawn in the page.
  // (The acrylic menu window takes focus when it opens, and closes itself when it loses it.)
  useEffect(() => {
    if (!open || NATIVE) return
    const away = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setOpen(null)
    const blur = () => setOpen(null)
    document.addEventListener('mousedown', away, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('mousedown', away, true)
      window.removeEventListener('blur', blur)
    }
  }, [open])

  // The acrylic menu window: show the open menu there, and hear back what happened.
  const btns = useRef(new Map<string, HTMLButtonElement | null>())
  const lastClosed = useRef({ name: '', at: 0 })
  const now = useRef({ menus, open })
  now.current = { menus, open }
  useEffect(() => {
    if (!NATIVE) return
    const m = window.veyra.menu!
    if (!open) return m.close()
    const list = menus.find(([n]) => n === open)?.[1] ?? []
    const b = btns.current.get(open)?.getBoundingClientRect()
    if (!b) return
    const css = getComputedStyle(document.documentElement)
    m.open({
      x: b.left,
      y: b.bottom + 4,
      dark: document.documentElement.classList.contains('dark'),
      accent: css.getPropertyValue('--accent').trim(),
      zoom: 1,
      items: list.map((it, i) => (it === 'sep' ? { sep: true as const } : { id: `${open}:${i}`, label: it.label, keys: it.keys, checked: it.checked }))
    })
  }, [open, s.theme, s.zoom]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!NATIVE) return
    const m = window.veyra.menu!
    const offs = [
      m.onPicked((id) => {
        const [name, i] = id.split(':')
        const it = now.current.menus.find(([n]) => n === name)?.[1][Number(i)]
        setOpen(null)
        if (it && it !== 'sep') it.run()
      }),
      m.onClosed(() => {
        lastClosed.current = { name: now.current.open ?? '', at: Date.now() }
        setOpen(null)
      }),
      m.onStep((by) => {
        const names = now.current.menus.map(([n]) => n)
        const at = names.indexOf(now.current.open ?? '')
        if (at >= 0) setOpen(names[(at + by + names.length) % names.length])
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const items = menus.find(([n]) => n === open)?.[1] ?? []
  const pick = (it: Item) => {
    if (it === 'sep') return
    setOpen(null)
    it.run()
  }
  const step = (by: 1 | -1) => {
    let i = active
    for (let n = 0; n < items.length; n++) {
      i = (i + by + items.length) % items.length
      if (items[i] !== 'sep') return setActive(i)
    }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return
    const names = menus.map(([n]) => n)
    const at = names.indexOf(open)
    if (e.key === 'Escape') setOpen(null)
    else if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      setOpen(names[(at + (e.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length])
      setActive(-1)
    } else if (e.key === 'Enter' && items[active]) pick(items[active])
    else return
    e.preventDefault()
  }

  return (
    <div ref={bar} className="titlebar" onKeyDown={onKey}>
      <div className="wb-brand">
        <span className="wb-mark">
          <GraduationCap size={13} strokeWidth={2.2} />
        </span>
        <b>Veyra Study</b>
        {IS_DEV && <span className="dev-pill" title="A test build: its own app and data, separate from the real Veyra Study.">DEV</span>}
      </div>
      <nav className="wb-menus" aria-label="Menu">
        {menus.map(([name, list]) => (
          <div key={name} className="wb-menu-wrap">
            <button
              ref={(el) => void btns.current.set(name, el)}
              className={`wb-menu-btn ${open === name ? 'open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={open === name}
              onMouseDown={(e) => {
                e.preventDefault()
                // Clicking the open menu's own button closes it (the menu window already closed as focus left it).
                if (NATIVE && lastClosed.current.name === name && Date.now() - lastClosed.current.at < 300) return
                setOpen(open === name ? null : name)
                setActive(-1)
              }}
              onMouseEnter={() => open && open !== name && (setOpen(name), setActive(-1))}
              onKeyDown={(e) => {
                if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
                  e.preventDefault()
                  setOpen(name)
                  setActive(0)
                }
              }}
            >
              {name}
            </button>
            {open === name && !NATIVE && (
              <div className="wb-menu" role="menu" aria-label={name}>
                {list.map((it, i) =>
                  it === 'sep' ? (
                    <div key={`s${i}`} className="wb-menu-sep" role="separator" />
                  ) : (
                    <button
                      key={it.label}
                      role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                      aria-checked={it.checked}
                      className={`wb-menu-item ${i === active ? 'active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(it)}
                    >
                      <span className="wb-check">{it.checked && <Check size={13} strokeWidth={2.6} />}</span>
                      <span className="grow">{it.label}</span>
                      {it.keys && <span className="wb-keys">{it.keys}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="wb-drag" />
      {newTask && <TaskDialog onClose={() => setNewTask(false)} />}
    </div>
  )
}
