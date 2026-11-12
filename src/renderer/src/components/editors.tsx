import { useEffect, useRef, useState } from 'react'
import { Check, Plus, Trash2, X } from 'lucide-react'
import type { Priority, Rec, Repeat, Subject, Task, TaskStep } from '@shared/types'
import { cleanRepeat, repeatLabel } from '@shared/repeat'
import { todayKey } from '../lib/dates'
import { db, useRecords } from '../data/store'
import { SUBJECT_COLORS, blankTask, defaultDueDate, sortSubjects } from '../lib/subjects'
import { useSettings } from '../data/settings'
import { Dialog, Seg, useToast } from './ui'
import { Select } from './Select'

export function SubjectSelect({ value, onChange, noneLabel = 'No subject', className }: { value: string | null; onChange: (id: string | null) => void; noneLabel?: string; className?: string }) {
  const { items: subjects } = useRecords('subject')
  return (
    <Select
      label="Subject"
      className={className}
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      options={[
        { value: '', label: noneLabel },
        ...sortSubjects(subjects)
          .filter((s) => !s.data.archived || s.id === value)
          .map((s) => ({ value: s.id, label: s.data.name, dot: s.data.color }))
      ]}
    />
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
  // A step typed into "Add a step" but not yet added still counts when you save.
  const [stepDraft, setStepDraft] = useState('')

  const save = async () => {
    if (!t.title.trim()) return
    const steps = [...(t.steps ?? []), ...(stepDraft.trim() ? [newStep(stepDraft)] : [])].map((x) => ({ ...x, text: x.text.trim() })).filter((x) => x.text)
    const repeat = cleanRepeat(t.repeat)
    // A repeating task needs a date to repeat from.
    const due = repeat && !t.due ? todayKey() : t.due
    await db.put('task', { ...t, title: t.title.trim(), due, steps: steps.length ? steps : undefined, repeat }, task?.id)
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
        <div className="field">
          <label className="field-label">Steps</label>
          <StepsEditor steps={t.steps ?? []} onChange={(steps) => set({ steps })} draft={stepDraft} setDraft={setStepDraft} />
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
          <label className="field-label" htmlFor="task-repeat">Repeat</label>
          <RepeatPicker value={t.repeat ?? null} due={t.due} onChange={(repeat) => set(repeat && !t.due ? { repeat, due: todayKey() } : { repeat })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="task-remind">
            Remind me
          </label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input id="task-remind" type="datetime-local" style={{ width: 220 }} value={t.remindAt ?? ''} onChange={(e) => set({ remindAt: e.target.value || null })} />
            {t.due && (
              <>
                <button type="button" className="btn ghost sm" onClick={() => set({ remindAt: `${shiftDay(t.due!, -1)}T19:00` })}>
                  Day before, 7 pm
                </button>
                <button type="button" className="btn ghost sm" onClick={() => set({ remindAt: `${t.due}T08:00` })}>
                  That morning
                </button>
              </>
            )}
            {t.remindAt && (
              <button type="button" className="btn ghost sm" onClick={() => set({ remindAt: null })}>
                No reminder
              </button>
            )}
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

const newStep = (text = ''): TaskStep => ({ id: Math.random().toString(36).slice(2, 10), text, done: false })

/** The steps inside a task: tick, rename, reorder (Alt+↑/↓), remove; Enter makes the next one. */
function StepsEditor({ steps, onChange, draft, setDraft }: { steps: TaskStep[]; onChange: (s: TaskStep[]) => void; draft: string; setDraft: (v: string) => void }) {
  const refs = useRef(new Map<string, HTMLInputElement | null>())
  const addRef = useRef<HTMLInputElement>(null)
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!focus) return
    ;(focus === 'add' ? addRef.current : refs.current.get(focus))?.focus()
    setFocus(null)
  }, [focus, steps])
  const done = steps.filter((x) => x.done).length
  const edit = (id: string, patch: Partial<TaskStep>) => onChange(steps.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const move = (i: number, by: number) => {
    const j = i + by
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
    setFocus(steps[i].id)
  }
  const add = () => {
    if (!draft.trim()) return
    onChange([...steps, newStep(draft.trim())])
    setDraft('')
  }
  return (
    <div className="steps-edit">
      {steps.length > 0 && (
        <div className="steps-progress" aria-hidden>
          <span style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      )}
      {steps.map((st, i) => (
        <div key={st.id} className={`step-edit ${st.done ? 'done' : ''}`}>
          <button type="button" className="tick sm" role="checkbox" aria-checked={st.done} aria-label={st.done ? 'Mark step not done' : 'Mark step done'} onClick={() => edit(st.id, { done: !st.done })}>
            {st.done && <Check size={11} strokeWidth={3} />}
          </button>
          <input
            ref={(el) => void refs.current.set(st.id, el)}
            value={st.text}
            aria-label={`Step ${i + 1}`}
            onChange={(e) => edit(st.id, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const n = newStep()
                onChange([...steps.slice(0, i + 1), n, ...steps.slice(i + 1)])
                setFocus(n.id)
              } else if (e.key === 'Backspace' && !st.text) {
                e.preventDefault()
                onChange(steps.filter((x) => x.id !== st.id))
                setFocus(steps[i - 1]?.id ?? 'add')
              } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault()
                move(i, e.key === 'ArrowUp' ? -1 : 1)
              }
            }}
          />
          <button type="button" className="iconbtn plain step-x" aria-label="Remove step" title="Remove step" onClick={() => onChange(steps.filter((x) => x.id !== st.id))}>
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="step-edit add">
        <Plus size={15} className="dim" style={{ margin: '0 3px', flexShrink: 0 }} />
        <input
          ref={addRef}
          value={draft}
          placeholder={steps.length ? 'Add a step' : 'Break it into steps (optional)'}
          aria-label="Add a step"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
    </div>
  )
}

type Preset = 'none' | 'day' | 'weekdays' | 'week' | 'fortnight' | 'month' | 'year' | 'custom'
function presetOf(r: Repeat | null): Preset {
  const c = cleanRepeat(r)
  if (!c) return 'none'
  const days = c.days?.join() ?? ''
  if (c.unit === 'day' && c.every === 1) return 'day'
  if (c.unit === 'week' && c.every === 1 && days === '1,2,3,4,5') return 'weekdays'
  if (c.unit === 'week' && !days) return c.every === 1 ? 'week' : c.every === 2 ? 'fortnight' : 'custom'
  if (c.unit === 'month' && c.every === 1) return 'month'
  if (c.unit === 'year' && c.every === 1) return 'year'
  return 'custom'
}
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th')

/** Doesn't repeat / every day / weekday / week / 2 weeks / month / year, or your own rule. */
export function RepeatPicker({ value, due, onChange }: { value: Repeat | null; due: string | null; onChange: (r: Repeat | null) => void }) {
  const [custom, setCustom] = useState(presetOf(value) === 'custom')
  const preset = custom ? 'custom' : presetOf(value)
  const keep = value?.series ? { series: value.series } : {}
  const wd = new Date((due ?? todayKey()) + 'T12:00')
  const pick = (p: Preset) => {
    setCustom(p === 'custom')
    const rules: Record<Exclude<Preset, 'custom'>, Repeat | null> = {
      none: null,
      day: { unit: 'day', every: 1 },
      weekdays: { unit: 'week', every: 1, days: [1, 2, 3, 4, 5] },
      week: { unit: 'week', every: 1 },
      fortnight: { unit: 'week', every: 2 },
      month: { unit: 'month', every: 1 },
      year: { unit: 'year', every: 1 }
    }
    if (p === 'custom') onChange({ unit: 'week', every: 1, days: value?.days?.length ? value.days : [wd.getDay()], ...keep })
    else {
      const rule = rules[p]
      onChange(rule ? { ...rule, ...keep } : null)
    }
  }
  const r = cleanRepeat(value)
  return (
    <div className="repeat-pick">
      <Select
        id="task-repeat"
        label="Repeat"
        value={preset}
        onChange={(v) => pick(v as Preset)}
        options={[
          { value: 'none', label: 'Doesn’t repeat' },
          { value: 'day', label: 'Every day' },
          { value: 'weekdays', label: 'Every weekday', hint: 'Monday to Friday' },
          { value: 'week', label: `Every week on ${DAY_NAMES[wd.getDay()]}` },
          { value: 'fortnight', label: `Every 2 weeks on ${DAY_NAMES[wd.getDay()]}` },
          { value: 'month', label: `Every month on the ${ordinal(wd.getDate())}` },
          { value: 'year', label: 'Every year' },
          { value: 'custom', label: 'Custom…', hint: 'Your own days and how often' }
        ]}
      />
      {preset === 'custom' && r && (
        <div className="repeat-custom">
          <span className="dim">Every</span>
          <input type="number" min={1} max={99} value={r.every} aria-label="How often" onChange={(e) => onChange({ ...r, every: Number(e.target.value) || 1 })} />
          <Select
            label="Unit"
            className="sel-auto"
            value={r.unit}
            onChange={(v) => onChange({ ...r, unit: v as Repeat['unit'], days: v === 'week' ? r.days ?? [wd.getDay()] : undefined })}
            options={(['day', 'week', 'month', 'year'] as const).map((u) => ({ value: u, label: r.every === 1 ? u : `${u}s` }))}
          />
          {r.unit === 'week' && (
            <div className="repeat-days" role="group" aria-label="On these days">
              {DAYS.map((d, i) => {
                const on = (r.days ?? []).includes(i)
                return (
                  <button
                    type="button"
                    key={i}
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    title={DAY_NAMES[i]}
                    onClick={() => {
                      const days = on ? (r.days ?? []).filter((x) => x !== i) : [...(r.days ?? []), i]
                      onChange({ ...r, days: days.length ? days : [i] })
                    }}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      {r && <div className="xs dim repeat-note">{repeatLabel(r, due)}. Ticking it off makes the next one.</div>}
    </div>
  )
}

/** A "YYYY-MM-DD" date moved by some days. */
function shiftDay(day: string, by: number): string {
  const d = new Date(day + 'T12:00:00')
  d.setDate(d.getDate() + by)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
