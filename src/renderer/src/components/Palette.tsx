import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, CalendarDays, CornerDownLeft, FileText, Home, ListTodo, Monitor, Moon, NotebookPen, Pause, Play, Plus, Search, Settings as SettingsIcon, Sun, Timer, Users,
  type LucideIcon
} from 'lucide-react'
import type { Rec } from '@shared/types'
import { db, useRecords } from '../data/store'
import { useSettings } from '../data/settings'
import { useNav, type Route } from '../nav'
import { useTimer } from './timer'
import { TaskDialog } from './editors'
import { newNote, Marked } from '../views/Notes'
import { SECTIONS, here } from '../views/Settings'
import { scoreNote, searchTerms, snippet } from '../lib/notes'
import { dueLabel, todayKey } from '../lib/dates'
import { blankTask, defaultDueDate, sortSubjects } from '../lib/subjects'
import { useToast } from './ui'

/**
 * Ctrl+K: one box to jump anywhere and do anything. Finds notes (every word
 * in them), tasks (and their steps), subjects, screens and settings, and runs
 * actions: new task or note, start the timer, change the theme. Typing
 * something that isn't there offers to make it a task or a note.
 */

type Item = {
  key: string
  group: string
  label: string
  sub?: string
  icon: LucideIcon
  color?: string
  hint?: string
  score: number
  run: () => void
}

const SCREENS: [Route['name'], string, LucideIcon, string][] = [
  ['today', 'Today', Home, 'home dashboard'],
  ['tasks', 'Tasks', ListTodo, 'todo list homework'],
  ['notes', 'Notes', NotebookPen, 'notebook'],
  ['calendar', 'Calendar', CalendarDays, 'schedule events'],
  ['groups', 'Group work', Users, 'group chat shared'],
  ['timer', 'Focus timer', Timer, 'pomodoro study'],
  ['stats', 'Stats', BarChart3, 'statistics progress'],
  ['settings', 'Settings', SettingsIcon, 'preferences options']
]

/** Every word typed appears somewhere in the text (0 if not); earlier and title hits score higher. */
function score(terms: string[], label: string, extra = ''): number {
  if (!terms.length) return 1
  const l = label.toLowerCase()
  const hay = `${l} ${extra.toLowerCase()}`
  let s = 0
  for (const t of terms) {
    const i = l.indexOf(t)
    if (i === 0) s += 6
    else if (i > 0) s += l[i - 1] === ' ' ? 4 : 2
    else if (hay.includes(t)) s += 1
    else return 0
  }
  return s
}

