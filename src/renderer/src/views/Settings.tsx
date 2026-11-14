import { MicSetting } from '../components/notes/Voice'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, CalendarDays, Smartphone, Minus as MinusIcon, Plus as PlusIcon, Check, ChevronLeft, Download, ExternalLink, RefreshCw, Database, Eye, EyeOff, Home, LayoutPanelLeft, ListTodo, NotebookPen,
  LayoutGrid, Palette, Play, Plus, RotateCcw, Shapes, ShieldCheck, Sparkles, Trash2, Search, SlidersHorizontal, Timer, UserRound, Link2, X, type LucideIcon
} from 'lucide-react'
import { OwnerSection, useIsOwner } from './Owner'
import { useAccount } from '../components/account'
import { ACCENTS, DEFAULT_SETTINGS, NAV_LABELS, defaultLayout, type AppSettings, type NavId } from '@shared/settings'
import { useNav } from '../nav'
import { useSettings } from '../data/settings'
import { playSound } from '../components/timer'
import { Bar, useToast } from '../components/ui'
import { VeyraMark } from '../components/account'
import { formatDistanceToNowStrict } from 'date-fns'
import { onAndroid, onWeb, usePhone } from '../lib/phone'
import { transition } from '../lib/motion'
import { NOTE_COVERS } from '../components/notes/NoteEditor'
import { AccountSection, AiAppsSection, DriveSection, GoogleSection } from './Connections'
import { LocalAiSetup } from '../components/LocalAiSetup'
import { db, useRecords } from '../data/store'
import { sortSubjects } from '../lib/subjects'
import { SubjectDialog } from '../components/editors'
import { FolderNameDialog, FolderPickDialog } from '../components/FolderDialogs'
import { childrenOf, deleteFolder, folderPath, folderTree, moveFolder as putFolderIn, newFolder, parentOf, renameFolder, useFolders, withDescendants } from '../lib/folders'
import type { AiProvider, AiState, Rec, UpdateState } from '@shared/types'
import { Select as Dropdown } from '../components/Select'
import { TimeField } from '../components/DateTime'
import { IS_DEV } from '@shared/channel'
import { BetaNote } from '../components/BetaNotice'

/* =====================================================================
   Settings: categories on the left, one category at a time on the
   right, and a search that finds any option across all of them.
===================================================================== */

type SectionId = 'general' | 'appearance' | 'sidebar' | 'subjects' | 'ai' | 'today' | 'tasks' | 'notes' | 'timer' | 'calendar' | 'account' | 'connections' | 'data' | 'updates' | 'phone' | 'owner'

