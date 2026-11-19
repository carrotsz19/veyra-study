import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavId, SidebarMode, ThemeMode } from '@shared/settings'
import { clampSidebarWidth, resolveSidebarDrag, SIDEBAR_DEFAULT_WIDTH } from '@shared/sidebar'
import { SettingsProvider, useSettings } from './data/settings'
import { phaseLabel } from './components/timer'
import { BarChart3, CalendarDays, GraduationCap, Home, ListTodo, MessageCircle, Monitor, Moon, NotebookPen, Plus, Search, Settings as SettingsIcon, Sparkles, Sun, Timer, Users } from 'lucide-react'
import { useRecords } from './data/store'
import { clock, isOverdue } from './lib/dates'
import { NavCtx, useNav, type Route } from './nav'
import { ToastProvider, useToast } from './components/ui'
import { Announcements } from './components/Announcements'
import { useGroupStatus } from './data/groups'
import { AccountGate, Avatar, useAccount } from './components/account'
import { Settings } from './views/Settings'
import { TimerProvider, useTimer } from './components/timer'
import { SubjectDialog } from './components/editors'
import { Today } from './views/Today'
import { Tasks } from './views/Tasks'
import { Notes } from './views/Notes'
import { AiView, useAiTabOpen } from './views/AiView'
import { Calendar, usePrefetchCalendar } from './views/Calendar'
import { TimerView } from './views/TimerView'
import { Stats } from './views/Stats'
import { SubjectView } from './views/SubjectView'
import { Groups } from './views/Groups'
import { Messages } from './views/Messages'
import { getCachedGroup, groupCall, prefetchGroups } from './data/groups'
import { useFriends } from './data/friends'
import { useDmBadgeCount } from './data/dm-read'
import { isDmGroup } from '@shared/dm'
import { isDmGroupAllowed } from '@shared/privacy'
import { ChatNotifier } from '@shared/chat-notify'
import { startDriveBackup } from './data/drive'
import { VoiceSetupHost } from './components/notes/Voice'
import { PhoneNav } from './components/PhoneNav'
import { Palette } from './components/Palette'
import { TitleBar } from './components/TitleBar'
import { emptyOldTrash } from './lib/notes'
import { onAndroid, usePhone } from './lib/phone'
import { startSegments } from './lib/segments'
import { transition } from './lib/motion'
import { IS_DEV } from '@shared/channel'
import { BetaNotice } from './components/BetaNotice'
import { ServerHoursNotice } from './components/ServerHours'
import { SubjectNav } from './components/SubjectNav'
import { CallDock, CallNotices } from './components/Voice'
import { setRouteBack } from './lib/back'

startSegments()

const SIDEBAR_WIDTH_KEY = 'veyra.sidebarWidth'
function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (!raw) return SIDEBAR_DEFAULT_WIDTH
    return clampSidebarWidth(Number(raw))
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}
function saveSidebarWidth(width: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
  } catch {
    /* storage unavailable */
  }
}

/** Full → icons only → hidden (slides out at the left edge) → full. */
export const nextSidebarMode = (m: 'full' | 'icons' | 'hidden') => (m === 'full' ? 'icons' : m === 'icons' ? 'hidden' : 'full')

