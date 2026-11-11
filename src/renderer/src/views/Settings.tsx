import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, CalendarDays, Check, Database, Eye, EyeOff, Home, LayoutPanelLeft, ListTodo, NotebookPen,
  Palette, Play, RotateCcw, Search, SlidersHorizontal, Timer, UserRound, Link2, X, type LucideIcon
} from 'lucide-react'
import { ACCENTS, DEFAULT_SETTINGS, NAV_LABELS, type AppSettings, type NavId } from '@shared/settings'
import { useSettings } from '../data/settings'
import { playSound } from '../components/timer'
import { useToast } from '../components/ui'
import { NOTE_COVERS } from '../components/notes/NoteEditor'
import { AccountSection, GoogleSection } from './Connections'

/* =====================================================================
   Settings: categories on the left, one category at a time on the
   right, and a search that finds any option across all of them.
===================================================================== */

type SectionId = 'general' | 'appearance' | 'sidebar' | 'today' | 'tasks' | 'notes' | 'timer' | 'calendar' | 'account' | 'connections' | 'data'

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; hint: string; keys?: (keyof AppSettings)[] }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, hint: 'Your name, start screen, week and time', keys: ['name', 'greeting', 'startScreen', 'weekStart', 'timeFormat'] },
  { id: 'appearance', label: 'Appearance', icon: Palette, hint: 'Theme, colour, font, size and spacing', keys: ['theme', 'accent', 'font', 'zoom', 'density', 'corners', 'reduceMotion'] },
  { id: 'sidebar', label: 'Sidebar', icon: LayoutPanelLeft, hint: 'What the sidebar shows, and in what order', keys: ['nav', 'showCounts', 'showSubjectsInSidebar', 'showTimerCard'] },
  { id: 'today', label: 'Today', icon: Home, hint: 'What your Today page shows', keys: ['todayStats', 'todayDue', 'todayUpcoming', 'upcomingCount', 'todaySchedule', 'todayFocus', 'todaySubjects'] },
  { id: 'tasks', label: 'Tasks', icon: ListTodo, hint: 'Defaults for new tasks, and how lists sort', keys: ['defaultPriority', 'defaultDue', 'taskSort', 'showDoneInLists', 'highlightOverdue'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, hint: 'How new notes start and how pages look', keys: ['noteTemplate', 'noteFont', 'noteCover', 'noteWidth', 'noteSize', 'spellcheck', 'showWordCount'] },
  { id: 'timer', label: 'Focus timer', icon: Timer, hint: 'Lengths, long breaks, sounds and your daily goal', keys: ['focusMin', 'breakMin', 'longBreakMin', 'longBreakEvery', 'autoStartBreaks', 'autoStartFocus', 'sound', 'volume', 'notify', 'dailyGoalMin'] },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, hint: 'What appears on the calendar', keys: ['calendarShowTasks', 'calendarShowDone', 'calendarShowEvents'] },
  { id: 'account', label: 'Account', icon: UserRound, hint: 'Your Veyra account' },
  { id: 'connections', label: 'Connected calendars', icon: Link2, hint: 'Google Calendar and calendar links' },
  { id: 'data', label: 'Data & privacy', icon: Database, hint: 'Export, where data lives, and resets' }
]

/* ---------- building blocks ---------- */
const QueryCtx = createContext('')

function matches(q: string, ...texts: (string | undefined)[]) {
  if (!q) return true
  const hay = texts.filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w))
}

/** One setting: label and hint on the left, the control on the right (or below, when wide). */
function Row({ label, hint, children, stack, keywords }: { label: string; hint?: string; children: ReactNode; stack?: boolean; keywords?: string }) {
  const q = useContext(QueryCtx)
  if (!matches(q, label, hint, keywords)) return null
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: string }) {
  return (
    <div className="set-group">
      {title && <h2>{title}</h2>}
      <div className="set-card">{children}</div>
      {footer && <p className="set-footer">{footer}</p>}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" className="switch" role="switch" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />
}

function Choice<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} role="radio" aria-checked={v === value} aria-selected={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <select className="set-select" aria-label={label} value={String(value)} onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)![0])}>
      {options.map(([v, l]) => (
        <option key={String(v)} value={String(v)}>
          {l}
        </option>
      ))}
    </select>
  )
}

