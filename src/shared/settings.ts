import type { NoteFont, NoteTemplate, Priority } from './types'

export type ThemeMode = 'system' | 'light' | 'dark'
export type NavId = 'today' | 'tasks' | 'notes' | 'calendar' | 'timer' | 'stats'
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
  /* sidebar */
  nav: { id: NavId; visible: boolean }[]
  showCounts: boolean
  showSubjectsInSidebar: boolean
  showTimerCard: boolean
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
  /* notes */
  noteTemplate: NoteTemplate
  noteFont: NoteFont
  noteCover: 'none' | 'random' | string
  noteWidth: 'narrow' | 'normal' | 'wide'
  noteSize: number
  spellcheck: boolean
  showWordCount: boolean
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
  nav: (['today', 'tasks', 'notes', 'calendar', 'timer', 'stats'] as NavId[]).map((id) => ({ id, visible: true })),
  showCounts: true,
  showSubjectsInSidebar: true,
  showTimerCard: true,
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
  noteTemplate: 'page',
  noteFont: 'sans',
  noteCover: 'none',
  noteWidth: 'normal',
  noteSize: 16,
  spellcheck: true,
  showWordCount: true,
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: 'chime',
  volume: 0.6,
  notify: true,
  dailyGoalMin: 120,
  calendarShowEvents: true,
  calendarShowDone: true,
  calendarShowTasks: true
}

/** Defaults filled in for anything missing (older saves, new options). */
export function withDefaults(s: Partial<AppSettings> | null | undefined): AppSettings {
  const out = { ...DEFAULT_SETTINGS, ...(s ?? {}) }
  // Keep every nav item, in the saved order, with new ones appended.
  const saved = (s?.nav ?? []).filter((n) => DEFAULT_SETTINGS.nav.some((d) => d.id === n.id))
  out.nav = [...saved, ...DEFAULT_SETTINGS.nav.filter((d) => !saved.some((n) => n.id === d.id))]
  // Today's layout: the saved one, or the default built from the older on/off switches.
  const layout = (s?.todayLayout ?? []).filter((w, i, all) => WIDGETS.includes(w.id) && all.findIndex((x) => x.id === w.id) === i)
  out.todayLayout = layout.length ? layout : defaultLayout(out)
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
