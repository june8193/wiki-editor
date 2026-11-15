import type { DragEvent } from 'react'
import type { ActiveTabDragSession, PaneId, ScreenPoint } from '@shared/window'
import type { TransferredTabDropTarget } from './PaneTabStore'

export interface DraggingTabPayload {
  paneId: PaneId
  tabId: string
}

export interface TabDragUiState {
  draggingTab: DraggingTabPayload | null
  externalDragSession: ActiveTabDragSession | null
}

export const EMPTY_TAB_DRAG_STATE: TabDragUiState = {
  draggingTab: null,
  externalDragSession: null
}

export interface TabDragDropActions {
  onMoveTab: (
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number
  ) => void
  onDropExternalTab?: (target: TransferredTabDropTarget, dragSessionId?: string) => void
  onDropTabInWindow: () => void
}

export interface TabDropAcceptOptions {
  canAcceptExternal?: boolean
  ignoreSamePane?: boolean
}

export interface TabDropMoveOptions extends TabDropAcceptOptions {
  targetIndex?: number
  stopPropagation?: boolean
}

const TAB_DRAG_MIME = 'application/x-wiki-tab'

function hasWikiTabDragMime(dataTransfer: DataTransfer | null | undefined): boolean {
  const types = dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === TAB_DRAG_MIME) return true
  }
  return false
}

export function writeTabDragDataTransfer(event: DragEvent, payload: DraggingTabPayload): void {
  try {
    event.dataTransfer?.setData(TAB_DRAG_MIME, JSON.stringify(payload))
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
    }
  } catch {
    // jsdom environments without DataTransfer still track via draggingTab state
  }
}

export function extractDragEndScreenPoint(event: DragEvent): ScreenPoint | undefined {
  return Number.isFinite(event.screenX) && Number.isFinite(event.screenY)
    ? { x: event.screenX, y: event.screenY }
    : undefined
}

export function isExternalTabDragEvent(
  event: DragEvent,
  dragState: TabDragUiState
): boolean {
  if (dragState.draggingTab !== null) {
    return false
  }
  return dragState.externalDragSession != null || hasWikiTabDragMime(event.dataTransfer)
}

export function canAcceptWikiTabDrop(
  event: DragEvent,
  dragState: TabDragUiState,
  targetPaneId?: PaneId,
  options?: TabDropAcceptOptions
): boolean {
  if (dragState.draggingTab !== null) {
    return !(options?.ignoreSamePane && targetPaneId && dragState.draggingTab.paneId === targetPaneId)
  }
  if (options?.canAcceptExternal === false) {
    return false
  }
  return isExternalTabDragEvent(event, dragState)
}

export function allowWikiTabDragOver(
  event: DragEvent,
  dragState: TabDragUiState,
  targetPaneId?: PaneId,
  options?: TabDropAcceptOptions
): void {
  if (canAcceptWikiTabDrop(event, dragState, targetPaneId, options)) {
    event.preventDefault()
  }
}

export function parseDraggingTabPayload(
  event: DragEvent,
  fallback: DraggingTabPayload | null
): DraggingTabPayload | null {
  try {
    const raw = event.dataTransfer?.getData(TAB_DRAG_MIME)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraggingTabPayload>
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.paneId === 'primary' || parsed.paneId === 'secondary') &&
        typeof parsed.tabId === 'string'
      ) {
        return { paneId: parsed.paneId, tabId: parsed.tabId }
      }
    }
  } catch {
    // Ignore malformed or restricted DataTransfer payloads and fall back cleanly
  }
  return fallback
}

export function dispatchTabDrop(
  event: DragEvent,
  dragState: TabDragUiState,
  dropTarget: TransferredTabDropTarget,
  actions: Pick<TabDragDropActions, 'onDropTabInWindow' | 'onDropExternalTab'>,
  onLocalDrop: (payload: DraggingTabPayload) => void,
  options?: TabDropAcceptOptions & { stopPropagation?: boolean }
): void {
  const executeDrop = (commit: () => void): void => {
    event.preventDefault()
    if (options?.stopPropagation) {
      event.stopPropagation()
    }
    commit()
  }

  if (isExternalTabDragEvent(event, dragState)) {
    if (!actions.onDropExternalTab || options?.canAcceptExternal === false) {
      return
    }
    const dragSessionId = dragState.externalDragSession?.dragSessionId
    executeDrop(() => actions.onDropExternalTab?.(dropTarget, dragSessionId))
    return
  }

  const payload = parseDraggingTabPayload(event, dragState.draggingTab)
  if (!payload) return
  if (options?.ignoreSamePane && dropTarget.kind === 'pane' && payload.paneId === dropTarget.paneId) {
    return
  }
  executeDrop(() => {
    onLocalDrop(payload)
    actions.onDropTabInWindow()
  })
}

export function handleTabMoveDrop(
  event: DragEvent,
  dragState: TabDragUiState,
  targetPaneId: PaneId,
  actions: TabDragDropActions,
  options?: TabDropMoveOptions
): void {
  dispatchTabDrop(
    event,
    dragState,
    { kind: 'pane', paneId: targetPaneId, targetIndex: options?.targetIndex },
    actions,
    (payload) => actions.onMoveTab(payload.paneId, targetPaneId, payload.tabId, options?.targetIndex),
    options
  )
}
