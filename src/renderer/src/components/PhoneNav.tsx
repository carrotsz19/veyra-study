import { useEffect, useRef, useState } from 'react'
import { BarChart3, CalendarDays, Home, ListTodo, MoreHorizontal, NotebookPen, PenLine, Plus, Settings as SettingsIcon, Timer, Users, X } from 'lucide-react'
import type { Route } from '../nav'
import type { NavId } from '@shared/settings'
import { useRecords } from '../data/store'
import { useSettings } from '../data/settings'
import { useTimer, phaseLabel } from './timer'
import { clock, isOverdue } from '../lib/dates'
import { sortSubjects } from '../lib/subjects'
import { useAccount, Avatar } from './account'
import { TaskDialog } from './editors'
import { newNote } from '../views/Notes'

/**
 * The phone's navigation, One UI style: a floating bar with four tabs and
 * More, and a separate round compose button beside it that makes whatever
 * fits the screen you're on (a note on Notes, a task elsewhere).
 */
/** Every screen the bar can hold: its name and icon. */
const SCREENS: Record<NavId, [string, typeof Home]> = {
  today: ['Today', Home],
  tasks: ['Tasks', ListTodo],
  notes: ['Notes', NotebookPen],
  calendar: ['Calendar', CalendarDays],
  groups: ['Groups', Users],
  timer: ['Focus', Timer],
  stats: ['Stats', BarChart3]
}