function Sidebar({
  route,
  go,
  onEnter,
  onLeave,
  compact,
  onResizeStart,
  onResizeReset
}: {
  route: Route
  go: (r: Route) => void
  onEnter?: () => void
  onLeave?: () => void
  compact?: boolean
  onResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void
  onResizeReset?: () => void
}) {
  const { items: subjects } = useRecords('subject')
  const { items: tasks } = useRecords('task')
  const timer = useTimer()
  const { s, set } = useSettings()
  usePrefetchCalendar(s.weekStart, s.calendarShowEvents)
  const theme = s.theme
  const setTheme = (t: ThemeMode) => set({ theme: t })
  const [adding, setAdding] = useState(false)
  const user = useAccount().state.user

  const archivedSubjects = new Set(subjects.filter((x) => x.data.archived).map((x) => x.id))
  const live = tasks.filter((t) => !t.data.subjectId || !archivedSubjects.has(t.data.subjectId))
  const open = live.filter((t) => !t.data.done).length
  const overdue = live.filter((t) => isOverdue(t.data.due, t.data.done)).length
  const aiOpen = useAiTabOpen()
  const accountState = useAccount().state
  const friends = useFriends(accountState.mode === 'account' && !accountState.ended).data.friends
  const dmBadge = useDmBadgeCount(!!user, user?.username, s, friends)
  const items: Record<NavId, [string, typeof Home, string?]> = {
    today: ['Today', Home, overdue ? `${overdue} late` : undefined],
    tasks: ['Tasks', ListTodo, open ? String(open) : undefined],
    notes: ['Notes', NotebookPen],
    ai: ['Veyra AI', Sparkles, aiOpen === false ? 'Soon' : undefined],
    calendar: ['Calendar', CalendarDays],
    messages: ['Messages', MessageCircle, dmBadge ? (dmBadge > 99 ? '99+' : String(dmBadge)) : undefined],
    groups: ['Group work', Users],
    timer: ['Focus timer', Timer],
    stats: ['Stats', BarChart3]
  }
  const nav = s.nav.filter((n) => n.visible).map((n) => [n.id, ...items[n.id]] as [NavId, string, typeof Home, string?])
  const nextTheme: Record<ThemeMode, ThemeMode> = { system: 'dark', dark: 'light', light: 'system' }
  // Icons only: names show as tooltips.
  const tip = (label: string) => (!compact && s.sidebarMode === 'full' ? undefined : label)

  return (
    <aside className="side" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {/* The name is in the title bar on Windows; elsewhere it heads the sidebar. */}
      {!window.veyra.app.titleBar && (
        <div className="brand">
          <div className="mark">
            <GraduationCap size={18} />
          </div>
          <b>Veyra Study</b>
          {IS_DEV && <span className="dev-pill">DEV</span>}
        </div>
      )}
      <div className="side-scroll">
        <button className="side-search" onClick={() => window.dispatchEvent(new Event('veyra:palette'))} title="Search everything and run commands (Ctrl+K)">
          <Search size={15} />
          <span className="grow nav-label">Search</span>
          <kbd className="nav-label">Ctrl K</kbd>
        </button>
        <nav aria-label="Main">
          {nav.map(([name, label, Icon, count]) => (
            <button key={name} className="navbtn" aria-current={route.name === name} onClick={() => go({ name } as Route)} title={tip(count ? `${label} (${count})` : label)} aria-label={label}>
              <Icon size={17} /> <span className="nav-label">{label}</span>
              {name === 'ai' ? count && <span className="count soon nav-label">{count}</span> : count && s.showCounts && <span className="count">{count}</span>}
            </button>
          ))}
        </nav>

        {s.showSubjectsInSidebar && (
          <>
        <SubjectNav
          subjects={subjects}
          route={route}
          go={go}
          tip={tip}
          heading={
            <div className="between group-label side-section">
              <h2 style={{ margin: 0 }}>Subjects</h2>
              <button className="iconbtn plain" style={{ width: 26, height: 26 }} aria-label="Add subject" onClick={() => setAdding(true)}>
                <Plus size={15} />
              </button>
            </div>
          }
        />
        {!subjects.some((s) => !s.data.archived) && (
          <button className="navbtn dim" onClick={() => setAdding(true)} style={{ fontWeight: 500 }}>
            <Plus size={16} /> Add your first subject
          </button>
        )}
          </>
        )}

        <div className="spacer" />
      </div>

      <div className="side-bottom">
        {s.showTimerCard && (timer.running || timer.remaining < timer.total) && route.name !== 'timer' && (
          <button className={`sidecard ${timer.running ? 'live' : ''}`} onClick={() => go({ name: 'timer' })}>
            <div className="xs nav-label" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              {phaseLabel(timer.phase)} {timer.running ? '' : '· paused'}
            </div>
            <div className="num" style={{ fontSize: 20, fontWeight: 800 }}>
              {clock(timer.remaining)}
            </div>
          </button>
        )}
        <CallDock />
        <div className="side-foot">
          <button className="account-chip" aria-current={route.name === 'settings'} onClick={() => go({ name: 'settings' })} title="Account and settings">
            {user ? (
              <Avatar user={user} />
            ) : (
              <span className="avatar">
                <SettingsIcon size={15} />
              </span>
            )}
            <span className="grow nav-label" style={{ minWidth: 0 }}>
              <span className="trunc" style={{ display: 'block', fontWeight: 650 }}>{user ? user.displayName : 'Settings'}</span>
              <span className="trunc xs dim" style={{ display: 'block' }}>{user ? `@${user.username}` : 'Not signed in'}</span>
            </span>
          </button>
          <button
            className="iconbtn plain"
            onClick={() => setTheme(nextTheme[theme])}
            title={theme === 'system' ? 'Theme: System' : theme === 'dark' ? 'Theme: Dark' : 'Theme: Light'}
            aria-label="Change theme"
          >
            {theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />}
          </button>
        </div>
      </div>
      {adding && <SubjectDialog onClose={() => setAdding(false)} onSaved={(id) => go({ name: 'subject', id })} />}
      {onResizeStart && (
        <div
          className="side-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize or snap to icons · Double-click to reset"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeReset}
        />
      )}
    </aside>
  )
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'today':
      return <Today startEditing={route.edit} />
    case 'tasks':
      return <Tasks />
    case 'notes':
      return <Notes noteId={route.noteId} />
    case 'ai':
      return <AiView chatId={route.chatId} />
    case 'calendar':
      return <Calendar />
    case 'messages':
      return <Messages initialDmId={route.dmId} />
    case 'groups':
      return <Groups />
    case 'timer':
      return <TimerView />
    case 'stats':
      return <Stats />
    case 'subject':
      return <SubjectView id={route.id} />
    case 'settings':
      return <Settings />
  }
}

