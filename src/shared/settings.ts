import type { NoteFont, NoteTemplate, Priority } from './types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type NavId = 'today' | 'tasks' | 'notes' | 'calendar' | 'groups' | 'timer' | 'stats'
export type StartScreen = NavId | 'last'
export type TaskSort = 'due' | 'priority' | 'created' | 'title'

/** Widgets on the Today page (Today → Customize). */
export type WidgetId = 'stats' | 'due' | 'upcoming' | 'schedule' | 'focus' | 'subjects' | 'goal' | 'week' | 'streak' | 'notes' | 'quickadd'
/** Width on Today's 6-column grid: s = a third, m = half, l = two thirds, xl = full. */
export type WidgetSize = 's' | 'm' | 'l' | 'xl'
export interface WidgetSlot {
  id: WidgetId
  size: WidgetSize
}

/** Everything a person can change. Stored as one "settings" record, so it travels with the account. */
export interface AppSettings {
  /* appearance */
  theme: ThemeMode
  /** Accent preset key (ACCENTS) or a custom "#rrggbb". */
  accent: string
  font: 'system' | 'inter' | 'serif'
  /** Interface zoom, 0.8–1.4. */
  zoom: number
  density: 'compact' | 'comfortable' | 'spacious'
  corners: 'square' | 'soft' | 'round'
  reduceMotion: boolean
  /** Window background on Windows 11: solid, or see-through acrylic / mica. */
  material: 'solid' | 'acrylic' | 'mica'
  /* sidebar */
  nav: { id: NavId; visible: boolean }[]
  showCounts: boolean
  showSubjectsInSidebar: boolean
  showTimerCard: boolean
  /** Computer: the full sidebar, just its icons, or hidden until you point at the left edge (like Zen browser). */
  sidebarMode: 'full' | 'icons' | 'hidden'
  /* general */
  startScreen: StartScreen
  name: string
  greeting: boolean
  weekStart: 0 | 1 | 6
  timeFormat: '12h' | '24h'
  /* today */
  todayStats: boolean
  todayDue: boolean
  todayUpcoming: boolean
  upcomingCount: number
  todaySchedule: boolean
  todayFocus: boolean
  todaySubjects: boolean
  /** The Today page's widgets, in order. Empty means the default layout. */
  todayLayout: WidgetSlot[]
  /* tasks */
  defaultPriority: Priority
  defaultDue: 'none' | 'today' | 'tomorrow' | 'week'
  taskSort: TaskSort
  showDoneInLists: boolean
  highlightOverdue: boolean
  /** Reminders: a notification at a task's own reminder time, a morning summary, an evening heads-up. */
  remindersOn: boolean
  remindMorning: boolean
  /** "HH:MM" */
  morningTime: string
  remindEvening: boolean
  eveningTime: string
  /** Closing the window keeps Veyra in the tray (so reminders still come). */
  keepInTray: boolean
  startWithWindows: boolean
  /** Voice recordings: which offline model transcribes, in which language, and whether it starts by itself. */
  voiceModel: 'base' | 'small'
  voiceLanguage: string
  voiceAutoTranscribe: boolean
  /** Transcribe with Subtitle Maker when it's installed and working. */
  voiceUseSubtitleMaker: boolean
  /** AI apps (MCP) can read Veyra; and, separately, change it. */
  mcpEnabled: boolean
  mcpAllowWrites: boolean
  /** Check for a new version each time Veyra starts (the installed app). */
  checkUpdatesAtStart: boolean
  /* notes */
  noteTemplate: NoteTemplate
  noteFont: NoteFont
  noteCover: 'none' | 'random' | string
  noteWidth: 'narrow' | 'normal' | 'wide'
  noteSize: number
  spellcheck: boolean
  showWordCount: boolean
  /** How formatting is offered: the "/" menu only, a toolbar at the top, or both. */
  noteToolbar: 'slash' | 'bar' | 'both'
  /** The small format bar that appears when you select text. */
  noteBubble: boolean
  noteSort: 'edited' | 'created' | 'title'
  /* focus timer */
  focusMin: number
  breakMin: number
  longBreakMin: number
  longBreakEvery: number
  autoStartBreaks: boolean
  autoStartFocus: boolean
  sound: 'chime' | 'bell' | 'soft' | 'none'
  volume: number
  notify: boolean
  dailyGoalMin: number
  /* calendar */
  calendarShowEvents: boolean
  calendarShowDone: boolean
  calendarShowTasks: boolean
  /* phone (the Android app) */
  /** The four screens in the navigation bar, in order; the rest are under More. */
  phoneTabs: NavId[]
  /** Names under the bar's icons: always, only the current one, or never. */
  phoneTabLabels: 'always' | 'selected' | 'never'
  /** The round button beside the bar: what fits the screen, always a task, always a note, or none. */
  phoneCompose: 'smart' | 'task' | 'note' | 'off'
  /** A floating rounded bar, or one docked along the bottom edge. */
  phoneDock: 'floating' | 'docked'
  phoneHideNavTyping: boolean
  /** The running focus timer as a small pill above the bar. */
  phoneTimerPill: boolean
  /** One UI-style large titles, with room above them so the top is easier to reach one-handed. */
  phoneLargeTitles: boolean
  /** Where a note's formatting bar sits. */
  phoneNoteBar: 'bottom' | 'top'
  /** A light tap of vibration when you tick a task, switch tabs or press buttons. */
  haptics: boolean
  /** Keep the screen on while a focus block runs. */
  keepAwakeFocus: boolean
  /** Dark mode in true black (saves battery on OLED screens). */
  pureBlack: boolean
}

