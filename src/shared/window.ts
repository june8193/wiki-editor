import type { ThemeMode } from './config'
import type { DocumentBuffer } from './documentBuffer'
import type { GitDiffRequest, GitDiffViewMode } from './git'
import type { GitBlobSnapshotRequest } from './symbol'

export type WindowRole = 'main' | 'auxiliary'

export const MAIN_WINDOW_DEFAULT_WIDTH = 1280
export const MAIN_WINDOW_DEFAULT_HEIGHT = 820
export const MAIN_WINDOW_MIN_WIDTH = 900
export const MAIN_WINDOW_MIN_HEIGHT = 600

export const AUXILIARY_WINDOW_DEFAULT_WIDTH = 960
export const AUXILIARY_WINDOW_DEFAULT_HEIGHT = 760
export const AUXILIARY_WINDOW_MIN_WIDTH = 520
export const AUXILIARY_WINDOW_MIN_HEIGHT = 420
export const WINDOW_OFFSET_X = 40
export const WINDOW_OFFSET_Y = 40
export const AUXILIARY_WINDOW_OFFSET_X = WINDOW_OFFSET_X
export const AUXILIARY_WINDOW_OFFSET_Y = WINDOW_OFFSET_Y

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

function computeAnchoredWindowBounds(
  anchorPoint: ScreenPoint,
  size: { width: number; height: number },
  screenLike?: ScreenLike
): WindowBounds {
  const x = Math.round(anchorPoint.x)
  const y = Math.round(anchorPoint.y)
  const candidate: WindowBounds = {
    x,
    y,
    width: size.width,
    height: size.height
  }

  if (!screenLike) {
    return candidate
  }

  const { workArea } = screenLike.getDisplayNearestPoint({ x, y })
  return clampWindowBoundsToWorkArea(candidate, workArea)
}

