export type WindowRole = 'main' | 'auxiliary'

export const AUXILIARY_WINDOW_DEFAULT_WIDTH = 960
export const AUXILIARY_WINDOW_DEFAULT_HEIGHT = 760
export const AUXILIARY_WINDOW_MIN_WIDTH = 520
export const AUXILIARY_WINDOW_MIN_HEIGHT = 420
export const AUXILIARY_WINDOW_OFFSET_X = 40
export const AUXILIARY_WINDOW_OFFSET_Y = 40

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface ScreenLike {
  getDisplayNearestPoint: (point: ScreenPoint) => { workArea: WindowBounds }
  getCursorScreenPoint?: () => ScreenPoint
}

/**
 * Clamps candidate window bounds so the entire window stays inside the target display workArea.
 */
export function clampWindowBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: WindowBounds
): WindowBounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height

  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
    width,
    height
  }
}

function computeClampedAuxiliaryBounds(
  anchor: ScreenPoint,
  screenLike?: ScreenLike
): WindowBounds {
  const x = Math.round(anchor.x)
  const y = Math.round(anchor.y)
  const candidate: WindowBounds = {
    x,
    y,
    width: AUXILIARY_WINDOW_DEFAULT_WIDTH,
    height: AUXILIARY_WINDOW_DEFAULT_HEIGHT
  }

  if (!screenLike) {
    return candidate
  }

  const { workArea } = screenLike.getDisplayNearestPoint({ x, y })
  return clampWindowBoundsToWorkArea(candidate, workArea)
}

/**
 * Computes auxiliary window bounds offset by (+40, +40) from source window and clamped to display workArea.
 */
export function computeOffsetAuxiliaryBounds(
  sourceBounds: WindowBounds,
  screenLike?: ScreenLike
): WindowBounds {
  return computeClampedAuxiliaryBounds(
    {
      x: sourceBounds.x + AUXILIARY_WINDOW_OFFSET_X,
      y: sourceBounds.y + AUXILIARY_WINDOW_OFFSET_Y
    },
    screenLike
  )
}

/**
 * Computes auxiliary window bounds anchored at the drop cursor position and clamped to target display workArea.
 */
export function computeCursorAuxiliaryBounds(
  cursorPoint: ScreenPoint,
  screenLike?: ScreenLike
): WindowBounds {
  return computeClampedAuxiliaryBounds(cursorPoint, screenLike)
}

/**
 * Returns whether a screen coordinate falls inside a window's half-open outer bounds rectangle.
 */
export function isPointInsideWindowBounds(point: ScreenPoint, bounds: WindowBounds): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return false
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    return false
  }
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  )
}

/**
 * Returns whether a finite screen coordinate lies outside every open application window's outer bounds.
 */
export function isPointOutsideAllWindows(
  point: ScreenPoint,
  windowBoundsList: Iterable<WindowBounds>
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return false
  }
  for (const bounds of windowBoundsList) {
    if (isPointInsideWindowBounds(point, bounds)) {
      return false
    }
  }
  return true
}

export const WINDOW_ROLE_QUERY_PARAM = 'windowRole'

export function resolveWindowRole(rawRole?: string | null): WindowRole {
  return rawRole === 'auxiliary' ? 'auxiliary' : 'main'
}

export function canDetachTabFromWindow(
  role: WindowRole | undefined,
  totalTabCount: number
): boolean {
  return role !== 'auxiliary' || totalTabCount > 1
}

export type EditorMode = 'raw' | 'preview' | 'wysiwyg'

export interface CursorPosition {
  selectionStart: number
  selectionEnd: number
}

export interface TabViewState {
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
}

export interface TabTransferPayload extends TabViewState {
  bufferKey: string
}

export function extractTabViewState(source: TabViewState): TabViewState {
  return {
    mode: source.mode,
    cursor: { ...source.cursor },
    scrollTop: source.scrollTop
  }
}

export function toTabTransferPayload(
  source: { bufferKey: string } & TabViewState
): TabTransferPayload {
  return {
    bufferKey: source.bufferKey,
    ...extractTabViewState(source)
  }
}

export function cloneTabTransferPayloads(
  tabs: readonly TabTransferPayload[]
): TabTransferPayload[] {
  return tabs.map(toTabTransferPayload)
}

export interface WindowInitContext {
  role: WindowRole
  initialTabs: TabTransferPayload[]
}

export interface DetachTabToNewWindowResult {
  /** Hub/IPC window identifier (webContents.id) assigned to the detached auxiliary window. */
  windowId: number
}

export type PaneId = 'primary' | 'secondary'

export type TabDragOutcome = 'pending' | 'dropped-in-window' | 'cancelled'
export type TabDragResolution = Exclude<TabDragOutcome, 'pending'>

export interface TabDragStartInput {
  paneId: PaneId
  tabId: string
  payload: TabTransferPayload
}

export interface ActiveTabDragSession {
  dragSessionId: string
  sourceWindowId: number
  paneId: PaneId
  tabId: string
  payload: TabTransferPayload
  outcome: TabDragOutcome
}

export interface TabDragEndInput {
  dragSessionId: string
  screenPoint?: ScreenPoint
  payload?: TabTransferPayload
}

export type TabDragEndResult =
  | {
      detached: true
      windowId: number
    }
  | {
      detached: false
      outcome: TabDragResolution
    }

export const WINDOW_BASE_TITLE = 'Wiki Editor'

/**
 * Formats an OS window title from the active document display name.
 */
export function formatWindowTitle(activeDocumentName?: string | null): string {
  const trimmed = activeDocumentName?.trim()
  return trimmed ? `${trimmed} - ${WINDOW_BASE_TITLE}` : WINDOW_BASE_TITLE
}