export const ACCENTS: Record<string, { name: string; light: string; dark: string }> = {
  clay: { name: 'Clay', light: '#b3492b', dark: '#d9633e' },
  ocean: { name: 'Ocean', light: '#2f5f8a', dark: '#6b9fd0' },
  forest: { name: 'Forest', light: '#3f6b4a', dark: '#7fae87' },
  plum: { name: 'Plum', light: '#7a4f9a', dark: '#b18ad1' },
  amber: { name: 'Amber', light: '#a86f1d', dark: '#e0a447' },
  rose: { name: 'Rose', light: '#a83c62', dark: '#e07a9e' },
  teal: { name: 'Teal', light: '#2f7d7a', dark: '#5fbcb6' },
  graphite: { name: 'Graphite', light: '#4a4945', dark: '#c9c5bc' }
}

export const NAV_LABELS: Record<NavId, string> = {
  today: 'Today',
  tasks: 'Tasks',
  notes: 'Notes',
  calendar: 'Calendar',
  groups: 'Group work',
  timer: 'Focus timer',
  stats: 'Stats'
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  accent: 'clay',
  font: 'system',
  zoom: 1,
  density: 'comfortable',
  corners: 'soft',
  reduceMotion: false,
  material: 'acrylic',
  nav: (['today', 'tasks', 'notes', 'calendar', 'groups', 'timer', 'stats'] as NavId[]).map((id) => ({ id, visible: true })),
  showCounts: true,
  showSubjectsInSidebar: true,
  showTimerCard: true,
  sidebarMode: 'full',
  startScreen: 'today',
  name: '',
  greeting: true,
  weekStart: 1,
  timeFormat: '12h',
  todayStats: true,
  todayDue: true,
  todayUpcoming: true,
  upcomingCount: 5,
  todaySchedule: true,
  todayFocus: true,
  todaySubjects: true,
  todayLayout: [],
  defaultPriority: 'normal',
  defaultDue: 'today',
  taskSort: 'due',
  showDoneInLists: true,
  highlightOverdue: true,
  remindersOn: true,
  remindMorning: true,
  morningTime: '08:00',
  remindEvening: true,
  eveningTime: '19:00',
  keepInTray: true,
  startWithWindows: false,
  voiceModel: 'base',
  voiceLanguage: 'auto',
  voiceAutoTranscribe: true,
  voiceUseSubtitleMaker: true,
  mcpEnabled: false,
  mcpAllowWrites: false,
  checkUpdatesAtStart: true,
  noteTemplate: 'page',
  noteFont: 'sans',
  noteCover: 'none',
  noteWidth: 'normal',
  noteSize: 16,
  spellcheck: true,
  showWordCount: true,
  noteToolbar: 'both',
  noteBubble: true,
  noteSort: 'edited',
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartBreaks: true,
  autoStartFocus: true,
  sound: 'chime',
  volume: 0.6,
  notify: true,
  dailyGoalMin: 120,
  calendarShowEvents: true,
  calendarShowDone: true,
  calendarShowTasks: true,
  phoneTabs: ['today', 'tasks', 'notes', 'calendar'],
  phoneTabLabels: 'always',
  phoneCompose: 'smart',
  phoneDock: 'floating',
  phoneHideNavTyping: true,
  phoneTimerPill: true,
  phoneLargeTitles: false,
  phoneNoteBar: 'bottom',
  haptics: true,
  keepAwakeFocus: true,
  pureBlack: false
}

