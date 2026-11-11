import { useEffect, useState } from 'react'
import { BarChart3, CalendarDays, GraduationCap, Home, ListTodo, Moon, NotebookPen, Plus, Sun, Timer } from 'lucide-react'
import { useRecords } from './data/store'
import { clock, isOverdue } from './lib/dates'
import { NavCtx, type Route } from './nav'
import { ToastProvider } from './components/ui'
import { TimerProvider, useTimer } from './components/timer'
import { SubjectDialog } from './components/editors'
import { Today } from './views/Today'
import { Tasks } from './views/Tasks'
import { Notes } from './views/Notes'
import { Calendar } from './views/Calendar'
import { TimerView } from './views/TimerView'
import { Stats } from './views/Stats'
import { SubjectView } from './views/SubjectView'

type Theme = 'system' | 'light' | 'dark'

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('veyra.theme') as Theme) || 'system')
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    apply()
    localStorage.setItem('veyra.theme', theme)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme]
}

function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const timer = useTimer()
  const [theme, setTheme] = useTheme()
  const [adding, setAdding] = useState(false)

  const open = tasks.filter((t) => !t.data.done).length
  const overdue = tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const nav: [Route['name'], string, typeof Home, string?][] = [
    ['today', 'Today', Home, overdue ? `${overdue} late` : undefined],
    ['tasks', 'Tasks', ListTodo, open ? String(open) : undefined],
    ['notes', 'Notes', NotebookPen],
    ['calendar', 'Calendar', CalendarDays],
    ['timer', 'Focus timer', Timer],
    ['stats', 'Stats', BarChart3]
  ]
  const nextTheme: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' }

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
            {count && <span className="count">{count}</span>}
          </button>
        ))}
      </nav>

      <div className="between group-label">
        <h2 style={{ margin: 0 }}>Subjects</h2>
        <button className="iconbtn plain" style={{ width: 26, height: 26 }} aria-label="Add subject" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
      </div>
      <nav aria-label="Subjects">
        {subjects
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

      <div className="spacer" />
      {(timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
        <button className={`sidecard ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
          <div className="xs" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {timer.phase === 'focus' ? 'Focus' : 'Break'} {timer.running ? '' : '· paused'}
          </div>
          <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
            {clock(timer.remaining)}
          </div>
        </button>
      )}
      <button className="navbtn" style={{ marginTop: 10, color: 'var(--dim)' }} onClick={() => setTheme(nextTheme[theme])} title="Change theme">
        {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        {theme === 'system' ? 'Theme: System' : theme === 'dark' ? 'Theme: Dark' : 'Theme: Light'}
      </button>
      {adding && <SubjectDialog onClose={() => setAdding(false)} onSaved={(id) => go({ name: 'subject', id })} />}
    </aside>
  )
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'today':
      return <Today />
    case 'tasks':
      return <Tasks />
    case 'notes':
      return <Notes noteId={route.noteId} />
    case 'calendar':
      return <Calendar />
    case 'timer':
      return <TimerView />
    case 'stats':
      return <Stats />
    case 'subject':
      return <SubjectView id={route.id} />
  }
}

export function App() {
  const [route, go] = useState<Route>(() => {
    // Start screen from the URL hash (#tasks, #stats...), used by dev checks.
    const name = location.hash.slice(1)
    return ['today', 'tasks', 'notes', 'calendar', 'timer', 'stats'].includes(name) ? ({ name } as Route) : { name: 'today' }
  })
  return (
    <ToastProvider>
      <TimerProvider>
        <NavCtx.Provider value={{ route, go }}>
          <div className="shell">
            <Sidebar route={route} go={go} />
            <main className="main">
              <Screen key={route.name + ('id' in route ? route.id : '')} route={route} />
            </main>
          </div>
        </NavCtx.Provider>
      </TimerProvider>
    </ToastProvider>
  )
}
