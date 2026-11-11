import { useState } from 'react'
import { BarChart3, CalendarDays, Home, ListTodo, MoreHorizontal, NotebookPen, PenLine, Plus, Settings as SettingsIcon, Timer, Users, X } from 'lucide-react'
import type { Route } from '../nav'
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
export function PhoneNav({ route, go }: { route: Route; go: (r: Route) => void }) {
  const [more, setMore] = useState(false)
  const [newTask, setNewTask] = useState(false)
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const { s } = useSettings()
  const timer = useTimer()
  const user = useAccount().state.user
  const late = tasks.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const tabs: [Route['name'], string, typeof Home, string?][] = [
    ['today', 'Today', Home, late ? String(late) : undefined],
    ['tasks', 'Tasks', ListTodo],
    ['notes', 'Notes', NotebookPen],
    ['calendar', 'Calendar', CalendarDays]
  ]
  const inMore = !tabs.some(([n]) => n === route.name)
  const pick = (r: Route) => {
    setMore(false)
    go(r)
  }

  // What the compose button makes here.
  const subjectId = route.name === 'subject' ? route.id : null
  const compose: { label: string; icon: typeof Plus; run: () => void } | null =
    route.name === 'notes'
      ? { label: 'New note', icon: PenLine, run: () => void newNote(null, s).then((id) => go({ name: 'notes', noteId: id })) }
      : ['today', 'tasks', 'calendar', 'subject'].includes(route.name)
        ? { label: 'New task', icon: Plus, run: () => setNewTask(true) }
        : null

  return (
    <>
      {(timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
        <button className={`phone-timer ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
          <Timer size={14} /> {phaseLabel(timer.phase)} <b className="num">{clock(timer.remaining)}</b>
        </button>
      )}
      <div className={`phone-dock ${compose ? '' : 'no-compose'}`}>
        <nav className="phone-tabs" aria-label="Main">
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
                  ['groups', 'Group work', Users],
                  ['timer', 'Focus timer', Timer],
                  ['stats', 'Stats', BarChart3],
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