function Stepper({ value, min, max, step = 1, unit, onChange, label }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; label: string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <span className="num">
        {value}
        {unit && <small> {unit}</small>}
      </span>
      <button aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
        +
      </button>
    </div>
  )
}

function Slider({ value, min, max, step, onChange, format, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string; label: string }) {
  return (
    <div className="slider">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ ['--p' as string]: `${((value - min) / (max - min)) * 100}%` }} />
      <span className="num">{format(value)}</span>
    </div>
  )
}

/* ---------- sections ---------- */
function General() {
  const { s, set } = useSettings()
  return (
    <>
      <Group title="You">
        <Row label="Your name" hint="Used in the greeting on Today. Leave empty to use your account name.">
          <input className="set-input" value={s.name} placeholder="Name" onChange={(e) => set({ name: e.target.value })} aria-label="Your name" />
        </Row>
        <Row label="Greeting" hint="“Good morning, Sam” at the top of Today.">
          <Toggle label="Greeting" on={s.greeting} onChange={(greeting) => set({ greeting })} />
        </Row>
      </Group>
      <Group title="Starting up">
        <Row label="Open on" hint="The screen you see when Veyra Study starts.">
          <Select
            label="Open on"
            value={s.startScreen}
            onChange={(startScreen) => set({ startScreen })}
            options={[['last', 'Where I left off'], ...(Object.entries(NAV_LABELS) as [NavId, string][])]}
          />
        </Row>
      </Group>
      <Group title="Dates and times">
        <Row label="Week starts on" keywords="monday sunday saturday calendar">
          <Choice label="Week starts on" value={s.weekStart} onChange={(weekStart) => set({ weekStart })} options={[[1, 'Monday'], [0, 'Sunday'], [6, 'Saturday']]} />
        </Row>
        <Row label="Time format" keywords="12 24 hour clock">
          <Choice label="Time format" value={s.timeFormat} onChange={(timeFormat) => set({ timeFormat })} options={[['12h', '1:30 PM'], ['24h', '13:30']]} />
        </Row>
      </Group>
    </>
  )
}

function Appearance() {
  const { s, set } = useSettings()
  const q = useContext(QueryCtx)
  const custom = !ACCENTS[s.accent]
  return (
    <>
      <Group>
        <Row label="Theme" stack keywords="dark light mode night system">
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={`theme-card t-${t}`} role="radio" aria-checked={s.theme === t} onClick={() => set({ theme: t })}>
              <span className="tc-art" aria-hidden="true">
                <i />
                <b />
              </span>
              <span>{t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}</span>
            </button>
          ))}
        </div>
        </Row>
      </Group>
      <Group footer="Used for buttons, highlights and the selected screen.">
        <Row label="Accent colour" stack keywords="color tint highlight custom">
        <div className="accent-row" role="radiogroup" aria-label="Accent colour">
          {Object.entries(ACCENTS).map(([k, a]) => (
            <button key={k} className="accent-swatch" role="radio" aria-checked={s.accent === k} title={a.name} aria-label={a.name} style={{ background: a.light }} onClick={() => set({ accent: k })}>
              {s.accent === k && <Check size={14} strokeWidth={3} />}
            </button>
          ))}
          <label className={`accent-swatch custom ${custom ? 'on' : ''}`} title="Custom colour" style={custom ? { background: s.accent } : undefined}>
            <input type="color" aria-label="Custom accent colour" value={custom ? s.accent : '#b3492b'} onChange={(e) => set({ accent: e.target.value })} />
            {custom ? <Check size={14} strokeWidth={3} /> : '+'}
          </label>
        </div>
        </Row>
      </Group>
      <Group title="Text and layout">
        <Row label="Font" keywords="typeface">
          <Choice label="Font" value={s.font} onChange={(font) => set({ font })} options={[['system', 'System'], ['inter', 'Inter'], ['serif', 'Serif']]} />
        </Row>
        <Row label="Interface size" hint="Makes everything larger or smaller." keywords="zoom scale text size bigger">
          <Slider label="Interface size" value={s.zoom} min={0.8} max={1.4} step={0.05} onChange={(zoom) => set({ zoom })} format={(v) => `${Math.round(v * 100)}%`} />
        </Row>
        <Row label="Density" hint="How much room there is around rows and cards." keywords="compact spacing padding">
          <Choice label="Density" value={s.density} onChange={(density) => set({ density })} options={[['compact', 'Compact'], ['comfortable', 'Default'], ['spacious', 'Spacious']]} />
        </Row>
        <Row label="Corners" keywords="rounded radius square">
          <Choice label="Corners" value={s.corners} onChange={(corners) => set({ corners })} options={[['square', 'Square'], ['soft', 'Soft'], ['round', 'Round']]} />
        </Row>
        <Row label="Reduce motion" hint="Turns off sliding and springy animations." keywords="animation accessibility">
          <Toggle label="Reduce motion" on={s.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
        </Row>
      </Group>
      {!q && <Group title="Preview">
        <div className="appearance-preview">
          <div className="card" style={{ padding: 14 }}>
            <div className="between">
              <b>Biology</b>
              <span className="pill accent">Today</span>
            </div>
            <div className="bar" style={{ margin: '10px 0' }}>
              <span style={{ width: '62%', background: 'var(--accent)' }} />
            </div>
            <div className="row">
              <button className="btn sm">Start focus</button>
              <button className="btn sec sm">Later</button>
            </div>
          </div>
        </div>
      </Group>}
    </>
  )
}

