import { useState } from 'react'
import { startOfWeek } from 'date-fns'
import { ListTodo, Pencil, Play, Plus } from 'lucide-react'
import { db, useRecords } from '../data/store'
import { duration, isOverdue } from '../lib/dates'
import { progress } from '../lib/subjects'
import { Bar, Empty, Seg } from '../components/ui'
import { TaskList } from '../components/TaskList'
import { SubjectDialog, TaskDialog } from '../components/editors'
import { useTimer } from '../components/timer'
import { useNav } from '../nav'
import { Notes } from './Notes'
import { useSettings } from '../data/settings'

export function SubjectView({ id }: { id: string }) {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const { items: sessions } = useRecords('session')
  const timer = useTimer()
  const { go } = useNav()
  const [tab, setTab] = useState<'tasks' | 'notes'>('tasks')
  const { s: settings } = useSettings()
  const [showDone, setShowDone] = useState(settings.showDoneInLists)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(false)

  const subject = subjects.find((s) => s.id === id)
  if (!subject) return null

  const mine = tasks.filter((t) => t.data.subjectId === id)
  const p = progress(tasks, id)
  const mySessions = sessions.filter((s) => s.data.subjectId === id)
  const weekStart = startOfWeek(new Date(), { weekStartsOn: settings.weekStart }).getTime()
  const week = mySessions.filter((s) => s.data.startedAt >= weekStart).reduce((n, s) => n + s.data.durationSec, 0)
  const allTime = mySessions.reduce((n, s) => n + s.data.durationSec, 0)
  const overdue = mine.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const shownTasks = mine.filter((t) => showDone || !t.data.done)

  return (
    <div className="inner view" key={id}>
      {subject.data.archived && (
        <div className="banner row" style={{ justifyContent: 'space-between' }}>
          <span>This subject is archived, so it’s hidden from the sidebar and Today.</span>
          <button className="btn sm" onClick={() => db.put('subject', { ...subject.data, archived: false }, subject.id)}>
            Unarchive
          </button>
        </div>
      )}
      <div className="topbar">
        <div className="row" style={{ gap: 12 }}>
          <span style={{ width: 14, height: 14, borderRadius: 9, background: subject.data.color }} />
          <h1>{subject.data.name}</h1>
          <button className="iconbtn plain" aria-label="Edit subject" onClick={() => setEditing(true)}>
            <Pencil size={15} />
          </button>
        </div>
        <div className="row">
          <button
            className="btn sec"
            onClick={() => {
              timer.study(id)
              go({ name: 'timer' })
            }}
          >
            <Play size={15} /> Study this
          </button>
          <button className="btn" onClick={() => setAdding(true)}>
            <Plus size={16} /> New task
          </button>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 18 }}>
        <div className="card stat">
          <h2>Progress</h2>
          <b>{p.pct}%</b>
          <div style={{ marginTop: 8 }}>
            <Bar pct={p.pct} color={subject.data.color} />
          </div>
        </div>
        <div className="card stat">
          <h2>Tasks done</h2>
          <b>
            {p.done}
            <span className="dim" style={{ fontSize: 16 }}>/{p.total}</span>
          </b>
        </div>
        <div className="card stat">
          <h2>This week</h2>
          <b>{duration(week)}</b>
          <div className="xs dim">{duration(allTime)} all time</div>
        </div>
        <div className="card stat">
          <h2>Overdue</h2>
          <b style={overdue ? { color: 'var(--bad)' } : undefined}>{overdue}</b>
        </div>
      </div>

      <div className="between" style={{ marginBottom: 12 }}>
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            ['tasks', 'Tasks'],
            ['notes', 'Notes']
          ]}
        />
        {tab === 'tasks' && (
          <label className="row sm dim" style={{ cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show finished
          </label>
        )}
      </div>

      {tab === 'tasks' ? (
        shownTasks.length ? (
          <TaskList tasks={shownTasks} showSubject={false} />
        ) : (
          <div className="card">
            <Empty
              icon={ListTodo}
              title={mine.length ? 'All done' : 'No tasks yet'}
              text={mine.length ? 'Every task in this subject is finished.' : 'Break the subject into tasks to track your progress.'}
              action={
                <button className="btn" onClick={() => setAdding(true)}>
                  <Plus size={16} /> New task
                </button>
              }
            />
          </div>
        )
      ) : (
        <Notes subjectFilter={id} />
      )}

      {adding && <TaskDialog defaults={{ subjectId: id }} onClose={() => setAdding(false)} />}
      {editing && <SubjectDialog subject={subject} onClose={() => setEditing(false)} />}
    </div>
  )
}