export function PhoneNav({ route, go }: { route: Route; go: (r: Route) => void }) {
  const [more, setMore] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const { s } = useSettings()
  const timer = useTimer()
  const user = useAccount().state.user
  const late = tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length
  // The four screens you chose for the bar (Settings → Phone); the rest are under More.
  const tabs: [Route['name'], string, typeof Home, string?][] = s.phoneTabs.map((id) => [id, SCREENS[id][0], SCREENS[id][1], id === 'today' && late ? String(late) : undefined])
  const moreScreens = (Object.keys(SCREENS) as NavId[]).filter((id) => !s.phoneTabs.includes(id))
  const hideTyping = useRef(s.phoneHideNavTyping)
  hideTyping.current = s.phoneHideNavTyping

  // The phone's look: bar style, labels, large titles, pure black, where a note's formatting bar sits.
  useEffect(() => {
    const d = document.documentElement.dataset
    d.dock = s.phoneDock
    d.tabLabels = s.phoneTabLabels
    d.largeTitles = String(s.phoneLargeTitles)
    d.noteBar = s.phoneNoteBar
    document.documentElement.classList.toggle('pure-black', s.pureBlack)
  }, [s.phoneDock, s.phoneTabLabels, s.phoneLargeTitles, s.phoneNoteBar, s.pureBlack])

  // A light tap of vibration on the things you press most.
  useEffect(() => {
    if (!s.haptics || !window.veyra.app.haptic) return
    const onTap = (e: Event) => {
      const t = (e.target as HTMLElement | null)?.closest?.('.tick, .phone-tabs button, .phone-compose, .seg button, input.switch, .np-chip, .btn, .ig-row.tap, .np-row')
      if (t) void window.veyra.app.haptic?.(t.matches('.tick, input.switch') ? 'medium' : 'light')
    }
    document.addEventListener('click', onTap, true)
    return () => document.removeEventListener('click', onTap, true)
  }, [s.haptics])

  // Keep the screen on while a focus block runs.
  const awake = s.keepAwakeFocus && timer.running && timer.phase === 'focus'
  useEffect(() => {
    if (!awake) return
    // Android: the window's own keep-screen-on flag.
    const native = window.veyra.app.keepAwake
    if (native) {
      void native(true)
      return () => void native(false)
    }
    if (!('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let live = true
    const take = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock.request('screen').then(
        (l) => (live ? (lock = l) : void l.release()),
        () => {}
      )
    }
    take()
    document.addEventListener('visibilitychange', take)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', take)
      void lock?.release()
    }
  }, [awake])
  const inMore = !tabs.some(([n]) => n === route.name)
  // While the keyboard is up the dock steps aside (instead of riding up on top of the keyboard).
  useEffect(() => {
    let full = window.innerHeight
    const onResize = () => {
      const h = window.innerHeight
      if (h > full) full = h
      // Rotating changes the full height too: only a big drop with a text field focused counts as the keyboard.
      const typing = !!document.activeElement?.closest('input, textarea, [contenteditable="true"]')
      document.body.classList.toggle('kb-open', hideTyping.current && typing && h < full * 0.78)
    }
    const onOrient = () => setTimeout(() => (full = window.innerHeight), 400)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onOrient)
    document.addEventListener('focusout', () => setTimeout(onResize, 250))
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onOrient)
      document.body.classList.remove('kb-open')
    }
  }, [])
  const pick = (r: Route) => {
    setMore(false)
    go(r)
  }

  // What the compose button makes here.
  const subjectId = route.name === 'subject' ? route.id : null
  // It's on every screen, so the dock never changes width as you move around.
  // (Settings → Phone can make it always a task, always a note, or turn it off.)
  const noteBtn = { label: 'New note', icon: PenLine, run: () => void newNote(null, s).then((id) => go({ name: 'notes', noteId: id })) }
  const taskBtn = { label: 'New task', icon: Plus, run: () => setNewTask(true) }
  const compose: { label: string; icon: typeof Plus; run: () => void } | null =
    s.phoneCompose === 'off' ? null : s.phoneCompose === 'note' ? noteBtn : s.phoneCompose === 'task' ? taskBtn : route.name === 'notes' ? noteBtn : taskBtn

  return (
    <>
      {s.phoneTimerPill && (timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
        <button className={`phone-timer ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
          <Timer size={14} /> {phaseLabel(timer.phase)} <b className="num">{clock(timer.remaining)}</b>
        </button>
      )}
      <div className={`phone-dock ${compose ? '' : 'no-compose'}`}>
        <nav className="phone-tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map(([name, label, Icon, badge]) => (
            <button key={name} aria-current={route.name === name} onClick={() => pick({ name } as Route)}>
              <span className="phone-tab-icon">
                <Icon size={21} strokeWidth={route.name === name ? 2.3 : 1.9} />
                {badge && <i>{badge}</i>}
              </span>
              <span className="phone-tab-label">{label}</span>
            </button>
          ))}
          <button aria-current={inMore} onClick={() => setMore(true)}>
            <span className="phone-tab-icon">
              <MoreHorizontal size={21} />
            </span>
            <span className="phone-tab-label">More</span>
          </button>
        </nav>
        {compose && (
          <button className="phone-compose" aria-label={compose.label} title={compose.label} onClick={compose.run}>
            <compose.icon size={24} strokeWidth={2.2} />
          </button>
        )}
      </div>

      {newTask && <TaskDialog defaults={{ subjectId }} onClose={() => setNewTask(false)} />}

      {more && (
        <div className="phone-sheet-scrim" onClick={() => setMore(false)}>
          <div className="phone-sheet" role="dialog" aria-label="More" onClick={(e) => e.stopPropagation()}>
            <div className="phone-sheet-grip" />
            <div className="between">
              <b style={{ fontSize: 18 }}>More</b>
              <button className="iconbtn plain" aria-label="Close" onClick={() => setMore(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="ig" style={{ marginTop: 10 }}>
              {(
                [
                  ...moreScreens.map((id) => [id, id === 'timer' ? 'Focus timer' : SCREENS[id][0], SCREENS[id][1]]),
                  ['settings', user ? `Settings · @${user.username}` : 'Settings', SettingsIcon]
                ] as [Route['name'], string, typeof Home][]
              ).map(([name, label, Icon]) => (
                <button key={name} className="ig-row tap" aria-current={route.name === name} onClick={() => pick({ name } as Route)}>
                  {name === 'settings' && user ? <Avatar user={user} /> : <Icon size={19} className="dim" />}
                  <span className="ig-title">{label}</span>
                </button>
              ))}
            </div>
            {subjects.some((x) => !x.data.archived) && (
              <>
                <h2 style={{ margin: '18px 4px 8px' }}>Subjects</h2>
                <div className="ig">
                  {sortSubjects(subjects)
                    .filter((x) => !x.data.archived)
                    .map((x) => (
                      <button key={x.id} className="ig-row tap" aria-current={route.name === 'subject' && route.id === x.id} onClick={() => pick({ name: 'subject', id: x.id })}>
                        <span className="dot" style={{ background: x.data.color, width: 10, height: 10, borderRadius: 9 }} />
                        <span className="ig-title">{x.data.name}</span>
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