function computeOffsetWindowBounds(
  sourceBounds: WindowBounds,
  size: { width: number; height: number },
  screenLike?: ScreenLike
): WindowBounds {
  return computeAnchoredWindowBounds(
    {
      x: sourceBounds.x + WINDOW_OFFSET_X,
      y: sourceBounds.y + WINDOW_OFFSET_Y
    },
    size,
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
  return computeAnchoredWindowBounds(
    cursorPoint,
    { width: AUXILIARY_WINDOW_DEFAULT_WIDTH, height: AUXILIARY_WINDOW_DEFAULT_HEIGHT },
    screenLike
  )
}

/**
 * Computes auxiliary window bounds offset by (+40, +40) from source window and clamped to display workArea.
 */
export function computeOffsetAuxiliaryBounds(
  sourceBounds: WindowBounds,
  screenLike?: ScreenLike
): WindowBounds {
  return computeOffsetWindowBounds(
    sourceBounds,
    { width: AUXILIARY_WINDOW_DEFAULT_WIDTH, height: AUXILIARY_WINDOW_DEFAULT_HEIGHT },
    screenLike
  )
}

/**
 * Computes main window bounds offset by (+40, +40) from source window at default 1280x820 and clamped to display workArea.
 */
export function computeOffsetMainBounds(
  sourceBounds: WindowBounds,
  screenLike?: ScreenLike
): WindowBounds {
  return computeOffsetWindowBounds(
    sourceBounds,
    { width: MAIN_WINDOW_DEFAULT_WIDTH, height: MAIN_WINDOW_DEFAULT_HEIGHT },
    screenLike
  )
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

export type EditorMode = 'raw' | 'preview' | 'wysiwyg' | 'split'
export type SplitMode = 'single' | 'horizontal' | 'vertical'
export type SplitDirection = Exclude<SplitMode, 'single'>

export const DEFAULT_SPLIT_RATIO = 0.5
export const MIN_SPLIT_RATIO = 0.15
export const MAX_SPLIT_RATIO = 0.85

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

/**
 * Rounds split ratios to 4 decimals so repeated steps avoid IEEE-754 float drift.
 */
export function roundSplitRatio(ratio: number): number {
  return Math.round(ratio * 10000) / 10000
}

/**
 * Clamps and rounds a split ratio to the allowed `[0.15, 0.85]` interval.
 */
export function normalizeSplitRatio(ratio: number): number {
  return roundSplitRatio(clampSplitRatio(ratio))
}

export interface CursorPosition {
  selectionStart: number
  selectionEnd: number
}

export interface TabViewState {
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
  splitPreviewRatio?: number
}

export interface TabTransferDiffState {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
  workspaceRootPath?: string
}

export interface DocumentTabTransferPayload extends TabViewState {
  kind?: 'document'
  bufferKey: string
}

export interface DiffTabTransferPayload {
  kind: 'diff'
  diff: TabTransferDiffState
}

export interface TabTransferSnapshotState {
  request: GitBlobSnapshotRequest
  scrollTop: number
  workspaceRootPath?: string
}

export interface SnapshotTabTransferPayload {
  kind: 'snapshot'
  snapshot: TabTransferSnapshotState
}

export type TabTransferPayload =
  | DocumentTabTransferPayload
  | DiffTabTransferPayload
  | SnapshotTabTransferPayload

export function isDiffTabTransferPayload(
  payload: TabTransferPayload | undefined | null
): payload is DiffTabTransferPayload {
  return Boolean(payload && payload.kind === 'diff' && payload.diff)
}

export function isSnapshotTabTransferPayload(
  payload: TabTransferPayload | undefined | null
): payload is SnapshotTabTransferPayload {
  return Boolean(payload && payload.kind === 'snapshot' && payload.snapshot)
}

export function isVirtualTabTransferPayload(
  payload: TabTransferPayload | undefined | null
): payload is DiffTabTransferPayload | SnapshotTabTransferPayload {
  return isDiffTabTransferPayload(payload) || isSnapshotTabTransferPayload(payload)
}

export function cloneTabTransferDiffState(
  diff: TabTransferDiffState,
  workspaceRootPathOverride?: string
): TabTransferDiffState {
  const workspaceRootPath = diff.workspaceRootPath ?? workspaceRootPathOverride
  return {
    request: { ...diff.request },
    viewMode: diff.viewMode,
    ...(workspaceRootPath ? { workspaceRootPath } : {})
  }
}

export function cloneTabTransferSnapshotState(
  snapshot: TabTransferSnapshotState,
  workspaceRootPathOverride?: string
): TabTransferSnapshotState {
  const workspaceRootPath = snapshot.workspaceRootPath ?? workspaceRootPathOverride
  return {
    request: {
      ...snapshot.request,
      scope: { ...snapshot.request.scope }
    },
    scrollTop: snapshot.scrollTop,
    ...(workspaceRootPath ? { workspaceRootPath } : {})
  }
}

export function extractTabViewState(source: TabViewState): TabViewState {
  return {
    mode: source.mode,
    cursor: { ...source.cursor },
    scrollTop: source.scrollTop,
    ...(typeof source.splitPreviewRatio === 'number'
      ? { splitPreviewRatio: source.splitPreviewRatio }
      : {})
  }
}

export function toTabTransferPayload(
  source:
    | TabTransferPayload
    | ({ kind?: 'document'; bufferKey: string } & TabViewState)
    | { kind: 'diff'; diff: TabTransferDiffState }
    | { kind: 'snapshot'; snapshot: TabTransferSnapshotState }
): TabTransferPayload {
  if (source.kind === 'diff' && source.diff) {
    return {
      kind: 'diff',
      diff: cloneTabTransferDiffState(source.diff)
    }
  }
  if (source.kind === 'snapshot' && source.snapshot) {
    return {
      kind: 'snapshot',
      snapshot: cloneTabTransferSnapshotState(source.snapshot)
    }
  }
  const docSource = source as DocumentTabTransferPayload
  return {
    bufferKey: docSource.bufferKey,
    ...extractTabViewState(docSource)
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
  initialWorkspacePath?: string | null
  appVersion?: string
}

/**
 * Creates a single-flight loader around `getInitContext` so window initialization and
 * buffer sync share at most one request per window startup.
 */
export function createWindowInitContextLoader(
  windowApi?: { getInitContext?: () => Promise<WindowInitContext> }
): () => Promise<WindowInitContext | null> {
  let cachedPromise: Promise<WindowInitContext | null> | null = null
  return () => {
    const getInitContext = windowApi?.getInitContext
    if (!getInitContext) {
      return Promise.resolve(null)
    }
    if (!cachedPromise) {
      cachedPromise = getInitContext.call(windowApi).catch(() => null)
    }
    return cachedPromise
  }
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
  /** Target IPC window id assigned once a cross-window drop is accepted. */
  targetWindowId?: number
  paneId: PaneId
  tabId: string
  payload: TabTransferPayload
  outcome: TabDragOutcome
}

export interface AcceptTabDragDropInput {
  dragSessionId?: string
}

export type AcceptTabDragDropRejectReason =
  | 'invalid-target-window'
  | 'no-active-drag'
  | 'drag-not-pending'
  | 'session-mismatch'
  | 'different-workspace-session'
  | 'same-window'
  | 'unknown-buffer'

export type AcceptTabDragDropResult =
  | {
      accepted: true
      dragSessionId: string
      sourceWindowId: number
      targetWindowId: number
      payload: TabTransferPayload
      buffer?: DocumentBuffer
    }
  | {
      accepted: false
      reason: AcceptTabDragDropRejectReason
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
export const TITLE_BAR_HEIGHT = 32

export interface TitleBarOverlayOptions {
  color: string
  symbolColor: string
  height: number
}

/**
 * Returns Windows titleBarOverlay colors matched to the active application theme.
 */
export function getTitleBarOverlayOptions(theme: ThemeMode = 'light'): TitleBarOverlayOptions {
  if (theme === 'dark') {
    return {
      color: '#21262d',
      symbolColor: '#e6edf3',
      height: TITLE_BAR_HEIGHT
    }
  }
  return {
    color: '#f0f3f7',
    symbolColor: '#1f2328',
    height: TITLE_BAR_HEIGHT
  }
}

/**
 * Formats the base application title with an optional normalized version suffix (`Wiki Editor vX.Y.Z`).
 */
export function formatBaseWindowTitle(appVersion?: string | null): string {
  const normalized = appVersion?.trim().replace(/^[vV]/, '')
  return normalized ? `${WINDOW_BASE_TITLE} v${normalized}` : WINDOW_BASE_TITLE
}

/**
 * Formats an OS/title-bar window title from optional active document name, workspace name, and version.
 */
export function formatWindowTitle(
  activeDocumentName?: string | null,
  appVersion?: string | null,
  workspaceName?: string | null
): string {
  const segments = [
    activeDocumentName?.trim(),
    workspaceName?.trim(),
    formatBaseWindowTitle(appVersion)
  ].filter((segment): segment is string => Boolean(segment))
  return segments.join(' - ')
}
