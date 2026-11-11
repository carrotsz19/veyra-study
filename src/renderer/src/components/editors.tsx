import { useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import type { Priority, Rec, Subject, Task } from '@shared/types'
import { db, useRecords } from '../data/store'
import { SUBJECT_COLORS, blankTask, defaultDueDate, sortSubjects } from '../lib/subjects'
import { useSettings } from '../data/settings'
import { Dialog, Seg, useToast } from './ui'

export function SubjectSelect({ value, onChange, noneLabel = 'No subject' }: { value: string | null; onChange: (id: string | null) => void; noneLabel?: string }) {
  const { items: subjects } = useRecords('subject')
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{noneLabel}</option>
      {sortSubjects(subjects)
        .filter((s) => !s.data.archived || s.id === value)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.data.name}
          </option>
        ))}
    </select>
  )
}

/** Create (no `task`) or edit a task. */
export function TaskDialog({
  task,
  defaults,
  onClose
}: {
  task?: Rec<'task'>
  defaults?: Partial<Task>
  onClose: () => void
}) {
  const toast = useToast()
  const { s } = useSettings()
  const [t, setT] = useState<Task>(task ? task.data : { ...blankTask(null, defaultDueDate(s.defaultDue), s.defaultPriority), ...defaults })
  const set = (patch: Partial<Task>) => setT((cur) => ({ ...cur, ...patch }))

  const save = async () => {
    if (!t.title.trim()) return
    await db.put('task', { ...t, title: t.title.trim() }, task?.id)
    onClose()
  }
  const remove = async () => {
    if (!task) return
    await db.remove('task', task.id)
    toast('Task deleted', { label: 'Undo', run: () => db.put('task', task.data, task.id) })
    onClose()
  }

  return (
    <Dialog title={task ? 'Edit task' : 'New task'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="task-title">Task</label>
          <input id="task-title" autoFocus value={t.title} placeholder="Read chapter 4" onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="grid g2 field">
          <div>
            <label className="field-label">Subject</label>
            <SubjectSelect value={t.subjectId} onChange={(subjectId) => set({ subjectId })} />
          </div>
          <div>
            <label className="field-label" htmlFor="task-due">Due</label>
            <input id="task-due" type="date" value={t.due ?? ''} onChange={(e) => set({ due: e.target.value || null })} />
          </div>
        </div>
        <div className="field">
          <label className="field-label">Priority</label>
          <Seg<Priority>
            value={t.priority}
            onChange={(priority) => set({ priority })}
            options={[
              ['low', 'Low'],
              ['normal', 'Normal'],
              ['high', 'High']
            ]}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="task-details">Details</label>
          <textarea id="task-details" rows={3} value={t.details ?? ''} placeholder="Optional" onChange={(e) => set({ details: e.target.value })} />
        </div>
        <div className="actions">
          {task && (
            <button type="button" className="btn ghost left" onClick={remove}>
              <Trash2 size={15} /> Delete
            </button>
          )}
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!t.title.trim()}>
            {task ? 'Save' : 'Add task'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function SubjectDialog({ subject, onClose, onSaved }: { subject?: Rec<'subject'>; onClose: () => void; onSaved?: (id: string) => void }) {
  const [s, setS] = useState<Subject>(subject ? subject.data : { name: '', color: SUBJECT_COLORS[0] })
  const save = async () => {
    if (!s.name.trim()) return
    const rec = await db.put('subject', { ...s, name: s.name.trim() }, subject?.id)
    onSaved?.(rec.id)
    onClose()
  }
  return (
    <Dialog title={subject ? 'Edit subject' : 'New subject'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="subj-name">Name</label>
          <input id="subj-name" autoFocus value={s.name} placeholder="Biology" onChange={(e) => setS({ ...s, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">Colour</label>
          <div className="swatches" role="radiogroup">
            {SUBJECT_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                className="swatch"
                role="radio"
                aria-checked={s.color === c}
                aria-label={c}
                style={{ background: c, color: '#fff' }}
                onClick={() => setS({ ...s, color: c })}
              >
                {s.color === c && <Check size={14} />}
              </button>
            ))}
            <label className={`swatch custom-swatch ${SUBJECT_COLORS.includes(s.color) ? '' : 'on'}`} title="Any colour" style={SUBJECT_COLORS.includes(s.color) ? undefined : { background: s.color }}>
              <input type="color" aria-label="Pick any colour" value={s.color} onChange={(e) => setS({ ...s, color: e.target.value })} />
              {SUBJECT_COLORS.includes(s.color) ? '+' : <Check size={14} />}
            </label>
          </div>
        </div>
        <div className="actions">
          {subject && (
            <button type="button" className="btn ghost left" onClick={() => db.put('subject', { ...s, archived: !s.archived }, subject.id).then(onClose)}>
              {s.archived ? 'Unarchive' : 'Archive'}
            </button>
          )}
          <button type="button" className="btn sec" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={!s.name.trim()}>
            {subject ? 'Save' : 'Add subject'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