function Sidebar() {
  const { s, set } = useSettings()
  const move = (i: number, d: -1 | 1) => {
    const nav = [...s.nav]
    const j = i + d
    if (j < 0 || j >= nav.length) return
    ;[nav[i], nav[j]] = [nav[j], nav[i]]
    set({ nav })
  }
  const visible = s.nav.filter((n) => n.visible).length
  return (
    <>
      <Group title="Screens" footer="Hiding a screen keeps its data. Show it again here any time.">
        {s.nav.map((n, i) => (
          <Row key={n.id} label={NAV_LABELS[n.id]} keywords="order hide show menu navigation">
            <div className="row" style={{ gap: 4 }}>
              <button className="iconbtn plain" aria-label={`Move ${NAV_LABELS[n.id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={15} />
              </button>
              <button className="iconbtn plain" aria-label={`Move ${NAV_LABELS[n.id]} down`} disabled={i === s.nav.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={15} />
              </button>
              <button
                className={`iconbtn plain ${n.visible ? '' : 'off'}`}
                aria-label={n.visible ? `Hide ${NAV_LABELS[n.id]}` : `Show ${NAV_LABELS[n.id]}`}
                aria-pressed={n.visible}
                disabled={n.visible && visible === 1}
                onClick={() => set({ nav: s.nav.map((x) => (x.id === n.id ? { ...x, visible: !x.visible } : x)) })}
              >
                {n.visible ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            </div>
          </Row>
        ))}
      </Group>
      <Group title="Extras">
        <Row label="Counts next to screens" hint="Open tasks, and how many are late.">
          <Toggle label="Counts" on={s.showCounts} onChange={(showCounts) => set({ showCounts })} />
        </Row>
        <Row label="Subjects list" hint="Your subjects under the screens.">
          <Toggle label="Subjects list" on={s.showSubjectsInSidebar} onChange={(showSubjectsInSidebar) => set({ showSubjectsInSidebar })} />
        </Row>
        <Row label="Running timer card" hint="Shows the focus timer while it runs." keywords="pomodoro">
          <Toggle label="Running timer card" on={s.showTimerCard} onChange={(showTimerCard) => set({ showTimerCard })} />
        </Row>
      </Group>
    </>
  )
}

function Today() {
  const { s, set } = useSettings()
  const t = (key: keyof AppSettings, label: string, hint: string) => (
    <Row label={label} hint={hint} keywords="today dashboard home">
      <Toggle label={label} on={s[key] as boolean} onChange={(v) => set({ [key]: v } as Partial<AppSettings>)} />
    </Row>
  )
  return (
    <Group title="Show on Today">
      {t('todayStats', 'Summary cards', 'Studied today, done today and overdue.')}
      {t('todayDue', 'Due today', 'Tasks due today, overdue ones, and what you finished today.')}
      {t('todayUpcoming', 'Coming up', 'The next tasks with a due date.')}
      {s.todayUpcoming && (
        <Row label="How many coming up" keywords="upcoming number">
          <Stepper label="tasks coming up" value={s.upcomingCount} min={1} max={20} onChange={(upcomingCount) => set({ upcomingCount })} />
        </Row>
      )}
      {t('todaySchedule', 'Today’s schedule', 'Events from your connected calendars.')}
      {t('todayFocus', 'Focus timer', 'The timer, with your daily goal.')}
      {t('todaySubjects', 'Subjects', 'Progress for each subject.')}
    </Group>
  )
}

function Tasks() {
  const { s, set } = useSettings()
  return (
    <>
      <Group title="New tasks">
        <Row label="Priority" keywords="default">
          <Choice label="Default priority" value={s.defaultPriority} onChange={(defaultPriority) => set({ defaultPriority })} options={[['low', 'Low'], ['normal', 'Normal'], ['high', 'High']]} />
        </Row>
        <Row label="Due date" hint="What a new task’s due date starts as." keywords="default deadline">
          <Select label="Default due date" value={s.defaultDue} onChange={(defaultDue) => set({ defaultDue })} options={[['none', 'No due date'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'In a week']]} />
        </Row>
      </Group>
      <Group title="Lists">
        <Row label="Sort by" keywords="order">
          <Select label="Sort tasks by" value={s.taskSort} onChange={(taskSort) => set({ taskSort })} options={[['due', 'Due date'], ['priority', 'Priority'], ['created', 'Newest first'], ['title', 'Name']]} />
        </Row>
        <Row label="Show finished tasks" hint="In subject lists and on the Tasks screen’s “All” filter." keywords="completed done">
          <Toggle label="Show finished tasks" on={s.showDoneInLists} onChange={(showDoneInLists) => set({ showDoneInLists })} />
        </Row>
        <Row label="Highlight overdue tasks" hint="Late tasks get a red label." keywords="late">
          <Toggle label="Highlight overdue" on={s.highlightOverdue} onChange={(highlightOverdue) => set({ highlightOverdue })} />
        </Row>
      </Group>
    </>
  )
}

function Notes() {
  const { s, set } = useSettings()
  return (
    <>
      <Group title="New notes" footer="You can still change any note’s layout, font and cover from its … menu.">
        <Row label="Layout" keywords="template cornell lined grid page">
          <Select label="Default layout" value={s.noteTemplate} onChange={(noteTemplate) => set({ noteTemplate })} options={[['page', 'Page'], ['cornell', 'Cornell'], ['lined', 'Lined'], ['grid', 'Grid']]} />
        </Row>
        <Row label="Font" keywords="typeface serif mono">
          <Choice label="Default note font" value={s.noteFont} onChange={(noteFont) => set({ noteFont })} options={[['sans', 'Default'], ['serif', 'Serif'], ['mono', 'Mono']]} />
        </Row>
        <Row label="Cover" stack keywords="banner colour">
          <div className="cover-row">
            <button className="cover-chip none" aria-pressed={s.noteCover === 'none'} onClick={() => set({ noteCover: 'none' })} title="No cover">
              ⌀
            </button>
            <button className="cover-chip none" aria-pressed={s.noteCover === 'random'} onClick={() => set({ noteCover: 'random' })} title="A different one each time">
              ?
            </button>
            {Object.entries(NOTE_COVERS).map(([k, bg]) => (
              <button key={k} className="cover-chip" aria-pressed={s.noteCover === k} aria-label={`${k} cover`} style={{ background: bg }} onClick={() => set({ noteCover: k })} />
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Pages">
        <Row label="Page width" keywords="column wide narrow">
          <Choice label="Page width" value={s.noteWidth} onChange={(noteWidth) => set({ noteWidth })} options={[['narrow', 'Narrow'], ['normal', 'Default'], ['wide', 'Wide']]} />
        </Row>
        <Row label="Text size" keywords="font size bigger">
          <Stepper label="note text size" value={s.noteSize} min={13} max={22} unit="px" onChange={(noteSize) => set({ noteSize })} />
        </Row>
        <Row label="Spell check" keywords="spelling">
          <Toggle label="Spell check" on={s.spellcheck} onChange={(spellcheck) => set({ spellcheck })} />
        </Row>
        <Row label="Word count and reading time" keywords="words">
          <Toggle label="Word count" on={s.showWordCount} onChange={(showWordCount) => set({ showWordCount })} />
        </Row>
      </Group>
    </>
  )
}

function FocusTimer() {
  const { s, set } = useSettings()
  return (
    <>
      <Group title="Lengths" footer="Changes apply from the next block.">
        <Row label="Focus" keywords="pomodoro work session">
          <Stepper label="focus minutes" value={s.focusMin} min={5} max={180} step={5} unit="min" onChange={(focusMin) => set({ focusMin })} />
        </Row>
        <Row label="Short break">
          <Stepper label="short break minutes" value={s.breakMin} min={1} max={60} unit="min" onChange={(breakMin) => set({ breakMin })} />
        </Row>
        <Row label="Long break">
          <Stepper label="long break minutes" value={s.longBreakMin} min={1} max={90} unit="min" onChange={(longBreakMin) => set({ longBreakMin })} />
        </Row>
        <Row label="Long break after" hint="Focus blocks before a long break. Set to 0 for no long breaks.">
          <Stepper label="blocks before a long break" value={s.longBreakEvery} min={0} max={12} unit="blocks" onChange={(longBreakEvery) => set({ longBreakEvery })} />
        </Row>
      </Group>
      <Group title="Flow">
        <Row label="Start breaks automatically" keywords="auto">
          <Toggle label="Start breaks automatically" on={s.autoStartBreaks} onChange={(autoStartBreaks) => set({ autoStartBreaks })} />
        </Row>
        <Row label="Start the next focus block automatically" keywords="auto">
          <Toggle label="Start focus automatically" on={s.autoStartFocus} onChange={(autoStartFocus) => set({ autoStartFocus })} />
        </Row>
        <Row label="Daily goal" hint="Shown as a ring on Today. 0 turns it off." keywords="target minutes">
          <Stepper label="daily goal minutes" value={s.dailyGoalMin} min={0} max={720} step={15} unit="min" onChange={(dailyGoalMin) => set({ dailyGoalMin })} />
        </Row>
      </Group>
      <Group title="Alerts">
        <Row label="Sound" keywords="chime bell alarm">
          <div className="row" style={{ gap: 8 }}>
            <Select label="Sound" value={s.sound} onChange={(sound) => set({ sound })} options={[['chime', 'Chime'], ['bell', 'Bell'], ['soft', 'Soft'], ['none', 'None']]} />
            <button className="iconbtn" aria-label="Play sound" disabled={s.sound === 'none'} onClick={() => playSound(s.sound, s.volume)}>
              <Play size={14} />
            </button>
          </div>
        </Row>
        {s.sound !== 'none' && (
          <Row label="Volume">
            <Slider label="Volume" value={s.volume} min={0.1} max={1} step={0.1} onChange={(volume) => set({ volume })} format={(v) => `${Math.round(v * 100)}%`} />
          </Row>
        )}
        <Row label="Notifications" hint="A Windows notification when a block ends." keywords="alert popup">
          <Toggle label="Notifications" on={s.notify} onChange={(notify) => set({ notify })} />
        </Row>
      </Group>
    </>
  )
}

function Calendar({ go }: { go: (id: SectionId) => void }) {
  const { s, set } = useSettings()
  return (
    <Group title="Show on the calendar">
      <Row label="Tasks with due dates">
        <Toggle label="Tasks" on={s.calendarShowTasks} onChange={(calendarShowTasks) => set({ calendarShowTasks })} />
      </Row>
      <Row label="Finished tasks" keywords="done completed">
        <Toggle label="Finished tasks" on={s.calendarShowDone} onChange={(calendarShowDone) => set({ calendarShowDone })} />
      </Row>
      <Row label="Events from connected calendars" hint="Google Calendar and calendar links." keywords="google ical events">
        <div className="row" style={{ gap: 10 }}>
          <button className="linkbtn sm" onClick={() => go('connections')}>
            Manage
          </button>
          <Toggle label="Events" on={s.calendarShowEvents} onChange={(calendarShowEvents) => set({ calendarShowEvents })} />
        </div>
      </Row>
    </Group>
  )
}

function DataPrivacy() {
  const { reset } = useSettings()
  const toast = useToast()
  const [version, setVersion] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    window.veyra.app.version().then(setVersion)
  }, [])
  return (
    <>
      <Group title="Your data" footer="Your study data is stored on this computer, in a separate file for each Veyra account.">
        <Row label="Export everything" hint="Subjects, tasks, notes, study time and settings, as a JSON file." keywords="backup download">
          <button
            className="btn sec sm"
            onClick={async () => {
              const r = await window.veyra.app.exportData()
              if (r.saved) toast(`Exported ${r.count} items`)
            }}
          >
            Export…
          </button>
        </Row>
        <Row label="Open the data folder" keywords="files location">
          <button className="btn sec sm" onClick={() => window.veyra.app.openDataFolder()}>
            Open
          </button>
        </Row>
      </Group>
      <Group title="Reset">
        <Row label="Reset all settings" hint="Puts every option back to how it started. Your tasks, notes and study time stay." keywords="defaults">
          {confirm ? (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn ghost sm" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="btn dan sm"
                onClick={() => {
                  reset()
                  setConfirm(false)
                  toast('Settings reset')
                }}
              >
                Reset
              </button>
            </div>
          ) : (
            <button className="btn ghost sm" onClick={() => setConfirm(true)}>
              Reset…
            </button>
          )}
        </Row>
      </Group>
      <p className="set-footer" style={{ textAlign: 'center' }}>Veyra Study {version}</p>
    </>
  )
}

function SectionBody({ id, go }: { id: SectionId; go: (id: SectionId) => void }) {
  switch (id) {
    case 'general':
      return <General />
    case 'appearance':
      return <Appearance />
    case 'sidebar':
      return <Sidebar />
    case 'today':
      return <Today />
    case 'tasks':
      return <Tasks />
    case 'notes':
      return <Notes />
    case 'timer':
      return <FocusTimer />
    case 'calendar':
      return <Calendar go={go} />
    case 'account':
      return <AccountSection />
    case 'connections':
      return <GoogleSection />
    case 'data':
      return <DataPrivacy />
  }
}

/** Sections that search covers (account and connections are cards, not rows). */
const SEARCHABLE: SectionId[] = ['general', 'appearance', 'sidebar', 'today', 'tasks', 'notes', 'timer', 'calendar', 'data']

export function Settings({ initial }: { initial?: string }) {
  const { reset, s } = useSettings()
  const [section, setSection] = useState<SectionId>(() => {
    const want = (initial ?? sessionStorage.getItem('veyra.settingsSection')) as SectionId | null
    return want && SECTIONS.some((x) => x.id === want) ? want : 'general'
  })
  const [q, setQ] = useState('')
  useEffect(() => {
    sessionStorage.setItem('veyra.settingsSection', section)
  }, [section])

  const current = SECTIONS.find((x) => x.id === section)!
  const changed = (current.keys ?? []).some((k) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]))
  const go = (id: SectionId) => {
    setQ('')
    setSection(id)
  }

  return (
    <div className="settings view">
      <aside className="set-nav" aria-label="Settings sections">
        <h1>Settings</h1>
        <div className="set-search">
          <Search size={15} aria-hidden="true" />
          <input placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
          {q && (
            <button aria-label="Clear search" onClick={() => setQ('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <nav>
          {SECTIONS.map((x, i) => (
            <div key={x.id}>
              {(i === 8 || i === 10) && <div className="set-nav-sep" />}
              <button className="set-nav-item" aria-current={!q && section === x.id} onClick={() => go(x.id)}>
                <span className="set-nav-icon">
                  <x.icon size={15} />
                </span>
                {x.label}
              </button>
            </div>
          ))}
        </nav>
      </aside>

      <main className="set-main">
        {q ? (
          <QueryCtx.Provider value={q.trim()}>
            <div className="set-head">
              <h2 className="set-title">Results for “{q}”</h2>
            </div>
            {SEARCHABLE.map((id) => {
              const x = SECTIONS.find((y) => y.id === id)!
              return (
                <section key={id} className="set-result" data-section={id}>
                  <button className="set-result-head" onClick={() => go(id)}>
                    <x.icon size={14} /> {x.label} <span className="tert">→</span>
                  </button>
                  <SectionBody id={id} go={go} />
                </section>
              )
            })}
            <p className="set-none">No settings match. Try another word.</p>
          </QueryCtx.Provider>
        ) : (
          <div key={section} className="set-page">
            <div className="set-head">
              <div>
                <h2 className="set-title">{current.label}</h2>
                <p className="set-sub">{current.hint}</p>
              </div>
              {current.keys && changed && (
                <button className="btn ghost sm" onClick={() => reset(current.keys)} title={`Reset ${current.label} to defaults`}>
                  <RotateCcw size={13} /> Reset
                </button>
              )}
            </div>
            <SectionBody id={section} go={go} />
          </div>
        )}
      </main>
    </div>
  )
}

