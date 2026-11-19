import type { SidebarMode } from './settings'

export const SIDEBAR_DEFAULT_WIDTH = 224
export const SIDEBAR_MIN_WIDTH = 176
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_ICONS_WIDTH = 64
export const SIDEBAR_COLLAPSE_THRESHOLD = 128
export const SIDEBAR_EXPAND_THRESHOLD = 136

/** Clamps a desktop sidebar width into the comfortable resizable range. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
}

export interface SidebarDragOutcome {
  mode: SidebarMode
  width: number
  /** Visual width to render while dragging (64 when snapped to icons, otherwise clamped full width). */
  visualWidth: number
}

/**
 * Resolves Zen Browser–style sidebar edge dragging:
 * - Dragging a full sidebar narrower than SIDEBAR_COLLAPSE_THRESHOLD snaps into icons-only mode.
 * - Dragging an icons-only sidebar wider than SIDEBAR_EXPAND_THRESHOLD expands back to full mode.
 * - Dragging a hidden (floating) sidebar resizes its floating panel width without switching modes.
 */
export function resolveSidebarDrag(
  currentMode: SidebarMode,
  pointerWidth: number,
  lastFullWidth: number
): SidebarDragOutcome {
  const safeFull = clampSidebarWidth(lastFullWidth)
  if (currentMode === 'hidden') {
    const nextW = clampSidebarWidth(pointerWidth)
    return { mode: 'hidden', width: nextW, visualWidth: nextW }
  }
  if (currentMode === 'full') {
    if (pointerWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
      return { mode: 'icons', width: safeFull, visualWidth: SIDEBAR_ICONS_WIDTH }
    }
    const nextW = clampSidebarWidth(pointerWidth)
    return { mode: 'full', width: nextW, visualWidth: nextW }
  }
  // currentMode === 'icons'
  if (pointerWidth >= SIDEBAR_EXPAND_THRESHOLD) {
    const nextW = clampSidebarWidth(pointerWidth)
    return { mode: 'full', width: nextW, visualWidth: nextW }
  }
  return { mode: 'icons', width: safeFull, visualWidth: SIDEBAR_ICONS_WIDTH }
}