/** Defaults filled in for anything missing (older saves, new options). */
export function withDefaults(s: Partial<AppSettings> | null | undefined): AppSettings {
  const out = { ...DEFAULT_SETTINGS, ...(s ?? {}) }
  // Keep every nav item in the saved order; new ones go in after the item they follow by default.
  const nav = (s?.nav ?? []).filter((n, i, all) => DEFAULT_SETTINGS.nav.some((d) => d.id === n.id) && all.findIndex((x) => x.id === n.id) === i)
  DEFAULT_SETTINGS.nav.forEach((d, i) => {
    if (nav.some((n) => n.id === d.id)) return
    const after = i > 0 ? nav.findIndex((n) => n.id === DEFAULT_SETTINGS.nav[i - 1].id) : -1
    nav.splice(after + 1, 0, { ...d })
  })
  out.nav = nav
  // Today's layout: the saved one, or the default built from the older on/off switches.
  const layout = (s?.todayLayout ?? []).filter((w, i, all) => WIDGETS.includes(w.id) && all.findIndex((x) => x.id === w.id) === i)
  out.todayLayout = layout.length ? layout : defaultLayout(out)
  // The phone bar: two to four different screens (the default four if fewer are saved).
  const ids = DEFAULT_SETTINGS.nav.map((n) => n.id)
  const tabs = (Array.isArray(s?.phoneTabs) ? s.phoneTabs : []).filter((t, i, all) => ids.includes(t) && all.indexOf(t) === i).slice(0, 4)
  out.phoneTabs = tabs.length >= 2 ? tabs : [...DEFAULT_SETTINGS.phoneTabs]
  return out
}

export function accentColors(accent: string): { light: string; dark: string } {
  if (ACCENTS[accent]) return ACCENTS[accent]
  if (/^#[0-9a-f]{6}$/i.test(accent)) return { light: accent, dark: accent }
  return ACCENTS.clay
}

export const WIDGETS: WidgetId[] = ['stats', 'due', 'upcoming', 'schedule', 'focus', 'subjects', 'goal', 'week', 'streak', 'notes', 'quickadd']

export function defaultLayout(s?: Partial<AppSettings>): WidgetSlot[] {
  const on = (k: keyof AppSettings) => (s ? s[k] !== false : true)
  const slots: (WidgetSlot | false)[] = [
    on('todayStats') && { id: 'stats', size: 'xl' },
    on('todayDue') && { id: 'due', size: 'l' },
    on('todayFocus') && { id: 'focus', size: 's' },
    on('todayUpcoming') && { id: 'upcoming', size: 'l' },
    on('todaySchedule') && { id: 'schedule', size: 's' },
    on('todaySubjects') && { id: 'subjects', size: 's' }
  ]
  return slots.filter(Boolean) as WidgetSlot[]
}
