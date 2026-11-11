import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { db } from '../data/store'
import { buildPrompt, parsePlan, useAiRun } from '../data/ai'
import { dueLabel, todayKey } from '../lib/dates'
import { useSettings } from '../data/settings'
import { useNav } from '../nav'
import { Dialog, useToast } from './ui'
import { SubjectSelect } from './editors'

/** Paste a syllabus; AI lists the deadlines; you pick which become tasks. */
export function PlanDialog({ subjectId: initialSubject, onClose }: { subjectId: string | null; onClose: () => void }) {
  const { s } = useSettings()
  const toast = useToast()
  const { go } = useNav()
  const { text, status, error, run, stop } = useAiRun()
  const [source, setSource] = useState('')
  const [subjectId, setSubjectId] = useState(initialSubject)
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const items = parsePlan(text)
  const chosen = items.filter((_, i) => !skip.has(i))

  const add = async () => {
    for (const it of chosen) await db.put('task', { title: it.title, subjectId, done: false, completedAt: null, due: it.due, priority: s.defaultPriority })
    toast(`Added ${chosen.length} task${chosen.length === 1 ? '' : 's'}`)
    onClose()
  }

  return (
    <Dialog title="Plan from a syllabus" onClose={onClose} width={620}>
      {status === 'idle' ? (
        <>
          <p className="sm dim" style={{ marginTop: -6 }}>
            Paste your course outline, assignment list or exam timetable. AI lists every deadline, and you choose which ones become tasks.
          </p>
          <textarea rows={10} autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder={'Week 3 – Lab report due 14 Oct\nMidterm exam: 2 Nov\nRead chapters 4–6 before week 5…'} aria-label="Syllabus text" />
          <div className="field" style={{ maxWidth: 260 }}>
            <label className="field-label">Subject for these tasks</label>
            <SubjectSelect value={subjectId} onChange={setSubjectId} />
          </div>
          <div className="actions">
            <button className="btn sec" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={!source.trim()} onClick={() => run(buildPrompt('plan', source, { today: todayKey() }))}>
              <Sparkles size={15} /> Find deadlines
            </button>
          </div>
        </>
      ) : (
        <>
          {error ? (
            <p className="ai-error">
              {error}{' '}
              {/Settings → AI/.test(error) && (
                <button className="linkbtn" onClick={() => { sessionStorage.setItem('veyra.settingsSection', 'ai'); go({ name: 'settings' }) }}>
                  Open Settings → AI
                </button>
              )}
            </p>
          ) : items.length ? (
            <div className="ig plain plan-list">
              {items.map((it, i) => (
                <label key={i} className="ig-row tap" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={!skip.has(i)} onChange={() => { const n = new Set(skip); if (n.has(i)) n.delete(i); else n.add(i); setSkip(n) }} />
                  <span className="grow">{it.title}</span>
                  <span className="pill">{it.due ? dueLabel(it.due) : 'No date'}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="dim">{status === 'running' ? 'Reading your syllabus…' : 'No deadlines found. Try pasting more of the syllabus.'}</p>
          )}
          <div className="actions">
            {status === 'running' ? (
              <button className="btn sec" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn ghost left" onClick={() => run(buildPrompt('plan', source, { today: todayKey() }))}>
                Try again
              </button>
            )}
            <button className="btn sec" onClick={onClose}>
              Cancel
            </button>
            <button className="btn" disabled={status !== 'done' || !chosen.length} onClick={add}>
              Add {chosen.length || ''} task{chosen.length === 1 ? '' : 's'}
            </button>
          </div>
          <p className="ai-note">Check dates against your syllabus; AI can misread them.</p>
        </>
      )}
    </Dialog>
  )
}
