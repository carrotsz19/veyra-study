import { useState } from 'react'
import { ListTodo, Plus } from 'lucide-react'
import { db, useRecords } from '../data/store'
import { isOverdue, todayKey } from '../lib/dates'
import { Empty, Seg } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { SubjectSelect, TaskDialog } from '../components/editors'

type Filter = 'open' | 'overdue' | 'done' | 'all'

export function Tasks() {
  const { items: tasks, loaded } = useRecords('task')
  const [filter, setFilter] = useState<Filter>('open')
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const [quick, setQuick] = useState('')
  const [adding, setAdding] = useState(false)

  const shown = tasks.filter((t) => {
    if (subjectId && t.data.subjectId !== subjectId) return false
    if (filter === 'open') return !t.data.done
    if (filter === 'done') return t.data.done
    if (filter === 'overdue') return isOverdue(t.data.due, t.data.done)
    return true
  })

  const quickAdd = async () => {
    const title = quick.trim()
    if (!title) return
    await db.put('task', { title, subjectId, done: false, completedAt: null, due: null, priority: 'normal' })
    setQuick('')
  }

  return (
    <div className="inner view">
      <div className="topbar">
        <div>
          <h1>Tasks</h1>
          <p className="dim">{tasks.filter((t) => !t.data.done).length} open</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={16} /> New task
        </button>
      </div>

      <div className="between" style={{ marginBottom: 14 }}>
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
        <div style={{ width: 220 }}>
          <SubjectSelect value={subjectId} onChange={setSubjectId} noneLabel="All subjects" />
        </div>
      </div>

      <form
        className="card row"
        style={{ padding: 8, marginBottom: 14 }}
        onSubmit={(e) => {
          e.preventDefault()
          quickAdd()
        }}
      >
        <Plus size={18} className="dim" style={{ marginLeft: 8 }} />
        <input style={{ border: 0 }} placeholder="Quick add a task and press Enter" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick add task" />
      </form>

      {shown.length ? (
        <TaskList tasks={shown} />
      ) : (
        loaded && (
          <div className="card">
            <Empty icon={ListTodo} title={filter === 'done' ? 'Nothing finished yet' : 'No tasks here'} text="Add one above, or switch filters." />
          </div>
        )
      )}
      {adding && <TaskDialog defaults={{ subjectId, due: todayKey() }} onClose={() => setAdding(false)} />}
    </div>
  )
}