/** The first start after an update: say so, and offer what's new. */
function UpdatedNotice() {
  const toast = useToast()
  const { go } = useNav()
  useEffect(() => {
    try {
      const seen = localStorage.getItem('veyra.seenVersion')
      localStorage.setItem('veyra.seenVersion', __APP_VERSION__)
      if (seen && seen !== __APP_VERSION__)
        toast(`Veyra Study updated to ${__APP_VERSION__}`, {
          label: 'What’s new',
          run: () => {
            sessionStorage.setItem('veyra.settingsSection', 'updates')
            go({ name: 'settings' })
          }
        })
    } catch {
      /* storage unavailable */
    }
  }, [toast, go])
  // A newer version turned up: say so once. The phone downloads when you say so; the computer
  // downloads by itself and offers to restart (closing the window installs it too).
  useEffect(
    () =>
      window.veyra.update.onState((u) => {
        if (!u.latest) return
        const key = `${u.status}:${u.latest}`
        if (told.has(key)) return
        if (u.status === 'available' && onAndroid()) {
          told.add(key)
          toast(`Veyra Study ${u.latest} is available`, {
            label: 'Update',
            run: () => {
              sessionStorage.setItem('veyra.settingsSection', 'updates')
              go({ name: 'settings' })
            }
          })
        } else if (u.status === 'ready' && !onAndroid()) {
          told.add(key)
          toast(`Veyra Study ${u.latest} is ready to install`, { label: 'Restart', run: () => void window.veyra.update.install() })
        }
      }),
    [toast, go]
  )
  return null
}
const told = new Set<string>()

/** After the first sign-in moved this computer's data into the account. */
function MovedNotice() {
  const toast = useToast()
  useEffect(() => {
    if (sessionStorage.getItem('veyra.moved')) {
      sessionStorage.removeItem('veyra.moved')
      toast('Your notes, tasks and study time are now in your Veyra account.')
    }
  }, [toast])
  return null
}

