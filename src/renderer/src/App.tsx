import { useEffect, useState } from 'react'
import type { NavId, ThemeMode } from '@shared/settings'
import { SettingsProvider, useSettings } from './data/settings'
import { phaseLabel } from './components/timer'
import { BarChart3, CalendarDays, GraduationCap, Home, ListTodo, Monitor, Moon, NotebookPen, Plus, Settings as SettingsIcon, Sun, Timer, Users } from 'lucide-react'
import { useRecords } from './data/store'
import { clock, isOverdue } from './lib/dates'
import { sortSubjects } from './lib/subjects'
import { NavCtx, type Route } from './nav'
import { ToastProvider, useToast } from './components/ui'
import { AccountGate, Avatar, useAccount } from './components/account'
import { Settings } from './views/Settings'
import { TimerProvider, useTimer } from './components/timer'
import { SubjectDialog } from './components/editors'
import { Today } from './views/Today'
import { Tasks } from './views/Tasks'
import { Notes } from './views/Notes'
import { Calendar } from './views/Calendar'
import { TimerView } from './views/TimerView'
import { Stats } from './views/Stats'
import { SubjectView } from './views/SubjectView'
import { Groups } from './views/Groups'
import { prefetchGroups } from './data/groups'
import { startDriveBackup } from './data/drive'

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const timer = useTimer()
  const { s, set } = useSettings()
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

  return (
    <aside className="side">
      <div className="brand">
        <div className="mark">
          <GraduationCap size={18} />
        </div>
        <b>Veyra Study</b>
      </div>
      <nav aria-label="Main">
        {nav.map(([name, label, Icon, count]) => (
          <button key={name} className="navbtn" aria-current={route.name === name} onClick={() => go({ name } as Route)}>
            <Icon size={17} /> {label}
            {count && s.showCounts && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>

      {s.showSubjectsInSidebar && (
        <>
      <div className="between group-label">
        <h2 style={{ margin: 0 }}>Subjects</h2>
        <button className="iconbtn plain" style={{ width: 26, height: 26 }} aria-label="Add subject" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
      </div>
      <nav aria-label="Subjects">
        {sortSubjects(subjects)
          .filter((s) => !s.data.archived)
          .map((s) => (
            <button key={s.id} className="navbtn" aria-current={route.name === 'subject' && route.id === s.id} onClick={() => go({ name: 'subject', id: s.id })}>
              <span className="dot" style={{ background: s.data.color }} />
              <span className="trunc">{s.data.name}</span>
            </button>
          ))}
        {!subjects.some((s) => !s.data.archived) && (
          <button className="navbtn dim" onClick={() => setAdding(true)} style={{ fontWeight: 500 }}>
            <Plus size={16} /> Add your first subject
          </button>
        )}
      </nav>
        </>
      )}

      <div className="spacer" />
      {s.showTimerCard && (timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
        <button className={`sidecard ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
          <div className="xs" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
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
          <span className="grow" style={{ minWidth: 0 }}>
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
  // Group work loads in the background, so the tab opens ready.
  useEffect(() => (signedIn ? prefetchGroups() : undefined), [signedIn])
  // Notes back up to Google Drive (when it's connected and backup is on).
  useEffect(() => startDriveBackup(), [])
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
      <NavCtx.Provider value={{ route, go }}>
        <div className="shell">
          <Sidebar route={route} go={go} />
          <main className={`main ${route.name === 'settings' ? 'main-settings' : ''}`}>
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