export const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; hint: string; keys?: (keyof AppSettings)[] }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, hint: 'Your name, start screen, week and time', keys: ['name', 'greeting', 'startScreen', 'weekStart', 'timeFormat'] },
  { id: 'appearance', label: 'Appearance', icon: Palette, hint: 'Theme, colour, font, size and spacing', keys: ['theme', 'accent', 'font', 'zoom', 'density', 'corners', 'reduceMotion', 'material'] },
  { id: 'phone', label: 'Phone', icon: Smartphone, hint: 'The navigation bar, large titles, pure black, vibration and more', keys: ['phoneTabs', 'phoneTabLabels', 'phoneCompose', 'phoneDock', 'phoneHideNavTyping', 'phoneTimerPill', 'phoneLargeTitles', 'pureBlack', 'haptics', 'keepAwakeFocus', 'phoneNoteBar'] },
  { id: 'sidebar', label: 'Sidebar', icon: LayoutPanelLeft, hint: 'What the sidebar shows, and in what order', keys: ['nav', 'showCounts', 'showSubjectsInSidebar', 'showTimerCard'] },
  { id: 'subjects', label: 'Subjects', icon: Shapes, hint: 'Order, colours, archived and deleted subjects' },
  { id: 'today', label: 'Today', icon: Home, hint: 'Your Today page’s widgets', keys: ['todayLayout', 'upcomingCount'] },
  { id: 'tasks', label: 'Tasks', icon: ListTodo, hint: 'Defaults for new tasks, how lists sort, and reminders', keys: ['defaultPriority', 'defaultDue', 'taskSort', 'showDoneInLists', 'highlightOverdue', 'remindersOn', 'remindMorning', 'morningTime', 'remindEvening', 'eveningTime', 'keepInTray', 'startWithWindows'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, hint: 'How new notes start, how pages look, and voice recordings', keys: ['voiceAutoTranscribe', 'voiceMic', 'voiceUseSubtitleMaker', 'voiceModel', 'voiceLanguage', 'noteTemplate', 'noteFont', 'noteCover', 'noteWidth', 'noteSize', 'spellcheck', 'showWordCount', 'noteToolbar', 'noteBubble', 'noteSort'] },
  { id: 'timer', label: 'Focus timer', icon: Timer, hint: 'Lengths, long breaks, sounds and your daily goal', keys: ['focusMin', 'breakMin', 'longBreakMin', 'longBreakEvery', 'autoStartBreaks', 'autoStartFocus', 'sound', 'volume', 'notify', 'dailyGoalMin'] },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, hint: 'What appears on the calendar', keys: ['calendarShowTasks', 'calendarShowDone', 'calendarShowEvents'] },
  { id: 'ai', label: 'AI', icon: Sparkles, hint: 'Local AI or your own Claude, Gemini or OpenAI key' },
  { id: 'account', label: 'Account', icon: UserRound, hint: 'Your Veyra account' },
  { id: 'connections', label: 'Connections', icon: Link2, hint: 'Google Calendar, Google Drive, calendar links and AI apps' },
  { id: 'data', label: 'Data & privacy', icon: Database, hint: 'Export, where data lives, and resets' },
  { id: 'updates', label: 'Software update', icon: Download, hint: 'Your version, updates, and what’s new', keys: ['checkUpdatesAtStart'] },
  // Only shown to the owner of Veyra Study (the group server says who that is).
  { id: 'owner', label: 'Owner', icon: ShieldCheck, hint: 'Who uses Group work and sync, every group, and moderation' }
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
    <Dropdown
      className="set-sel"
      label={label}
      value={String(value)}
      onChange={(v) => onChange(options.find(([o]) => String(o) === v)![0])}
      options={options.map(([v, l]) => ({ value: String(v), label: l }))}
    />
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
        {window.veyra.app.materialSupported && (
          <Row label="Window background" hint="See-through glass behind the app, like Windows 11’s own apps. Acrylic blurs whatever is behind the window; Mica tints it with your wallpaper." keywords="acrylic mica transparent glass blur translucent see-through">
            <Choice label="Window background" value={s.material} onChange={(material) => set({ material })} options={[['solid', 'Solid'], ['acrylic', 'Acrylic'], ['mica', 'Mica']]} />
          </Row>
        )}
        {window.veyra.app.titleBar ? <WindowButtonsRow /> : null}
      </Group>
      <Group footer="Used for buttons, highlights and the selected screen.">
        <Row label="Accent colour" stack keywords="color tint highlight custom">
        <div className="accent-row" role="radiogroup" aria-label="Accent colour">
          {Object.entries(ACCENTS).map(([k, a]) => (
            <button key={k} className="accent-swatch" role="radio" aria-checked={s.accent === k} title={a.name} aria-label={a.name} style={{ background: document.documentElement.classList.contains('dark') ? a.dark : a.light }} onClick={() => set({ accent: k })}>
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

/* ---------- Phone (the Android app) ---------- */
const SCREEN_LABELS: Record<NavId, string> = { today: 'Today', tasks: 'Tasks', notes: 'Notes', calendar: 'Calendar', groups: 'Group work', timer: 'Focus timer', stats: 'Stats' }
function PhoneSection() {
  const { s, set } = useSettings()
  const tabs = s.phoneTabs
  const rest = (Object.keys(SCREEN_LABELS) as NavId[]).filter((id) => !tabs.includes(id))
  const move = (i: number, d: -1 | 1) => {
    const next = [...tabs]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ phoneTabs: next })
  }
  return (
    <>
      <Group title="Navigation bar" footer="Up to four screens sit in the bar; everything else is under More.">
        {tabs.map((id, i) => (
          <Row key={id} label={SCREEN_LABELS[id]} keywords="tabs bar navigation dock order screens">
            <div className="row" style={{ gap: 4 }}>
              <button className="iconbtn plain" aria-label={`Move ${SCREEN_LABELS[id]} left`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={15} />
              </button>
              <button className="iconbtn plain" aria-label={`Move ${SCREEN_LABELS[id]} right`} disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={15} />
              </button>
              <button className="iconbtn plain" aria-label={`Move ${SCREEN_LABELS[id]} to More`} disabled={tabs.length <= 2} onClick={() => set({ phoneTabs: tabs.filter((x) => x !== id) })}>
                <MinusIcon size={15} />
              </button>
            </div>
          </Row>
        ))}
        {rest.map((id) => (
          <Row key={id} label={SCREEN_LABELS[id]} hint="Under More" keywords="tabs bar navigation dock screens">
            <button className="btn ghost sm" disabled={tabs.length >= 4} onClick={() => set({ phoneTabs: [...tabs, id] })}>
              <PlusIcon size={14} /> Add to bar
            </button>
          </Row>
        ))}
      </Group>

      <Group title="Bar and button">
        <Row label="Bar style" stack keywords="dock floating docked bottom one ui">
          <Choice label="Bar style" value={s.phoneDock} onChange={(phoneDock) => set({ phoneDock })} options={[['floating', 'Floating'], ['docked', 'Docked']]} />
        </Row>
        <Row label="Names under icons" stack keywords="labels text tabs">
          <Choice label="Names under icons" value={s.phoneTabLabels} onChange={(phoneTabLabels) => set({ phoneTabLabels })} options={[['always', 'Always'], ['selected', 'Current only'], ['never', 'Never']]} />
        </Row>
        <Row label="Round button" hint="Beside the bar. Auto makes a note on Notes and a task everywhere else." stack keywords="compose new fab plus button">
          <Choice label="Round button" value={s.phoneCompose} onChange={(phoneCompose) => set({ phoneCompose })} options={[['smart', 'Auto'], ['task', 'Task'], ['note', 'Note'], ['off', 'Off']]} />
        </Row>
        <Row label="Hide the bar while typing" hint="So what you're writing sits right above the keyboard." keywords="keyboard">
          <Toggle label="Hide the bar while typing" on={s.phoneHideNavTyping} onChange={(phoneHideNavTyping) => set({ phoneHideNavTyping })} />
        </Row>
        <Row label="Running timer above the bar" hint="A small pill with the time left, on every screen." keywords="focus pomodoro">
          <Toggle label="Running timer above the bar" on={s.phoneTimerPill} onChange={(phoneTimerPill) => set({ phoneTimerPill })} />
        </Row>
      </Group>

      <Group title="Look">
        <Row label="Large titles" hint="Bigger page titles with room above them, so the top of the screen is easier to reach one-handed." keywords="one ui header reach one handed">
          <Toggle label="Large titles" on={s.phoneLargeTitles} onChange={(phoneLargeTitles) => set({ phoneLargeTitles })} />
        </Row>
        <Row label="Pure black in dark mode" hint="True black backgrounds. Saves battery on OLED screens." keywords="amoled oled black dark battery">
          <Toggle label="Pure black in dark mode" on={s.pureBlack} onChange={(pureBlack) => set({ pureBlack })} />
        </Row>
      </Group>

      <Group title="Feel">
        <Row label="Vibration on taps" hint="A light tap when you tick a task, switch screens or press a button." keywords="haptic haptics vibrate feedback">
          <Toggle label="Vibration on taps" on={s.haptics} onChange={(haptics) => set({ haptics })} />
        </Row>
        <Row label="Keep the screen on while focusing" hint="While a focus block runs and Veyra is open." keywords="wake awake screen timeout pomodoro">
          <Toggle label="Keep the screen on while focusing" on={s.keepAwakeFocus} onChange={(keepAwakeFocus) => set({ keepAwakeFocus })} />
        </Row>
      </Group>

      <Group title="Notes">
        <Row label="Formatting bar" stack keywords="toolbar note editor top bottom">
          <Choice label="Formatting bar" value={s.phoneNoteBar} onChange={(phoneNoteBar) => set({ phoneNoteBar })} options={[['bottom', 'At the bottom'], ['top', 'At the top']]} />
        </Row>
      </Group>
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
      <Group title="Style" footer="Hidden works like Zen browser: point at the left edge of the window and the sidebar slides out. Ctrl+\ switches between the three.">
        <Row label="Sidebar" hint="Full, just its icons, or hidden until you point at the left edge." keywords="collapse minimise minimize compact zen hide icons rail">
          <Choice
            label="Sidebar"
            value={s.sidebarMode}
            onChange={(sidebarMode) => set({ sidebarMode })}
            options={[
              ['full', 'Full'],
              ['icons', 'Icons only'],
              ['hidden', 'Hidden']
            ]}
          />
        </Row>
      </Group>
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
  const { go } = useNav()
  const q = useContext(QueryCtx)
  return (
    <>
      <Group title="Widgets" footer="On Today, choose Customize to drag widgets around, change their size, remove them or add new ones.">
        <Row label="Arrange Today" hint={`${s.todayLayout.length} widget${s.todayLayout.length === 1 ? '' : 's'} on your page.`} keywords="widgets dashboard layout customize edit home">
          <button className="btn sm" onClick={() => go({ name: 'today', edit: true })}>
            <LayoutGrid size={14} /> Customize Today
          </button>
        </Row>
        <Row label="Reset widgets" hint="Back to the original layout." keywords="widgets dashboard layout default">
          <button className="btn ghost sm" onClick={() => set({ todayLayout: defaultLayout() })}>
            Reset
          </button>
        </Row>
      </Group>
      {(!q || matches(q, 'coming up upcoming tasks how many')) && (
        <Group title="Widget options">
          <Row label="Tasks in “Coming up”" keywords="upcoming number how many">
            <Stepper label="tasks coming up" value={s.upcomingCount} min={1} max={20} onChange={(upcomingCount) => set({ upcomingCount })} />
          </Row>
        </Group>
      )}
    </>
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
        <Row label="Show finished tasks in subjects" hint="Whether a subject’s task list starts with finished tasks showing." keywords="completed done">
          <Toggle label="Show finished tasks" on={s.showDoneInLists} onChange={(showDoneInLists) => set({ showDoneInLists })} />
        </Row>
        <Row label="Highlight overdue tasks" hint="Late tasks get a red label." keywords="late">
          <Toggle label="Highlight overdue" on={s.highlightOverdue} onChange={(highlightOverdue) => set({ highlightOverdue })} />
        </Row>
      </Group>
      <Group title="Reminders">
        <Row label="Reminders" hint="Windows notifications for your tasks. Set a reminder on any task in its editor." keywords="notification alert remind">
          <Toggle label="Reminders" on={s.remindersOn} onChange={(remindersOn) => set({ remindersOn })} />
        </Row>
        {s.remindersOn && (
          <>
            <Row label="Morning summary" hint="What’s due today and anything overdue." keywords="daily digest morning">
              <div className="row" style={{ gap: 8 }}>
                <TimeField className="set-sel set-time" label="Morning summary time" value={s.morningTime} disabled={!s.remindMorning} onChange={(morningTime) => set({ morningTime })} />
                <Toggle label="Morning summary" on={s.remindMorning} onChange={(remindMorning) => set({ remindMorning })} />
              </div>
            </Row>
            <Row label="Evening heads-up" hint="What’s due tomorrow, so nothing sneaks up on you." keywords="tomorrow evening">
              <div className="row" style={{ gap: 8 }}>
                <TimeField className="set-sel set-time" label="Evening heads-up time" value={s.eveningTime} disabled={!s.remindEvening} onChange={(eveningTime) => set({ eveningTime })} />
                <Toggle label="Evening heads-up" on={s.remindEvening} onChange={(remindEvening) => set({ remindEvening })} />
              </div>
            </Row>
          </>
        )}
        {!onAndroid() && (
          <>
        <Row label="Keep running in the tray" hint="Closing the window leaves Veyra in the system tray, so reminders still come. Quit from the tray icon." keywords="background tray minimize close">
          <Toggle label="Keep running in the tray" on={s.keepInTray} onChange={(keepInTray) => set({ keepInTray })} />
        </Row>
        <Row label="Start with Windows" hint="Opens quietly in the tray when you sign in to Windows. (Works in the installed app.)" keywords="startup login boot launch">
          <Toggle label="Start with Windows" on={s.startWithWindows} onChange={(startWithWindows) => set({ startWithWindows })} />
        </Row>
          </>
        )}
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
      <Group title="Writing">
        <Row label="Formatting tools" hint="Type “/” for a menu of blocks, use a toolbar at the top of the page, or both." keywords="toolbar slash menu bar commands">
          <Choice label="Formatting tools" value={s.noteToolbar} onChange={(noteToolbar) => set({ noteToolbar })} options={[['slash', 'Type “/”'], ['bar', 'Toolbar'], ['both', 'Both']]} />
        </Row>
        <Row label="Format bar on selection" hint="Bold, italic, highlight and more, right above the text you select." keywords="bubble floating selection">
          <Toggle label="Format bar on selection" on={s.noteBubble} onChange={(noteBubble) => set({ noteBubble })} />
        </Row>
        <Row label="Sort notes by" keywords="order list">
          <Select label="Sort notes by" value={s.noteSort} onChange={(noteSort) => set({ noteSort })} options={[['edited', 'Last edited'], ['created', 'Newest'], ['title', 'A–Z']]} />
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
      {!onAndroid() && (
      <Group title="Voice recordings">
        <Row label="Transcribe recordings" hint="Turns a recording into text as soon as you stop, on this computer (nothing is uploaded). Or use Transcribe on any recording." keywords="voice audio whisper speech text dictation">
          <Toggle label="Transcribe recordings" on={s.voiceAutoTranscribe} onChange={(voiceAutoTranscribe) => set({ voiceAutoTranscribe })} />
        </Row>
        <Row label="Use Subtitle Maker when it’s installed" hint="Transcribes with Subtitle Maker on this computer: its quality level, graphics card settings and word fixes, and nothing more to download." keywords="subtitle maker faster whisper gpu">
          <Toggle label="Use Subtitle Maker" on={s.voiceUseSubtitleMaker} onChange={(voiceUseSubtitleMaker) => set({ voiceUseSubtitleMaker })} />
        </Row>
        <Row label="Microphone" hint="What recordings listen to. If a recording comes out silent, pick your computer’s own microphone here (some, like a phone-as-webcam app’s, only send sound while that app is running)." keywords="microphone mic input device camo silent">
          <MicSetting />
        </Row>
        <Row label="Transcription model" hint="Fast suits clear lectures. More accurate copes better with accents and noise, but takes longer." keywords="whisper model accuracy speed">
          <Choice label="Transcription model" value={s.voiceModel} onChange={(voiceModel) => set({ voiceModel })} options={[['base', 'Fast'], ['small', 'More accurate']]} />
        </Row>
        <Row label="Language" hint="What’s spoken in your recordings. Detect works for most; pick one if it guesses wrong." keywords="language english detect">
          <Dropdown
            className="set-sel"
            label="Recording language"
            value={s.voiceLanguage}
            onChange={(voiceLanguage) => set({ voiceLanguage })}
            options={[['auto', 'Detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi'], ['ar', 'Arabic'], ['ru', 'Russian'], ['tl', 'Filipino'], ['vi', 'Vietnamese'], ['id', 'Indonesian']].map(([v, l]) => ({ value: v, label: l }))}
          />
        </Row>
      </Group>
      )}
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
      <Row label="Events from connected calendars" hint={onAndroid() ? 'Google Calendar and calendar links are connected in the computer app.' : 'Google Calendar and calendar links.'} keywords="google ical events">
        <div className="row" style={{ gap: 10 }}>
          {!onAndroid() && (
            <button className="linkbtn sm" onClick={() => go('connections')}>
              Manage
            </button>
          )}
          <Toggle label="Events" on={s.calendarShowEvents} onChange={(calendarShowEvents) => set({ calendarShowEvents })} />
        </div>
      </Row>
    </Group>
  )
}

function Subjects() {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const { items: notes } = useRecords('note')
  const toast = useToast()
  const [editing, setEditing] = useState<Rec<'subject'> | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const active = sortSubjects(subjects.filter((x) => !x.data.archived))
  const archived = sortSubjects(subjects.filter((x) => x.data.archived))
  const folders = useFolders('subject')
  const [folderDialog, setFolderDialog] = useState<{ mode: 'new' } | { mode: 'rename'; folder: Rec<'folder'> } | null>(null)
  const [movingFolder, setMovingFolder] = useState<Rec<'folder'> | null>(null)
  const folderName = (x: Rec<'subject'>) => (x.data.folderId ? folderPath(folders, x.data.folderId).map((f) => f.data.name).join(' › ') || undefined : undefined)
  // Up and down among the folders next to it (in the same folder).
  const moveFolder = (f: Rec<'folder'>, d: -1 | 1) => {
    const next = childrenOf(folders, parentOf(folders, f))
    const i = next.indexOf(f)
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    next.forEach((x, n) => x.data.order !== n && db.put('folder', { ...x.data, order: n }, x.id))
  }
  const dropFolder = async (f: Rec<'folder'>) => {
    const undo = await deleteFolder(f)
    toast(`Deleted the folder ${f.data.name}. What was in it moved up a level.`, { label: 'Undo', run: () => void undo() })
  }

  const reorder = (list: Rec<'subject'>[], i: number, d: -1 | 1) => {
    const next = [...list]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    next.forEach((x, n) => x.data.order !== n && db.put('subject', { ...x.data, order: n }, x.id))
  }
  const counts = (id: string) => {
    const t = tasks.filter((x) => x.data.subjectId === id).length
    const n = notes.filter((x) => x.data.subjectId === id).length
    return `${t} task${t === 1 ? '' : 's'} · ${n} note${n === 1 ? '' : 's'}`
  }
  const remove = async (x: Rec<'subject'>) => {
    // The subject goes; its tasks and notes stay, without a subject.
    const ownTasks = tasks.filter((t) => t.data.subjectId === x.id)
    const ownNotes = notes.filter((n) => n.data.subjectId === x.id)
    for (const t of ownTasks) await db.put('task', { ...t.data, subjectId: null }, t.id)
    for (const n of ownNotes) await db.put('note', { ...n.data, subjectId: null }, n.id)
    await db.remove('subject', x.id)
    setConfirm(null)
    toast(`Deleted ${x.data.name}`, {
      label: 'Undo',
      run: async () => {
        await db.put('subject', x.data, x.id)
        for (const t of ownTasks) await db.put('task', t.data, t.id)
        for (const n of ownNotes) await db.put('note', n.data, n.id)
      }
    })
  }

  const row = (x: Rec<'subject'>, i: number, list: Rec<'subject'>[]) => (
    <Row key={x.id} label={x.data.name} hint={folderName(x) ? `${folderName(x)} · ${counts(x.id)}` : counts(x.id)} keywords="subject course class colour order archive delete folder">
      <div className="row" style={{ gap: 4 }}>
        <span style={{ width: 12, height: 12, borderRadius: 9, background: x.data.color, marginRight: 6 }} />
        {!x.data.archived && (
          <>
            <button className="iconbtn plain" aria-label={`Move ${x.data.name} up`} disabled={i === 0} onClick={() => reorder(list, i, -1)}>
              <ArrowUp size={15} />
            </button>
            <button className="iconbtn plain" aria-label={`Move ${x.data.name} down`} disabled={i === list.length - 1} onClick={() => reorder(list, i, 1)}>
              <ArrowDown size={15} />
            </button>
          </>
        )}
        <button className="btn ghost sm" onClick={() => setEditing(x)}>
          Edit
        </button>
        {x.data.archived ? (
          <button className="btn sec sm" onClick={() => db.put('subject', { ...x.data, archived: false }, x.id)}>
            Unarchive
          </button>
        ) : (
          <button className="btn ghost sm" onClick={() => db.put('subject', { ...x.data, archived: true }, x.id)}>
            Archive
          </button>
        )}
        {confirm === x.id ? (
          <button className="btn dan sm" onClick={() => remove(x)}>
            Delete?
          </button>
        ) : (
          <button className="iconbtn plain" aria-label={`Delete ${x.data.name}`} title="Delete subject" onClick={() => setConfirm(x.id)}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </Row>
  )

  return (
    <>
      <Group title="Your subjects" footer="The order here is the order in the sidebar. Deleting a subject keeps its tasks and notes, without a subject.">
        {active.map((x, i) => row(x, i, active))}
        {!active.length && (
          <Row label="No subjects yet" keywords="subject">
            <span />
          </Row>
        )}
        <Row label="Add a subject" keywords="new subject course">
          <button className="btn sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> New subject
          </button>
        </Row>
      </Group>
      <Group title="Folders" footer="Folders group subjects in the sidebar, can hold other folders, and fold away when you click them. Drag subjects and folders in the sidebar to sort them, or pick a subject's folder from its Edit. Deleting a folder moves what was in it up a level.">
        {folderTree(folders).map(({ folder: f, depth }) => {
          const siblings = childrenOf(folders, parentOf(folders, f))
          const i = siblings.indexOf(f)
          const inside = parentOf(folders, f) ? folderPath(folders, parentOf(folders, f)).map((x) => x.data.name).join(' › ') : null
          const n = active.filter((x) => x.data.folderId === f.id).length
          return (
          <Row key={f.id} label={`${'   '.repeat(depth)}${depth ? '└ ' : ''}${f.data.name}`} hint={`${inside ? `In ${inside} · ` : ''}${n} subject${n === 1 ? '' : 's'}`} keywords="folder group subjects sidebar nest">
            <div className="row" style={{ gap: 4 }}>
              <button className="iconbtn plain" aria-label={`Move ${f.data.name} up`} disabled={i === 0} onClick={() => moveFolder(f, -1)}>
                <ArrowUp size={15} />
              </button>
              <button className="iconbtn plain" aria-label={`Move ${f.data.name} down`} disabled={i === siblings.length - 1} onClick={() => moveFolder(f, 1)}>
                <ArrowDown size={15} />
              </button>
              <button className="btn ghost sm" onClick={() => setFolderDialog({ mode: 'rename', folder: f })}>
                Rename
              </button>
              <button className="btn ghost sm" onClick={() => setMovingFolder(f)}>
                Move
              </button>
              <button className="iconbtn plain" aria-label={`Delete ${f.data.name}`} title="Delete folder (keeps its subjects)" onClick={() => dropFolder(f)}>
                <Trash2 size={15} />
              </button>
            </div>
          </Row>
          )
        })}
        <Row label="Add a folder" keywords="new folder group">
          <button className="btn sm sec" onClick={() => setFolderDialog({ mode: 'new' })}>
            <Plus size={14} /> New folder
          </button>
        </Row>
      </Group>
      {folderDialog && (
        <FolderNameDialog
          title={folderDialog.mode === 'new' ? 'New folder' : 'Rename folder'}
          action={folderDialog.mode === 'new' ? 'Create' : 'Rename'}
          initial={folderDialog.mode === 'rename' ? folderDialog.folder.data.name : ''}
          onClose={() => setFolderDialog(null)}
          onSave={(name) => void (folderDialog.mode === 'new' ? newFolder('subject', name) : renameFolder(folderDialog.folder, name))}
        />
      )}
      {movingFolder && (
        <FolderPickDialog
          scope="subject"
          folders={folders}
          title={`Move ${movingFolder.data.name} to…`}
          noneLabel="Top level"
          current={parentOf(folders, movingFolder)}
          exclude={withDescendants(folders, movingFolder.id)}
          onPick={(id) => void putFolderIn(folders, movingFolder, id)}
          onClose={() => setMovingFolder(null)}
        />
      )}
      {archived.length > 0 && (
        <Group title="Archived" footer="Archived subjects are hidden from the sidebar and Today, with their tasks. Unarchive to bring them back.">
          {archived.map((x, i) => row(x, i, archived))}
        </Group>
      )}
      {editing && <SubjectDialog subject={editing} onClose={() => setEditing(null)} />}
      {adding && <SubjectDialog onClose={() => setAdding(false)} />}
    </>
  )
}

const AI_PROVIDERS: { id: AiProvider; name: string; hint: string; keyUrl?: string; keyHint?: string }[] = [
  { id: 'ollama', name: 'Local AI', hint: 'Free and private. Runs on this computer with Ollama, even offline.' },
  { id: 'anthropic', name: 'Claude', hint: 'Your own Anthropic API key. Billed per use by Anthropic.', keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…' },
  { id: 'gemini', name: 'Gemini', hint: 'Your own Google AI Studio key. Has a free tier.', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…' },
  { id: 'openai', name: 'OpenAI', hint: 'Your own OpenAI API key. Billed per use by OpenAI.', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…' }
]
/** Local models known to work well for study tasks, smallest first. */
const LOCAL_SUGGESTIONS: [string, string][] = [
  ['llama3.2:3b', 'Small and quick (about 2 GB). Good for flashcards and short summaries.'],
  ['gemma3:4b', 'Small, a little smarter (about 3 GB).'],
  ['qwen2.5:7b', 'Medium (about 5 GB). Better answers; slower without a big graphics card.']
]

function AiSettings() {
  const toast = useToast()
  const [st, setSt] = useState<AiState | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [modelErr, setModelErr] = useState('')
  const [key, setKey] = useState('')
  const [pullName, setPullName] = useState('')
  const [pulling, setPulling] = useState<{ model: string; status: string; progress: number | null } | null>(null)
  const [speeds, setSpeeds] = useState<Record<string, number>>({})
  const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

  useEffect(() => {
    window.veyra.ai.state().then(setSt)
    window.veyra.ai.localStatus().then((s) => setSpeeds(s.measured ?? {}))
    return window.veyra.ai.onPull((e) => setPulling(e))
  }, [])

  const provider = st?.provider ?? null
  const loadModels = async (p: AiProvider | null) => {
    setModels(null)
    setModelErr('')
    if (!p) return
    try {
      setModels(await window.veyra.ai.models(p))
    } catch (e) {
      setModelErr(clean(e))
      setModels([])
    }
  }
  useEffect(() => {
    if (st && provider && (provider === 'ollama' || st.hasKey[provider])) loadModels(provider)
  }, [provider, st?.hasKey.anthropic, st?.hasKey.gemini, st?.hasKey.openai]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!st) return null
  const def = AI_PROVIDERS.find((p) => p.id === provider)
  const chosenModel = provider ? st.models[provider] ?? (provider === 'anthropic' ? 'claude-opus-5-5' : '') : ''

  const pull = async (name: string) => {
    if (!name.trim()) return
    setPulling({ model: name, status: 'starting', progress: 0 })
    try {
      await window.veyra.ai.pull(name.trim())
      setSt(await window.veyra.ai.set({ model: { provider: 'ollama', model: name.trim() } }))
      toast(`${name} is ready`)
      await loadModels('ollama')
    } catch (e) {
      toast(clean(e))
    } finally {
      setPulling(null)
      setPullName('')
    }
  }

  const localReady = provider === 'ollama' && !modelErr && (models?.length ?? 0) > 0
  return (
    <>
      {(!provider || (provider === 'ollama' && !localReady)) && (
        <div className="ls-group">
          <LocalAiSetup
            onReady={async () => {
              setSt(await window.veyra.ai.state())
              loadModels('ollama')
            }}
          />
          <p className="set-footer">Or use your own Claude, Gemini or OpenAI key below.</p>
        </div>
      )}
      <Group title="Provider" footer="AI tools appear in notes (the AI menu, and Explain on selected text) and in Tasks → Plan from syllabus.">
        <Row label="Use AI from" stack keywords="ai provider ollama local claude gemini openai chatgpt model">
          <div className="ai-providers" role="radiogroup" aria-label="AI provider">
            {AI_PROVIDERS.map((p) => (
              <button key={p.id} className="ai-provider" role="radio" aria-checked={provider === p.id} onClick={async () => setSt(await window.veyra.ai.set({ provider: p.id }))}>
                <b>{p.name}</b>
                <span>{p.hint}</span>
              </button>
            ))}
            <button className="ai-provider off" role="radio" aria-checked={!provider} onClick={async () => setSt(await window.veyra.ai.set({ provider: null }))}>
              <b>Off</b>
              <span>No AI. Nothing is ever sent anywhere.</span>
            </button>
          </div>
        </Row>
      </Group>

      {provider === 'ollama' && localReady && (
        <Group title="Local AI" footer="Ollama runs models on your computer. Bigger models give better answers but need more memory and are slower.">
          <Row label="Ollama" hint={modelErr ? modelErr : models ? `Running · ${models.length} model${models.length === 1 ? '' : 's'} downloaded` : 'Checking…'} keywords="ollama install local">
            <div className="row" style={{ gap: 6 }}>
              {modelErr && (
                <button className="btn sm" onClick={() => window.veyra.open('https://ollama.com/download')}>
                  Get Ollama
                </button>
              )}
              <button className="btn ghost sm" onClick={() => loadModels('ollama')}>
                Check again
              </button>
            </div>
          </Row>
          {models && models.length > 0 && (
            <Row label="Model" hint={speeds[chosenModel] ? `${speeds[chosenModel]} tokens/s on this computer` : 'Speed shows after its first answer.'} keywords="model local speed tokens">
              <Dropdown
                className="set-sel"
                label="Local model"
                placeholder="Choose a model"
                value={chosenModel}
                onChange={async (model) => setSt(await window.veyra.ai.set({ model: { provider: 'ollama', model } }))}
                options={models.map((m) => ({ value: m, label: m }))}
              />
            </Row>
          )}
          {!modelErr && models && (
            <Row label="Download a model" stack keywords="pull download model">
              {pulling ? (
                <div>
                  <div className="sm" style={{ marginBottom: 6 }}>
                    {pulling.model}: {pulling.status}
                  </div>
                  <div className="bar">
                    <span style={{ width: `${Math.round((pulling.progress ?? 0) * 100)}%`, background: 'var(--accent)' }} />
                  </div>
                </div>
              ) : (
                <div className="stack">
                  {LOCAL_SUGGESTIONS.filter(([m]) => !models.includes(m)).map(([m, why]) => (
                    <div key={m} className="between">
                      <span>
                        <b className="sm">{m}</b>
                        <span className="set-hint" style={{ display: 'block' }}>{why}</span>
                      </span>
                      <button className="btn sec sm" onClick={() => pull(m)}>
                        Download
                      </button>
                    </div>
                  ))}
                  <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); pull(pullName) }}>
                    <input className="set-input" style={{ width: '100%' }} placeholder="Or type any model from ollama.com/library" value={pullName} onChange={(e) => setPullName(e.target.value)} />
                    <button className="btn sec sm" type="submit" disabled={!pullName.trim()}>
                      Download
                    </button>
                  </form>
                </div>
              )}
            </Row>
          )}
        </Group>
      )}

      {def && def.id !== 'ollama' && (
        <Group title={def.name} footer={`Your key is stored encrypted on this computer and is only sent to ${def.name === 'Claude' ? 'Anthropic' : def.name === 'Gemini' ? 'Google' : 'OpenAI'}.`}>
          <Row label="API key" hint={st.hasKey[def.id as Exclude<AiProvider, 'ollama'>] ? 'Saved. Paste a new one to replace it.' : 'Create one in your account, then paste it here.'} stack keywords="api key">
            <form
              className="row"
              style={{ gap: 6 }}
              onSubmit={async (e) => {
                e.preventDefault()
                setSt(await window.veyra.ai.set({ key: { provider: def.id as Exclude<AiProvider, 'ollama'>, key } }))
                setKey('')
                toast('Key saved')
              }}
            >
              <input className="set-input" style={{ width: '100%' }} type="password" placeholder={st.hasKey[def.id as Exclude<AiProvider, 'ollama'>] ? 'Saved' : def.keyHint} value={key} onChange={(e) => setKey(e.target.value)} aria-label={`${def.name} API key`} />
              <button className="btn sm" type="submit" disabled={!key.trim()}>
                Save
              </button>
              <button type="button" className="btn ghost sm" onClick={() => window.veyra.open(def.keyUrl!)}>
                Get a key
              </button>
            </form>
          </Row>
          {st.hasKey[def.id as Exclude<AiProvider, 'ollama'>] && (
            <Row label="Model" hint={modelErr || (def.id === 'anthropic' ? 'Claude Opus 5.5 is the default.' : undefined)} keywords="model">
              <Dropdown
                className="set-sel"
                label={`${def.name} model`}
                placeholder="Choose a model"
                value={chosenModel}
                onChange={async (model) => setSt(await window.veyra.ai.set({ model: { provider: def.id, model } }))}
                options={[...(chosenModel && !(models ?? []).includes(chosenModel) ? [chosenModel] : []), ...(models ?? [])].map((m) => ({ value: m, label: m }))}
              />
            </Row>
          )}
        </Group>
      )}

      <Group title="Privacy">
        <Row label="What gets sent" hint="Only the note or text you run an AI tool on, and only when you run it. Local AI never leaves this computer." keywords="privacy data">
          <span />
        </Row>
        <Row label="Forget AI settings" hint="Removes saved keys and your provider choice." keywords="remove keys reset">
          <button className="btn ghost sm" onClick={async () => { setSt(await window.veyra.ai.forget()); setModels(null) }}>
            Forget
          </button>
        </Row>
      </Group>
    </>
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
      <Group title="Your data" footer={onWeb() ? 'Your study data is stored in this browser. Clearing the site’s data deletes it, so export it now and then.' : onAndroid() ? 'Your study data is stored on this phone, separately for each Veyra account.' : 'Your study data is stored on this computer, in a separate file for each Veyra account.'}>
        <Row label="Export everything" hint={onAndroid() ? 'Subjects, tasks, notes, study time and settings, as a JSON file you can save to Files or Google Drive.' : 'Subjects, tasks, notes, study time and settings, as a JSON file.'} keywords="backup download">
          <button
            className="btn sec sm"
            onClick={async () => {
              try {
                const r = await window.veyra.app.exportData()
                if (r.saved) toast(`Exported ${r.count} items`)
              } catch (e) {
                toast(`Couldn’t export: ${String((e as Error).message ?? e)}`)
              }
            }}
          >
            Export…
          </button>
        </Row>
        <Row label="Import from a backup" hint="Adds everything from an exported file. Items already here are updated; nothing is deleted." keywords="restore backup import load">
          <button
            className="btn sec sm"
            onClick={async () => {
              try {
                const r = await window.veyra.app.importData()
                if (r.imported) {
                  toast(`Imported ${r.imported} items`)
                  setTimeout(() => location.reload(), 900)
                }
              } catch (e) {
                toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
              }
            }}
          >
            Import…
          </button>
        </Row>
        {!onAndroid() && (
          <Row label="Open the data folder" keywords="files location">
            <button className="btn sec sm" onClick={() => window.veyra.app.openDataFolder()}>
              Open
            </button>
          </Row>
        )}
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
    case 'phone':
      return <PhoneSection />
    case 'today':
      return <Today />
    case 'tasks':
      return <Tasks />
    case 'notes':
      return <Notes />
    case 'timer':
      return <FocusTimer />
    case 'subjects':
      return <Subjects />
    case 'ai':
      return <AiSettings />
    case 'calendar':
      return <Calendar go={go} />
    case 'account':
      return <AccountSection />
    case 'connections':
      return (
        <>
          <GoogleSection />
          <DriveSection />
          <AiAppsSection />
        </>
      )
    case 'updates':
      return <SoftwareUpdate />
    case 'owner':
      return <OwnerSection />
    case 'data':
      return <DataPrivacy />
  }
}

/** Sections that search covers (account and connections are cards, not rows). */
/** Pages that are cards rather than rows: search shows a shortcut to them. */
const JUMPS: { id: SectionId; words: string }[] = [
  { id: 'account', words: 'account sign in sign out log out veyra username email password profile photo' },
  { id: 'connections', words: 'connected calendars google calendar drive backup docs mcp claude gemini chatgpt codex ai apps connector ical ics link sync outlook icloud events connect' },
  { id: 'updates', words: 'update updates version software new release download install restart about changelog what’s new github report problem bug' }
]

/** Computer-only sections, hidden in the Android app. */
const ANDROID_HIDDEN: SectionId[] = ['ai', 'connections', 'sidebar']
const DESKTOP_HIDDEN: SectionId[] = ['phone']
/** Whether a section belongs on this device. */
export const here = (id: SectionId) => !(onAndroid() ? ANDROID_HIDDEN : DESKTOP_HIDDEN).includes(id)

const SEARCHABLE: SectionId[] = ['general', 'appearance', 'phone', 'sidebar', 'subjects', 'ai', 'today', 'tasks', 'notes', 'timer', 'calendar', 'data']

export function Settings({ initial }: { initial?: string }) {
  const { reset, s } = useSettings()
  const isOwner = useIsOwner(useAccount().state.mode === 'account')
  const [section, setSection] = useState<SectionId>(() => {
    const want = (initial ?? sessionStorage.getItem('veyra.settingsSection')) as SectionId | null
    return want && SECTIONS.some((x) => x.id === want) ? want : 'general'
  })
  const [q, setQ] = useState('')
  useEffect(() => {
    sessionStorage.setItem('veyra.settingsSection', section)
  }, [section])
  // The Ctrl+K palette asks for a section while Settings is already open.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail as SectionId
      if (SECTIONS.some((x) => x.id === id)) {
        setSection(id)
        setQ('')
        setPhoneOpen(true)
      }
    }
    window.addEventListener('veyra:settings-section', on)
    return () => window.removeEventListener('veyra:settings-section', on)
  }, [])

  const current = SECTIONS.find((x) => x.id === section)!
  const changed = (current.keys ?? []).some((k) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]))
  const phone = usePhone()
  // On a phone the list of sections comes first; a section opens full-screen.
  const [phoneOpen, setPhoneOpen] = useState(false)
  const go = (id: SectionId) => {
    const open = () => {
      setQ('')
      setSection(id)
      setPhoneOpen(true)
    }
    if (phone) transition(open, 'push')
    else open()
  }

  return (
    <div className={`settings view ${phone ? (phoneOpen || q ? 'phone-page' : 'phone-list') : ''}`}>
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
          {SECTIONS.filter((x) => here(x.id) && (x.id !== 'owner' || isOwner)).map((x) => (
            <div key={x.id}>
              {(x.id === 'account' || x.id === 'data' || x.id === 'owner') && <div className="set-nav-sep" />}
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
        {phone && (
          <button
            className="phone-back"
            onClick={() =>
              transition(() => {
                setQ('')
                setPhoneOpen(false)
              }, 'pop')
            }
          >
            <ChevronLeft size={18} /> Settings
          </button>
        )}
        {q ? (
          <QueryCtx.Provider value={q.trim()}>
            <div className="set-head">
              <h2 className="set-title">Results for “{q}”</h2>
            </div>
            {JUMPS.filter((j) => matches(q.trim(), j.words) && here(j.id)).map((j) => {
              const x = SECTIONS.find((y) => y.id === j.id)!
              return (
                <button key={j.id} className="set-jump" onClick={() => go(j.id)}>
                  <span className="set-nav-icon">
                    <x.icon size={15} />
                  </span>
                  <span className="grow">
                    <b>{x.label}</b>
                    <span className="set-hint">{x.hint}</span>
                  </span>
                  <span className="tert">→</span>
                </button>
              )
            })}
            {SEARCHABLE.filter((id) => here(id)).map((id) => {
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

/* ---------- Software update ---------- */
// Dev builds list the private test-build releases instead of the public ones.
const RELEASES = IS_DEV ? 'https://github.com/carrotsz19/veyra-study-dev/releases' : 'https://github.com/carrotsz19/veyra-study/releases'

function SoftwareUpdate() {
  const { s, set } = useSettings()
  const [u, setU] = useState<UpdateState | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    // Opening this page checks, unless that's already been done.
    void window.veyra.update.state().then((s) => {
      setU(s)
      if (s.supported && s.status === 'idle') void window.veyra.update.check().then(setU)
    })
    const off = window.veyra.update.onState(setU)
    const t = setInterval(() => tick((n) => n + 1), 30_000) // keeps "checked 2 minutes ago" fresh
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  if (!u) return null
  const mb = (b?: number) => ((b ?? 0) / 1048576).toFixed(0)
  // The website is always the newest version: nothing to download or install.
  const web = onWeb()
  const android = onAndroid() && !web

  const status = web
    ? 'The website is always the newest version'
    :
    u.status === 'checking'
      ? 'Checking for updates…'
      : u.status === 'available'
        ? `Version ${u.latest} is available`
        : u.status === 'downloading'
          ? `Downloading version ${u.latest}… ${mb(u.transferred)} of ${mb(u.total)} MB`
          : u.status === 'ready'
            ? `Version ${u.latest} is ready to install`
            : u.status === 'error'
              ? u.error ?? 'Couldn’t check for updates.'
              : u.status === 'up-to-date'
                ? 'Veyra Study is up to date'
                : u.supported
                  ? 'Not checked yet'
                  : android
                    ? 'New Android versions are on GitHub'
                    : 'Development build: updates come to the installed app'

  return (
    <>
      <Group>
        <BetaNote />
        <div className="upd-card">
          <VeyraMark size={42} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="upd-name">
              Veyra Study {IS_DEV && <span className="dev-pill">DEV</span>}
            </div>
            <div className="sm dim">Version {u.current || __APP_VERSION__}{android ? ' for Android' : web ? ' (website)' : ''}</div>
            {IS_DEV && <div className="xs dim">A test build. Updates come from the newest test build, not from the public releases.</div>}
            <div className={`upd-status ${u.status}`}>
              {u.status === 'checking' && <RefreshCw size={13} className="spin" />}
              {u.status === 'up-to-date' && <Check size={13} />}
              {status}
            </div>
            {u.error && (u.status === 'available' || u.status === 'ready') && <div className="upd-status error">{u.error}</div>}
            {u.checkedAt && u.status !== 'checking' && u.status !== 'downloading' && <div className="xs tert">Checked {formatDistanceToNowStrict(u.checkedAt, { addSuffix: true })}</div>}
          </div>
          <div className="upd-actions">
            {u.supported && (u.status === 'available' ? (
              <button className="btn" onClick={() => void window.veyra.update.download().then(setU)}>
                <Download size={15} /> Download and install
              </button>
            ) : u.status === 'ready' ? (
              <button className="btn" onClick={() => void window.veyra.update.install()}>
                <RotateCcw size={15} /> {android ? 'Install update' : 'Restart to update'}
              </button>
            ) : (
              <button className="btn sec" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => void window.veyra.update.check().then(setU)}>
                <RefreshCw size={15} className={u.status === 'checking' ? 'spin' : ''} /> Check for updates
              </button>
            ))}
            {!u.supported && !web && (
              <button className="btn sec" onClick={() => void window.veyra.open(RELEASES)}>
                <ExternalLink size={14} /> {android ? 'Get the latest' : 'All releases'}
              </button>
            )}
          </div>
        </div>
        {u.status === 'downloading' && (
          <div className="upd-progress">
            <Bar pct={Math.round((u.progress ?? 0) * 100)} />
            <span className="xs dim">{u.speed ? `${(u.speed / 1048576).toFixed(1)} MB/s` : ''}</span>
          </div>
        )}
      </Group>

      {u.notes && (u.status === 'available' || u.status === 'downloading' || u.status === 'ready' || u.status === 'up-to-date') && (
        <Group title={u.status === 'up-to-date' ? 'What’s new in this version' : `What’s new in ${u.latest}`}>
          <div className="upd-notes">{u.notes}</div>
        </Group>
      )}

      {!web && <Group title="Automatic updates" footer={android ? 'Android asks you to confirm each install. The first time, it also asks you to let Veyra Study install apps.' : undefined}>
        <Row
          label={android ? 'Look for updates when Veyra opens' : 'Update automatically'}
          hint={
            android
              ? 'Checks GitHub every few hours and tells you when a new version is out. Off: check here whenever you like.'
              : 'Checks when Veyra starts and every few hours while it runs (even in the tray), downloads new versions quietly, and installs them when you restart or close the window. Off: check here whenever you like.'
          }
          keywords="automatic update startup check version"
        >
          <Toggle label="Check for updates automatically" on={s.checkUpdatesAtStart} onChange={(checkUpdatesAtStart) => set({ checkUpdatesAtStart })} />
        </Row>
      </Group>}

      <Group title="About">
        <Row label="All versions and what changed" keywords="releases changelog history">
          <button className="btn ghost sm" onClick={() => void window.veyra.open(RELEASES)}>
            <ExternalLink size={13} /> Releases on GitHub
          </button>
        </Row>
        <Row label="Report a problem or ask for something" hint="Opens a new issue on GitHub (a free GitHub account is needed)." keywords="bug feedback issue help support">
          <button className="btn ghost sm" onClick={() => void window.veyra.open('https://github.com/carrotsz19/veyra-study/issues/new')}>
            <ExternalLink size={13} /> Report a problem
          </button>
        </Row>
        <Row label="Source code" hint="Veyra Study is open source." keywords="github code open source">
          <button className="btn ghost sm" onClick={() => void window.veyra.open('https://github.com/carrotsz19/veyra-study')}>
            <ExternalLink size={13} /> carrotsz19/veyra-study
          </button>
        </Row>
      </Group>
    </>
  )
}

/** Windows: Mac-style dots drawn by Veyra, or Windows' own buttons. Saved per computer; applies on the next start. */
function WindowButtonsRow(): ReactNode {
  const running = window.veyra.app.windowButtons ?? 'windows'
  const [choice, setChoice] = useState<'dots' | 'windows'>(() => window.veyra.app.windowButtonsChoice?.() ?? running)
  return (
    <Row
      label="Window buttons"
      hint={
        choice === 'windows'
          ? 'Windows’ own minimise, maximise and close, with Snap layouts when you point at maximise.'
          : 'Three coloured dots like a Mac: minimise, maximise, close. Their symbols show when you point at them.'
      }
      keywords="minimise maximise close traffic lights mac windows snap title bar"
    >
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Choice
          label="Window buttons"
          value={choice}
          onChange={(b) => {
            setChoice(b)
            void window.veyra.app.setWindowButtons?.(b)
          }}
          options={[
            ['windows', 'Windows'],
            ['dots', 'Mac-style']
          ]}
        />
        {choice !== running && (
          <button className="btn sm" onClick={() => void window.veyra.app.relaunch?.()}>
            Restart now
          </button>
        )}
      </div>
    </Row>
  )
}
