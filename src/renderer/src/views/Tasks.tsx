import { useEffect, useRef, useState } from 'react'
import { ListTodo, Plus, Search, X } from 'lucide-react'
import type { Rec } from '@shared/types'
import { db, useRecords } from '../data/store'
import { dueLabel, isOverdue, todayKey } from '../lib/dates'
import { Empty, Seg, useToast } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { SubjectSelect, TaskDialog } from '../components/editors'
import { useSettings } from '../data/settings'
import { defaultDueDate } from '../lib/subjects'

type Filter = 'open' | 'overdue' | 'done' | 'all'

/** Splits tasks into Overdue / Today / Upcoming / No due date / Finished. */
function groups(tasks: Rec<'task'>[]): [string, Rec<'task'>[]][] {
  const today = todayKey()
  const out: [string, Rec<'task'>[]][] = [
    ['Overdue', tasks.filter((t) => !t.data.done && t.data.due && t.data.due < today)],
    ['Today', tasks.filter((t) => !t.data.done && t.data.due === today)],
    ['Upcoming', tasks.filter((t) => !t.data.done && t.data.due && t.data.due > today)],
    ['No due date', tasks.filter((t) => !t.data.done && !t.data.due)],
    ['Finished', tasks.filter((t) => t.data.done)]
  ]
  return out.filter(([, list]) => list.length)
}

export function Tasks() {
  const { items: allTasks, loaded } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('open')
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [quick, setQuick] = useState('')
  const [adding, setAdding] = useState(false)
  const { s } = useSettings()
  const searchRef = useRef<HTMLInputElement>(null)

  // Tasks from archived subjects stay out of the list (find them in Settings → Subjects).
  const archived = new Set(subjects.filter((x) => x.data.archived).map((x) => x.id))
  const tasks = allTasks.filter((t) => !t.data.subjectId || !archived.has(t.data.subjectId) || t.data.subjectId === subjectId)
  const query = q.trim().toLowerCase()

  const shown = tasks.filter((t) => {
    if (subjectId && t.data.subjectId !== subjectId) return false
    if (query && !t.data.title.toLowerCase().includes(query) && !(t.data.details ?? '').toLowerCase().includes(query)) return false
    if (filter === 'open') return !t.data.done
    if (filter === 'done') return t.data.done
    if (filter === 'overdue') return isOverdue(t.data.due, t.data.done)
    return true
  })

  const due = defaultDueDate(s.defaultDue)
  const quickAdd = async () => {
    const title = quick.trim()
    if (!title) return
    await db.put('task', { title, subjectId, done: false, completedAt: null, due, priority: s.defaultPriority })
    setQuick('')
    // Don't let the new task vanish because the list is showing finished or late tasks.
    if (filter === 'done' || (filter === 'overdue' && !isOverdue(due, false))) {
      setFilter('open')
      toast('Task added to Open')
    }
  }

  // Ctrl+N new task, Ctrl+F search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setAdding(true)
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sections = filter === 'open' || filter === 'all' ? groups(shown) : null
  const subjectName = subjects.find((x) => x.id === subjectId)?.data.name

  return (
    <div className="inner view">
      <div className="topbar">
        <div>
          <h1>Tasks</h1>
          <p className="dim">{tasks.filter((t) => !t.data.done).length} open</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)} title="New task (Ctrl+N)">
          <Plus size={16} /> New task
        </button>
      </div>

      <div className="between tasks-filters">
        <Seg<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            ['open', 'Open'],
            ['overdue', 'Overdue'],
            ['done', 'Done'],
            ['all', 'All']
          ]}
        />
        <div className="row" style={{ gap: 8 }}>
          <div className="search-box">
            <Search size={15} className="dim" />
            <input ref={searchRef} placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
            {q && (
              <button aria-label="Clear search" onClick={() => setQ('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <div style={{ width: 200 }}>
            <SubjectSelect value={subjectId} onChange={setSubjectId} noneLabel="All subjects" />
          </div>
        </div>
      </div>

      <form
        className="card row quick-add"
        onSubmit={(e) => {
          e.preventDefault()
          quickAdd()
        }}
      >
        <Plus size={18} className="dim" style={{ marginLeft: 8 }} />
        <input style={{ border: 0 }} placeholder="Quick add a task and press Enter" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick add task" />
        <span className="quick-meta" title="Change these defaults in Settings → Tasks">
          {subjectName && <span className="pill">{subjectName}</span>}
          <span className="pill">{due ? `Due ${dueLabel(due).toLowerCase()}` : 'No due date'}</span>
          {s.defaultPriority !== 'normal' && <span className={`pill ${s.defaultPriority === 'high' ? 'bad' : ''}`}>{s.defaultPriority === 'high' ? 'High' : 'Low'}</span>}
        </span>
      </form>

      {shown.length ? (
        sections ? (
          sections.map(([title, list]) => (
            <section key={title} className="task-group">
              <h2>
                {title} <span className="tert">{list.length}</span>
              </h2>
              <TaskList tasks={list} />
            </section>
          ))
        ) : (
          <TaskList tasks={shown} />
        )
      ) : (
        loaded && (
          <div className="card">
            <Empty
              icon={ListTodo}
              title={query ? 'No tasks match' : filter === 'done' ? 'Nothing finished yet' : filter === 'overdue' ? 'Nothing overdue' : 'No tasks here'}
              text={query ? 'Try other words, or clear the search.' : 'Add one above, or switch filters.'}
            />
          </div>
        )
      )}
      {adding && <TaskDialog defaults={{ subjectId }} onClose={() => setAdding(false)} />}
    </div>
  )
}
