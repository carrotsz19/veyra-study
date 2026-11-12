import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavId, ThemeMode } from '@shared/settings'
import { SettingsProvider, useSettings } from './data/settings'
import { phaseLabel } from './components/timer'
import { BarChart3, CalendarDays, GraduationCap, Home, ListTodo, Monitor, Moon, NotebookPen, Plus, Search, Settings as SettingsIcon, Sun, Timer, Users } from 'lucide-react'
import { useRecords } from './data/store'
import { clock, isOverdue } from './lib/dates'
import { NavCtx, useNav, type Route } from './nav'
import { ToastProvider, useToast } from './components/ui'
import { AccountGate, Avatar, useAccount } from './components/account'
import { Settings } from './views/Settings'
import { TimerProvider, useTimer } from './components/timer'
import { SubjectDialog } from './components/editors'
import { Today } from './views/Today'
import { Tasks } from './views/Tasks'
import { Notes } from './views/Notes'
import { Calendar, usePrefetchCalendar } from './views/Calendar'
import { TimerView } from './views/TimerView'
import { Stats } from './views/Stats'
import { SubjectView } from './views/SubjectView'
import { Groups } from './views/Groups'
import { prefetchGroups } from './data/groups'
import { startDriveBackup } from './data/drive'
import { VoiceSetupHost } from './components/notes/Voice'
import { PhoneNav } from './components/PhoneNav'
import { Palette } from './components/Palette'
import { TitleBar } from './components/TitleBar'
import { emptyOldTrash } from './lib/notes'
import { onAndroid, usePhone } from './lib/phone'
import { startSegments } from './lib/segments'
import { transition } from './lib/motion'
import { IS_DEV } from '@shared/channel'
import { BetaNotice } from './components/BetaNotice'
import { ServerHoursNotice } from './components/ServerHours'
import { SubjectNav } from './components/SubjectNav'

startSegments()

/** Full → icons only → hidden (slides out at the left edge) → full. */
export const nextSidebarMode = (m: 'full' | 'icons' | 'hidden') => (m === 'full' ? 'icons' : m === 'icons' ? 'hidden' : 'full')

