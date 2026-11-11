import { useState } from 'react'
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Rec } from '@shared/types'
import { useRecords } from '../data/store'
import { dayKey, todayKey } from '../lib/dates'
import { TaskDialog } from '../components/editors'

export function Calendar() {
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const [month, setMonth] = useState(() => startOfMonth(new Date()))
  const [newOn, setNewOn] = useState<string | null>(null)
  const [editing, setEditing] = useState<Rec<'task'> | null>(null)

  const start = startOfWeek(month, { weekStartsOn: 1 })
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
  const days: Date[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)

  const byDay = new Map<string, Rec<'task'>[]>()
  tasks.forEach((t) => t.data.due && byDay.set(t.data.due, [...(byDay.get(t.data.due) ?? []), t]))
  const color = (t: Rec<'task'>) => subjects.find((s) => s.id === t.data.subjectId)?.data.color ?? 'var(--label-tertiary)'
  const today = todayKey()

  return (
    <div className="view" style={{ maxWidth: 1300, margin: '0 auto' }}>
      <div className="topbar">
        <h1>{format(month, 'MMMM yyyy')}</h1>
        <div className="row">
          <button className="btn sec sm" onClick={() => setMonth(startOfMonth(new Date()))}>
            Today
          </button>
          <button className="iconbtn" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={17} />
          </button>
          <button className="iconbtn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={17} />
          </button>
        </div>
      </div>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = dayKey(d)
          const list = byDay.get(key) ?? []
          return (
            <div
              key={key}
              className={`cell ${isSameMonth(d, month) ? '' : 'out'} ${key === today ? 'today' : ''}`}
              onClick={() => setNewOn(key)}
              role="button"
              tabIndex={0}
              aria-label={`${format(d, 'd MMMM')}, ${list.length} tasks. Add a task.`}
            >
              <span className="d">{format(d, 'd')}</span>
              {list.slice(0, 4).map((t) => (
                <span
                  key={t.id}
                  className={`chip ${t.data.done ? 'done' : ''}`}
                  style={{ borderLeftColor: color(t) }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing(t)
                  }}
                >
                  {t.data.title}
                </span>
              ))}
              {list.length > 4 && <span className="xs dim">+{list.length - 4} more</span>}
            </div>
          )
        })}
      </div>
      <p className="sm dim">Click a day to add a task due then.</p>
      {newOn && <TaskDialog defaults={{ due: newOn }} onClose={() => setNewOn(null)} />}
      {editing && <TaskDialog task={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
