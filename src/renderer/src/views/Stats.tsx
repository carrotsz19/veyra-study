import { useState } from 'react'
import { addDays, format, startOfDay, subDays } from 'date-fns'
import { useRecords } from '../data/store'
import { dayKey, duration } from '../lib/dates'
import { Bar, Seg } from '../components/ui'

type Range = '7' | '30'

export function Stats() {
  const { items: sessions } = useRecords('session')
  const { items: tasks } = useRecords('task')
  const { items: subjects } = useRecords('subject')
  const [range, setRange] = useState<Range>('7')

  const n = +range
  const from = startOfDay(subDays(new Date(), n - 1))
  const inRange = sessions.filter((s) => s.data.startedAt >= from.getTime())
  const total = inRange.reduce((a, s) => a + s.data.durationSec, 0)

  const days = Array.from({ length: n }, (_, i) => addDays(from, i))
  const perDay = new Map<string, number>()
  inRange.forEach((s) => {
    const k = dayKey(s.data.startedAt)
    perDay.set(k, (perDay.get(k) ?? 0) + s.data.durationSec)
  })
  const max = Math.max(1, ...days.map((d) => perDay.get(dayKey(d)) ?? 0))

  // Streak: consecutive days, ending today (or yesterday), with any study.
  const studied = new Set(sessions.map((s) => dayKey(s.data.startedAt)))
  let streak = 0
  let d = studied.has(dayKey(new Date())) ? new Date() : subDays(new Date(), 1)
  while (studied.has(dayKey(d))) {
    streak++
    d = subDays(d, 1)
  }

  const completed = tasks.filter((t) => t.data.done && (t.data.completedAt ?? 0) >= from.getTime()).length
  const bySubject = [...subjects, null]
    .map((s) => ({
      name: s?.data.name ?? 'No subject',
      color: s?.data.color ?? 'var(--label-tertiary)',
      sec: inRange.filter((x) => x.data.subjectId === (s?.id ?? null)).reduce((a, x) => a + x.data.durationSec, 0)
    }))
    .filter((x) => x.sec > 0)
    .sort((a, b) => b.sec - a.sec)

  return (
    <div className="inner view">
      <div className="topbar">
        <h1>Stats</h1>
        <Seg<Range>
          value={range}
          onChange={setRange}
          options={[
            ['7', 'Last 7 days'],
            ['30', 'Last 30 days']
          ]}
        />
      </div>

      <div className="grid g4" style={{ marginBottom: 18 }}>
        <div className="card stat">
          <h2>Study time</h2>
          <b>{duration(total)}</b>
        </div>
        <div className="card stat">
          <h2>Daily average</h2>
          <b>{duration(total / n)}</b>
        </div>
        <div className="card stat">
          <h2>Tasks finished</h2>
          <b>{completed}</b>
        </div>
        <div className="card stat">
          <h2>Streak</h2>
          <b>
            {streak} <span className="dim" style={{ fontSize: 15 }}>{streak === 1 ? 'day' : 'days'}</span>
          </b>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h2>Study time per day</h2>
        <div className="bars" style={n > 7 ? { gap: 3 } : undefined}>
          {days.map((day) => {
            const sec = perDay.get(dayKey(day)) ?? 0
            return (
              <div className="col" key={dayKey(day)} title={`${format(day, 'EEE d MMM')}: ${duration(sec)}`}>
                {n === 7 && <span className="v">{sec ? duration(sec) : ''}</span>}
                <div className={`b ${sec ? '' : 'zero'}`} style={{ height: `${Math.max(2, (sec / max) * 100)}%` }} />
                <span className="l">{n === 7 ? format(day, 'EEE') : day.getDate() % 5 === 0 || n <= 7 ? format(day, 'd') : ' '}</span>
              </div>
            )
          })}
        </div>
      </div>

      <h2>By subject</h2>
      {bySubject.length ? (
        <div className="ig">
          {bySubject.map((s) => (
            <div className="ig-row" key={s.name}>
              <span style={{ width: 10, height: 10, borderRadius: 9, background: s.color, flexShrink: 0, marginLeft: 6 }} />
              <div className="grow">
                <div className="between">
                  <span className="ig-title">{s.name}</span>
                  <span className="sm dim num">
                    {duration(s.sec)} · {Math.round((s.sec / total) * 100)}%
                  </span>
                </div>
                <div style={{ marginTop: 6 }}>
                  <Bar pct={(s.sec / total) * 100} color={s.color} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card sm dim">Use the focus timer to start tracking study time.</div>
      )}
    </div>
  )
}