export function Palette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [editing, setEditing] = useState<Rec<'task'> | 'new' | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { go } = useNav()
  const { s, set } = useSettings()
  const timer = useTimer()
  const toast = useToast()
  const { items: notes } = useRecords('note')
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')

  // Ctrl+K (or Cmd+K) anywhere, even while typing in a note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setOpen((v) => !v)
      }
    }
    const onAsk = () => setOpen(true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('veyra:palette', onAsk)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('veyra:palette', onAsk)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    setQ('')
    setAt(0)
    setTimeout(() => inputRef.current?.focus())
  }, [open])

  const close = () => setOpen(false)
  const terms = useMemo(() => searchTerms(q.trim()), [q])
  const query = q.trim()

  const items = useMemo(() => {
    const out: Item[] = []
    const subjectOf = (id: string | null) => subjects.find((x) => x.id === id)
    const both = (run: () => void) => () => {
      close()
      run()
    }

    // Actions
    const actions: [string, string, LucideIcon, string, () => void][] = [
      ['new-task', 'New task', Plus, 'add create todo', () => setEditing('new')],
      ['new-note', 'New note', NotebookPen, 'add create page write', () => void newNote(null, s).then((id) => go({ name: 'notes', noteId: id }))],
      timer.running
        ? ['timer', 'Pause the focus timer', Pause, 'stop pomodoro', () => timer.pause()]
        : ['timer', timer.remaining < timer.total ? 'Resume the focus timer' : 'Start a focus block', Play, 'pomodoro study timer begin', () => timer.start()],
      ['theme-dark', 'Dark theme', Moon, 'appearance night mode', () => set({ theme: 'dark' })],
      ['theme-light', 'Light theme', Sun, 'appearance day mode', () => set({ theme: 'light' })],
      ['theme-system', 'Match the system theme', Monitor, 'appearance auto', () => set({ theme: 'system' })]
    ]
    for (const [key, label, icon, extra, run] of actions) {
      if (key.startsWith('theme') && !terms.length) continue
      if (key === `theme-${s.theme}`) continue
      const sc = score(terms, label, extra)
      if (sc) out.push({ key, group: 'Actions', label, icon, score: sc + 1, run: both(run) })
    }

    // Screens
    for (const [name, label, icon, extra] of SCREENS) {
      const sc = score(terms, label, `go to open ${extra}`)
      if (sc) out.push({ key: `go-${name}`, group: 'Go to', label, icon, score: sc + 2, run: both(() => go({ name } as Route)) })
    }

    // Settings sections (only when searching)
    if (terms.length)
      for (const sec of SECTIONS.filter((x) => here(x.id))) {
        const sc = score(terms, `${sec.label} settings`, sec.hint)
        if (sc)
          out.push({
            key: `set-${sec.id}`,
            group: 'Settings',
            label: `${sec.label}`,
            sub: sec.hint,
            icon: sec.icon,
            score: sc,
            run: both(() => {
              sessionStorage.setItem('veyra.settingsSection', sec.id)
              go({ name: 'settings' })
              window.dispatchEvent(new CustomEvent('veyra:settings-section', { detail: sec.id }))
            })
          })
      }

    // Subjects
    for (const sub of sortSubjects(subjects).filter((x) => !x.data.archived)) {
      const sc = score(terms, sub.data.name, 'subject course class')
      if (sc && terms.length) out.push({ key: `sub-${sub.id}`, group: 'Subjects', label: sub.data.name, icon: FileText, color: sub.data.color, score: sc + 1, run: both(() => go({ name: 'subject', id: sub.id })) })
    }

    // Tasks: open ones; with no search, what's due today or late.
    const today = todayKey()
    const taskHits = tasks
      .filter((t) => (terms.length ? true : !t.data.done && !!t.data.due && t.data.due <= today))
      .map((t) => {
        const sc = score(terms, t.data.title, [t.data.details, ...(t.data.steps ?? []).map((x) => x.text), subjectOf(t.data.subjectId)?.data.name].join(' '))
        return [t, sc - (t.data.done ? 3 : 0)] as const
      })
      .filter(([, sc]) => sc > 0 || (!terms.length && sc !== 0))
      .sort((a, b) => b[1] - a[1])
      .slice(0, terms.length ? 8 : 5)
    for (const [t, sc] of taskHits) {
      const sub = subjectOf(t.data.subjectId)
      const steps = t.data.steps ?? []
      out.push({
        key: `task-${t.id}`,
        group: terms.length ? 'Tasks' : 'Due today',
        label: t.data.title,
        sub: [t.data.done ? 'Done' : t.data.due ? dueLabel(t.data.due) : '', sub?.data.name, steps.length ? `${steps.filter((x) => x.done).length}/${steps.length} steps` : ''].filter(Boolean).join(' · '),
        icon: ListTodo,
        color: sub?.data.color,
        score: Math.max(1, sc),
        run: both(() => setEditing(t))
      })
    }

    // Notes: every word in them. With no search, the latest few.
    const live = notes.filter((n) => !n.data.trashedAt)
    const noteHits = (terms.length
      ? live.map((n) => [n, scoreNote(n, terms)] as const).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1] || b[0].updatedAt - a[0].updatedAt)
      : [...live].sort((a, b) => b.updatedAt - a.updatedAt).map((n) => [n, 1] as const)
    ).slice(0, terms.length ? 10 : 4)
    for (const [n, sc] of noteHits) {
      const sub = subjectOf(n.data.subjectId)
      out.push({
        key: `note-${n.id}`,
        group: terms.length ? 'Notes' : 'Recent notes',
        label: n.data.title || 'Untitled',
        sub: (terms.length ? snippet(n, terms, 90) : null) ?? [sub?.data.name, n.data.archived ? 'Archived' : ''].filter(Boolean).join(' · '),
        icon: NotebookPen,
        color: sub?.data.color,
        hint: n.data.icon,
        score: sc,
        run: both(() => go({ name: 'notes', noteId: n.id }))
      })
    }

    // Order: groups by their best match; the "make it" choices last.
    const order = ['Actions', 'Due today', 'Recent notes', 'Go to', 'Tasks', 'Notes', 'Subjects', 'Settings']
    const best = new Map<string, number>()
    for (const it of out) best.set(it.group, Math.max(best.get(it.group) ?? 0, it.score))
    const groups = [...best.keys()].sort((a, b) => (terms.length ? (best.get(b)! - best.get(a)!) || order.indexOf(a) - order.indexOf(b) : order.indexOf(a) - order.indexOf(b)))
    const sorted = groups.flatMap((g) => out.filter((x) => x.group === g).sort((a, b) => (terms.length ? b.score - a.score : 0)))
    if (query) {
      sorted.push({ key: 'make-task', group: 'Make it', label: `New task “${query}”`, icon: Plus, score: 0, run: both(() => void db.put('task', { ...blankTask(null, defaultDueDate(s.defaultDue), s.defaultPriority), title: query }).then(() => toast(`Added “${query}” to your tasks`))) })
      sorted.push({
        key: 'make-note',
        group: 'Make it',
        label: `New note “${query}”`,
        icon: NotebookPen,
        score: 0,
        run: both(() => void db.put('note', { title: query, subjectId: null, content: null, excerpt: '', template: s.noteTemplate, font: s.noteFont }).then((r) => go({ name: 'notes', noteId: r.id })))
      })
    }
    return sorted
  }, [terms, query, notes, tasks, subjects, s, timer.running, timer.remaining, timer.total]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setAt(0), [q])
  // Keep the picked row in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAt((i) => (i + 1) % Math.max(1, items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAt((i) => (i - 1 + items.length) % Math.max(1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[at]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') e.preventDefault()
  }

  let lastGroup = ''
  return (
    <>
      {open && (
        <div className="scrim pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="pal" role="dialog" aria-modal="true" aria-label="Search and commands">
            <div className="pal-input">
              <Search size={18} className="dim" />
              <input
                ref={inputRef}
                value={q}
                placeholder="Search notes, tasks and settings, or type a command"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                role="combobox"
                aria-expanded="true"
                aria-controls="pal-list"
                aria-activedescendant={items[at] ? `pal-${items[at].key}` : undefined}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
              {items.map((it, i) => {
                const head = it.group !== lastGroup ? it.group : null
                lastGroup = it.group
                return (
                  <div key={it.key}>
                    {head && <div className="pal-group">{head}</div>}
                    <button
                      id={`pal-${it.key}`}
                      data-i={i}
                      role="option"
                      aria-selected={i === at}
                      className="pal-row"
                      onMouseMove={() => i !== at && setAt(i)}
                      onClick={() => it.run()}
                    >
                      <span className="pal-icon" style={it.color ? { color: it.color } : undefined}>
                        {it.hint ? <span>{it.hint}</span> : <it.icon size={16} />}
                      </span>
                      <span className="pal-text">
                        <span className="pal-label trunc">{terms.length && it.group !== 'Make it' ? <Marked text={it.label} terms={terms} /> : it.label}</span>
                        {it.sub && <span className="pal-sub trunc">{terms.length ? <Marked text={it.sub} terms={terms} /> : it.sub}</span>}
                      </span>
                      {i === at && <CornerDownLeft size={14} className="pal-enter" />}
                    </button>
                  </div>
                )
              })}
              {!items.length && <div className="pal-empty">Nothing here yet.</div>}
            </div>
            <div className="pal-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>Enter</kbd> open
              </span>
              <span>
                <kbd>Ctrl</kbd>
                <kbd>K</kbd> close
              </span>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <TaskDialog
          task={editing === 'new' ? undefined : editing}
          defaults={editing === 'new' && newTitle ? { title: newTitle } : undefined}
          onClose={() => {
            setEditing(null)
            setNewTitle('')
          }}
        />
      )}
    </>
  )
}