/** The owner's announcements, once the group server is reachable. */
function AnnouncementsHost({ signedIn }: { signedIn: boolean }) {
  const { status } = useGroupStatus()
  return signedIn ? <Announcements online={status?.state === 'online'} /> : null
}

const ROUTES = ['today', 'tasks', 'notes', 'ai', 'calendar', 'messages', 'groups', 'timer', 'stats', 'settings']

/** The page this tab was on before a reload, if it was reloaded. */
function reloadedOn(): Route | null {
  try {
    const r = JSON.parse(sessionStorage.getItem('veyra.route') ?? 'null') as Route | null
    if (r && (ROUTES.includes(r.name) || (r.name === 'subject' && typeof r.id === 'string'))) return r
  } catch {
    /* storage unavailable, or not a route */
  }
  return null
}

/** The app once settings are known: picks the start screen, remembers the last one. */
function Shell() {
  const { ready, s, set } = useSettings()
  const [route, go] = useState<Route | null>(null)
  const signedIn = useAccount().state.mode === 'account'
  const phone = usePhone()
  const titleBar = !phone && (window.veyra.app.titleBar ?? 0) > 0 ? window.veyra.app.titleBar! : 0
  // Hidden sidebar (Zen-style): it slides out while you point at the left edge or at it, and back after a moment away.
  const [peek, setPeek] = useState(false)
  // Zen-style resizable sidebar width, persisted locally.
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const [resizingSide, setResizingSide] = useState(false)
  const resizingSideRef = useRef(false)
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  // Temporarily compact the full sidebar to icons while editing a note with the Assistant open,
  // according to Settings → Sidebar → When Assistant opens ('auto' | 'always' | 'never').
  const [assistState, setAssistState] = useState<{ open: boolean; inSubject: boolean }>({ open: false, inSubject: false })
  const [winWidth, setWinWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onAssist = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean; inSubject?: boolean }>).detail
      setAssistState({ open: !!detail?.open, inSubject: !!detail?.inSubject })
    }
    const onResize = () => setWinWidth(window.innerWidth)
    window.addEventListener('veyra:assistant-open', onAssist)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('veyra:assistant-open', onAssist)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  useEffect(() => {
    setAssistState({ open: false, inSubject: false })
  }, [s.sidebarMode, route?.name])
  const autoCompactSide =
    assistState.open &&
    (s.assistantCollapseSidebar === 'always' ||
      (s.assistantCollapseSidebar === 'auto' && (assistState.inSubject || winWidth < 1440)))
  const effectiveSide = autoCompactSide && s.sidebarMode === 'full' ? 'icons' : s.sidebarMode
  const effectiveSideRef = useRef<SidebarMode>(effectiveSide)
  effectiveSideRef.current = effectiveSide
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peekIn = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setPeek(true)
  }, [])
  const peekOut = useCallback(() => {
    if (resizingSideRef.current) return
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setPeek(false), 380)
  }, [])
  const startResizeSidebar = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      resizingSideRef.current = true
      setResizingSide(true)
      document.body.classList.add('resizing-pane')

      let activeMode: SidebarMode = effectiveSideRef.current
      let committedMode: SidebarMode = s.sidebarMode
      let lastFull = sidebarWidthRef.current
      const isHidden = activeMode === 'hidden'
      if (isHidden) {
        if (leaveTimer.current) clearTimeout(leaveTimer.current)
        setPeek(true)
      }

      const onMove = (ev: PointerEvent) => {
        const pointerWidth = Math.round(isHidden ? ev.clientX - 8 : ev.clientX)
        const next = resolveSidebarDrag(activeMode, pointerWidth, lastFull)
        if (next.width !== lastFull) {
          lastFull = next.width
          sidebarWidthRef.current = next.width
          setSidebarWidth(next.width)
        }
        if (next.mode !== activeMode) {
          activeMode = next.mode
          if (next.mode === 'full') setAssistState({ open: false, inSubject: false })
          if (next.mode !== committedMode) {
            committedMode = next.mode
            set({ sidebarMode: next.mode })
          }
        }
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        resizingSideRef.current = false
        setResizingSide(false)
        document.body.classList.remove('resizing-pane')
        saveSidebarWidth(lastFull)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [s.sidebarMode, set]
  )
  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    setAssistState({ open: false, inSubject: false })
    if (s.sidebarMode === 'icons') set({ sidebarMode: 'full' })
  }, [s.sidebarMode, set])
  // Moving to another screen crossfades it in (the same screen again just updates).
  const current = useRef(route)
  current.current = route
  // Back on the phone (lib/back.ts): a subject's page goes back to where it was opened from,
  // any other screen to the one Veyra started on.
  const home = useRef<Route>({ name: 'today' })
  const cameFrom = useRef<Route | null>(null)
  const navigate = useCallback((r: Route) => {
    const cur = current.current
    if (r.name === 'subject' && cur && cur.name !== 'subject') cameFrom.current = cur
    if (cur && cur.name !== r.name) transition(() => go(r))
    else go(r)
  }, [])
  useEffect(
    () =>
      setRouteBack({
        can: () => !!current.current && (current.current.name === 'subject' || current.current.name !== home.current.name),
        go: () => navigate(current.current?.name === 'subject' && cameFrom.current ? cameFrom.current : home.current)
      }),
    [navigate]
  )
  // Group work loads in the background, so the tab opens ready.
  useEffect(() => (signedIn ? prefetchGroups() : undefined), [signedIn])
  // Notes back up to Google Drive (when it's connected and backup is on).
  useEffect(() => startDriveBackup(), [])
  // Notes in the trash for over 30 days go for good.
  useEffect(() => void emptyOldTrash(), [])
  // The tray menu or a reminder asks for a screen.
  useEffect(() => window.veyra.app.onNav((screen) => ROUTES.includes(screen) && navigate({ name: screen } as Route)), [navigate])
  // Clicking a DM / group chat desktop notification opens that conversation directly.
  const openChatGroup = useCallback((groupId: string, isDmHint?: boolean) => {
    const cached = getCachedGroup(groupId)
    const dm = isDmHint ?? (cached ? isDmGroup(cached) : false)
    if (dm) {
      try {
        localStorage.setItem('veyra.dm', groupId)
      } catch {
        /* storage unavailable */
      }
      navigate({ name: 'messages', dmId: groupId })
      setTimeout(() => window.dispatchEvent(new CustomEvent('veyra:open-dm', { detail: groupId })), 0)
      return
    }
    try {
      localStorage.setItem('veyra.group', groupId)
      localStorage.setItem('veyra.groupTab', 'chat')
    } catch {
      /* storage unavailable */
    }
    navigate({ name: 'groups' })
    setTimeout(() => window.dispatchEvent(new CustomEvent('veyra:open-chat', { detail: groupId })), 0)
  }, [navigate])
  useEffect(() => window.veyra.app.onOpenChat?.((id) => openChatGroup(id)), [openChatGroup])
  // Web-mode fallback for DM/chat desktop notifications (Electron desktop handles this in the main process).
  const accountState = useAccount().state
  const meId = accountState.user?.username ?? null
  const webFriends = useFriends(signedIn && !accountState.ended).data.friends
  const chatNotifyRef = useRef(s.chatNotify)
  chatNotifyRef.current = s.chatNotify
  const dmPrivacyRef = useRef(s.dmWhoCanMessage)
  dmPrivacyRef.current = s.dmWhoCanMessage
  const friendsRef = useRef(webFriends)
  friendsRef.current = webFriends
  useEffect(() => {
    if (!signedIn || window.veyra.app.notifyCheck || typeof Notification === 'undefined') return
    const notifier = new ChatNotifier({
      call: (method, path) => groupCall(method, path),
      meId: () => meId,
      enabled: () => chatNotifyRef.current && Notification.permission === 'granted',
      isWindowActive: () => document.visibilityState === 'visible' && document.hasFocus(),
      allowGroup: (g) => isDmGroupAllowed(g, meId, { dmWhoCanMessage: dmPrivacyRef.current }, friendsRef.current),
      notify: (notice) => {
        try {
          const n = new Notification(notice.title, { body: notice.body })
          n.onclick = () => {
            window.focus()
            openChatGroup(notice.groupId, notice.isDm)
          }
        } catch {
          /* browser blocked notification */
        }
      }
    })
    const offStatus = window.veyra.group.onStatus((st) => notifier.onEvent('group:status', st))
    const offChanged = window.veyra.group.onChanged((ev) => notifier.onEvent('group:changed', ev))
    if (s.chatNotify) notifier.onSettingsChanged()
    return () => {
      offStatus()
      offChanged()
      notifier.dispose()
    }
  }, [signedIn, meId, s.chatNotify, openChatGroup])

  useEffect(() => {
    if (!ready || route) return
    // The URL hash (#tasks, #stats...) wins, for dev checks.
    const hash = location.hash.slice(1)
    let name: string = ROUTES.includes(hash) ? hash : s.startScreen
    if (name === 'last') {
      try {
        name = localStorage.getItem('veyra.lastRoute') ?? 'today'
      } catch {
        name = 'today'
      }
    }
    home.current = { name: ROUTES.includes(name) ? name : 'today' } as Route
    go((s.reloadTo === 'page' && !ROUTES.includes(hash) && reloadedOn()) || home.current)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!route) return
    try {
      // For a reload (this tab, or this run of the phone app; sessionStorage doesn't outlive either).
      sessionStorage.setItem('veyra.route', JSON.stringify(route.name === 'today' ? { name: 'today' } : route))
      if (route.name !== 'subject') localStorage.setItem('veyra.lastRoute', route.name)
    } catch {
      /* storage unavailable */
    }
  }, [route])

  if (!route) return null
  const shellStyle = (!phone || titleBar)
    ? ({
        ...(titleBar ? { '--titlebar': `${titleBar}px` } : {}),
        ...(!phone ? { '--sidebar': `${sidebarWidth}px` } : {})
      } as React.CSSProperties)
    : undefined
  return (
    <TimerProvider>
      <NavCtx.Provider value={{ route, go: navigate }}>
        <div className={`shell ${phone ? 'phone-shell' : `${titleBar ? 'has-titlebar' : ''} side-${effectiveSide} ${peek ? 'peek' : ''} ${resizingSide ? 'resizing-sidebar' : ''}`}`} data-route={route.name} style={shellStyle}>
          {titleBar > 0 && <TitleBar />}
          {phone ? (
            <PhoneNav route={route} go={navigate} />
          ) : (
            <Sidebar
              route={route}
              go={navigate}
              onEnter={peekIn}
              onLeave={peekOut}
              compact={effectiveSide !== 'full'}
              onResizeStart={startResizeSidebar}
              onResizeReset={resetSidebarWidth}
            />
          )}
          {/* Hidden sidebar: pointing at the left edge slides it out. */}
          {!phone && effectiveSide === 'hidden' && <div className="side-hotzone" onMouseEnter={peekIn} onMouseLeave={peekOut} aria-hidden />}
          <UpdatedNotice />
          <CallNotices />
          {(phone || effectiveSide === 'hidden') && <CallDock floating />}
          <VoiceSetupHost />
          <Palette />
          <BetaNotice />
          <AnnouncementsHost signedIn={signedIn} />
          <ServerHoursNotice />
          <main className={`main ${route.name === 'settings' ? 'main-settings' : route.name === 'notes' ? 'main-notes' : route.name === 'messages' ? 'main-messages' : route.name === 'groups' ? 'main-groups' : route.name === 'ai' ? 'main-ai' : route.name === 'calendar' ? 'main-calendar' : ''}`}>
            <Screen key={route.name + ('id' in route ? route.id : '')} route={route} />
          </main>
        </div>
      </NavCtx.Provider>
    </TimerProvider>
  )
}

export function App() {
  return (
    <ToastProvider>
      <AccountGate>
        <MovedNotice />
        <SettingsProvider>
          <Shell />
        </SettingsProvider>
      </AccountGate>
    </ToastProvider>
  )
}