function Sidebar({ route, go, onEnter, onLeave }: { route: Route; go: (r: Route) => void; onEnter?: () => void; onLeave?: () => void }) {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const timer = useTimer()
  const { s, set } = useSettings()
  usePrefetchCalendar(s.weekStart, s.calendarShowEvents)
  const theme = s.theme
  const setTheme = (t: ThemeMode) => set({ theme: t })
  const [adding, setAdding] = useState(false)
  const user = useAccount().state.user

  const archivedSubjects = new Set(subjects.filter((x) => x.data.archived).map((x) => x.id))
  const live = tasks.filter((t) => !t.data.subjectId || !archivedSubjects.has(t.data.subjectId))
  const open = live.filter((t) => !t.data.done).length
  const overdue = live.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const items: Record<NavId, [string, typeof Home, string?]> = {
    today: ['Today', Home, overdue ? `${overdue} late` : undefined],
    tasks: ['Tasks', ListTodo, open ? String(open) : undefined],
    notes: ['Notes', NotebookPen],
    calendar: ['Calendar', CalendarDays],
    groups: ['Group work', Users],
    timer: ['Focus timer', Timer],
    stats: ['Stats', BarChart3]
  }
  const nav = s.nav.filter((n) => n.visible).map((n) => [n.id, ...items[n.id]] as [NavId, string, typeof Home, string?])
  const nextTheme: Record<ThemeMode, ThemeMode> = { system: 'dark', dark: 'light', light: 'system' }
  // Icons only: names show as tooltips.
  const tip = (label: string) => (s.sidebarMode === 'full' ? undefined : label)

  return (
    <aside className="side" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {/* The name is in the title bar on Windows; elsewhere it heads the sidebar. */}
      {!window.veyra.app.titleBar && (
        <div className="brand">
          <div className="mark">
            <GraduationCap size={18} />
          </div>
          <b>Veyra Study</b>
          {IS_DEV && <span className="dev-pill">DEV</span>}
        </div>
      )}
      <button className="side-search" onClick={() => window.dispatchEvent(new Event('veyra:palette'))} title="Search everything and run commands (Ctrl+K)">
        <Search size={15} />
        <span className="grow nav-label">Search</span>
        <kbd className="nav-label">Ctrl K</kbd>
      </button>
      <nav aria-label="Main">
        {nav.map(([name, label, Icon, count]) => (
          <button key={name} className="navbtn" aria-current={route.name === name} onClick={() => go({ name } as Route)} title={tip(count ? `${label} (${count})` : label)} aria-label={label}>
            <Icon size={17} /> <span className="nav-label">{label}</span>
            {count && s.showCounts && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>

      {s.showSubjectsInSidebar && (
        <>
      <SubjectNav
        subjects={subjects}
        route={route}
        go={go}
        tip={tip}
        heading={
          <div className="between group-label side-section">
            <h2 style={{ margin: 0 }}>Subjects</h2>
            <button className="iconbtn plain" style={{ width: 26, height: 26 }} aria-label="Add subject" onClick={() => setAdding(true)}>
              <Plus size={15} />
            </button>
          </div>
        }
      />
      {!subjects.some((s) => !s.data.archived) && (
        <button className="navbtn dim" onClick={() => setAdding(true)} style={{ fontWeight: 500 }}>
          <Plus size={16} /> Add your first subject
        </button>
      )}
        </>
      )}

      <div className="spacer" />
      {s.showTimerCard && (timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
        <button className={`sidecard ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
          <div className="xs nav-label" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {phaseLabel(timer.phase)} {timer.running ? '' : '· paused'}
          </div>
          <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
            {clock(timer.remaining)}
          </div>
        </button>
      )}
      <div className="side-foot">
        <button className="account-chip" aria-current={route.name === 'settings'} onClick={() => go({ name: 'settings' })} title="Account and settings">
          {user ? (
            <Avatar user={user} />
          ) : (
            <span className="avatar">
              <SettingsIcon size={15} />
            </span>
          )}
          <span className="grow nav-label" style={{ minWidth: 0 }}>
            <span className="trunc" style={{ display: 'block', fontWeight: 650 }}>{user ? user.displayName : 'Settings'}</span>
            <span className="trunc xs dim" style={{ display: 'block' }}>{user ? `@${user.username}` : 'Not signed in'}</span>
          </span>
        </button>
        <button
          className="iconbtn plain"
          onClick={() => setTheme(nextTheme[theme])}
          title={theme === 'system' ? 'Theme: System' : theme === 'dark' ? 'Theme: Dark' : 'Theme: Light'}
          aria-label="Change theme"
        >
          {theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}
        </button>
      </div>
      {adding && <SubjectDialog onClose={() => setAdding(false)} onSaved={(id) => go({ name: 'subject', id })} />}
    </aside>
  )
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'today':
      return <Today startEditing={route.edit} />
    case 'tasks':
      return <Tasks />
    case 'notes':
      return <Notes noteId={route.noteId} />
    case 'calendar':
      return <Calendar />
    case 'groups':
      return <Groups />
    case 'timer':
      return <TimerView />
    case 'stats':
      return <Stats />
    case 'subject':
      return <SubjectView id={route.id} />
    case 'settings':
      return <Settings />
  }
}

/** The first start after an update: say so, and offer what's new. */
function UpdatedNotice() {
  const toast = useToast()
  const { go } = useNav()
  useEffect(() => {
    try {
      const seen = localStorage.getItem('veyra.seenVersion')
      localStorage.setItem('veyra.seenVersion', __APP_VERSION__)
      if (seen && seen !== __APP_VERSION__)
        toast(`Veyra Study updated to ${__APP_VERSION__}`, {
          label: 'What’s new',
          run: () => {
            sessionStorage.setItem('veyra.settingsSection', 'updates')
            go({ name: 'settings' })
          }
        })
    } catch {
      /* storage unavailable */
    }
  }, [toast, go])
  // A newer version turned up: say so once. The phone downloads when you say so; the computer
  // downloads by itself and offers to restart (closing the window installs it too).
  useEffect(
    () =>
      window.veyra.update.onState((u) => {
        if (!u.latest) return
        const key = `${u.status}:${u.latest}`
        if (told.has(key)) return
        if (u.status === 'available' && onAndroid()) {
          told.add(key)
          toast(`Veyra Study ${u.latest} is available`, {
            label: 'Update',
            run: () => {
              sessionStorage.setItem('veyra.settingsSection', 'updates')
              go({ name: 'settings' })
            }
          })
        } else if (u.status === 'ready' && !onAndroid()) {
          told.add(key)
          toast(`Veyra Study ${u.latest} is ready to install`, { label: 'Restart', run: () => void window.veyra.update.install() })
        }
      }),
    [toast, go]
  )
  return null
}
const told = new Set<string>()

/** After the first sign-in moved this computer's data into the account. */
function MovedNotice() {
  const toast = useToast()
  useEffect(() => {
    if (sessionStorage.getItem('veyra.moved')) {
      sessionStorage.removeItem('veyra.moved')
      toast('Your notes, tasks and study time are now in your Veyra account.')
    }
  }, [toast])
  return null
}

const ROUTES = ['today', 'tasks', 'notes', 'calendar', 'groups', 'timer', 'stats', 'settings']

/** The app once settings are known: picks the start screen, remembers the last one. */
function Shell() {
  const { ready, s } = useSettings()
  const [route, go] = useState<Route | null>(null)
  const signedIn = useAccount().state.mode === 'account'
  const phone = usePhone()
  const titleBar = !phone && (window.veyra.app.titleBar ?? 0) > 0 ? window.veyra.app.titleBar! : 0
  // Hidden sidebar (Zen-style): it slides out while you point at the left edge or at it, and back after a moment away.
  const [peek, setPeek] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peekIn = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setPeek(true)
  }, [])
  const peekOut = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setPeek(false), 380)
  }, [])
  // Moving to another screen crossfades it in (the same screen again just updates).
  const current = useRef(route)
  current.current = route
  const navigate = useCallback((r: Route) => {
    const cur = current.current
    if (cur && cur.name !== r.name) transition(() => go(r))
    else go(r)
  }, [])
  // Group work loads in the background, so the tab opens ready.
  useEffect(() => (signedIn ? prefetchGroups() : undefined), [signedIn])
  // Notes back up to Google Drive (when it's connected and backup is on).
  useEffect(() => startDriveBackup(), [])
  // Notes in the trash for over 30 days go for good.
  useEffect(() => void emptyOldTrash(), [])
  // The tray menu or a reminder asks for a screen.
  useEffect(() => window.veyra.app.onNav((screen) => ROUTES.includes(screen) && go({ name: screen } as Route)), [])

  useEffect(() => {
    if (!ready || route) return
    // The URL hash (#tasks, #stats...) wins, for dev checks.
    const hash = location.hash.slice(1)
    let name: string = ROUTES.includes(hash) ? hash : s.startScreen
    if (name === 'last') {
      try {
        name = localStorage.getItem('veyra.lastRoute') ?? 'today'
      } catch {
        name = 'today'
      }
    }
    go({ name: ROUTES.includes(name) ? name : 'today' } as Route)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (route && route.name !== 'subject')
      try {
        localStorage.setItem('veyra.lastRoute', route.name)
      } catch {
        /* storage unavailable */
      }
  }, [route])

  if (!route) return null
  return (
    <TimerProvider>
      <NavCtx.Provider value={{ route, go: navigate }}>
        <div className={`shell ${phone ? 'phone-shell' : `${titleBar ? 'has-titlebar' : ''} side-${s.sidebarMode} ${peek ? 'peek' : ''}`}`} data-route={route.name} style={titleBar ? ({ '--titlebar': `${titleBar}px` } as React.CSSProperties) : undefined}>
          {titleBar && <TitleBar />}
          {phone ? <PhoneNav route={route} go={navigate} /> : <Sidebar route={route} go={navigate} onEnter={peekIn} onLeave={peekOut} />}
          {/* Hidden sidebar: pointing at the left edge slides it out. */}
          {!phone && s.sidebarMode === 'hidden' && <div className="side-hotzone" onMouseEnter={peekIn} onMouseLeave={peekOut} aria-hidden />}
          <UpdatedNotice />
          <VoiceSetupHost />
          <Palette />
          <BetaNotice />
          <ServerHoursNotice />
          <main className={`main ${route.name === 'settings' ? 'main-settings' : route.name === 'notes' ? 'main-notes' : route.name === 'groups' ? 'main-groups' : route.name === 'calendar' ? 'main-calendar' : ''}`}>
            <Screen key={route.name + ('id' in route ? route.id : '')} route={route} />
          </main>
        </div>
      </NavCtx.Provider>
    </TimerProvider>
  )
}

export function App() {
  return (
    <ToastProvider>
      <AccountGate>
        <MovedNotice />
        <SettingsProvider>
          <Shell />
        </SettingsProvider>
      </AccountGate>
    </ToastProvider>
  )
}
