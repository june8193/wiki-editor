import { DragEvent, useCallback, useRef, useState } from 'react'
import { useDismissable } from '../hooks/useDismissable'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { ActiveTabDragSession, ScreenPoint } from '@shared/window'
import { PaneId, TabItem, TabViewPatch, type TransferredTabDropTarget } from '../stores/PaneTabStore'

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

export interface PaneInteractionActions {
  onFocusPane: (paneId: PaneId) => void
  onActivateTab: (paneId: PaneId, tabId: string) => void
  onCloseTab: (paneId: PaneId, tabId: string) => void
  onMoveTab: (
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number
  ) => void
  onDuplicateTab: (sourcePaneId: PaneId, tabId: string) => void
  onDetachTabToNewWindow?: (paneId: PaneId, tabId: string) => void
  onDropExternalTab?: (target: TransferredTabDropTarget, dragSessionId?: string) => void
  onStartTabDrag: (paneId: PaneId, tabId: string) => void
  onDropTabInWindow: () => void
  onCancelTabDrag: () => void
  onEndTabDrag: (screenPoint?: ScreenPoint) => void
  onChangeContent: (bufferKey: string, nextContent: string) => void
  onSaveBuffer: (bufferKey: string) => void
  onUpdateTabViewState: (paneId: PaneId, tabId: string, patch: TabViewPatch) => void
}

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
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

function readTabDragMimeJson(event: DragEvent): Record<string, unknown> | null {
  try {
    const raw = event.dataTransfer?.getData(TAB_DRAG_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
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

export function allowWikiTabDragOver(
  event: DragEvent,
  dragState: TabDragUiState
): void {
  if (dragState.draggingTab !== null || isExternalTabDragEvent(event, dragState)) {
    event.preventDefault()
  }
}

function resolveExternalDragSessionId(
  event: DragEvent,
  dragState: TabDragUiState
): string | undefined {
  if (dragState.externalDragSession?.dragSessionId) {
    return dragState.externalDragSession.dragSessionId
  }
  const parsed = readTabDragMimeJson(event)
  return typeof parsed?.dragSessionId === 'string' && parsed.dragSessionId
    ? parsed.dragSessionId
    : undefined
}

export function parseDraggingTabPayload(
  event: DragEvent,
  fallback: DraggingTabPayload | null
): DraggingTabPayload | null {
  const parsed = readTabDragMimeJson(event)
  if (
    parsed &&
    (parsed.paneId === 'primary' || parsed.paneId === 'secondary') &&
    typeof parsed.tabId === 'string'
  ) {
    return { paneId: parsed.paneId, tabId: parsed.tabId }
  }
  return fallback
}

export function dispatchTabDrop(
  event: DragEvent,
  dragState: TabDragUiState,
  onDropInWindow: () => void,
  onValidDrop: (payload: DraggingTabPayload) => void,
  options?: {
    shouldAcceptLocal?: (payload: DraggingTabPayload) => boolean
    canAcceptExternal?: boolean
    onExternalDrop?: (dragSessionId?: string) => void
    stopPropagation?: boolean
  }
): void {
  const executeDrop = (commit: () => void): void => {
    event.preventDefault()
    if (options?.stopPropagation) {
      event.stopPropagation()
    }
    commit()
  }

  if (isExternalTabDragEvent(event, dragState)) {
    if (!options?.onExternalDrop || options.canAcceptExternal === false) {
      return
    }
    const dragSessionId = resolveExternalDragSessionId(event, dragState)
    executeDrop(() => options.onExternalDrop?.(dragSessionId))
    return
  }

  const payload = parseDraggingTabPayload(event, dragState.draggingTab)
  if (!payload) return
  if (options?.shouldAcceptLocal && !options.shouldAcceptLocal(payload)) return
  executeDrop(() => {
    onValidDrop(payload)
    onDropInWindow()
  })
}

export function handleTabMoveDrop(
  event: DragEvent,
  dragState: TabDragUiState,
  onDropInWindow: () => void,
  targetPaneId: PaneId,
  onMoveTab: PaneInteractionActions['onMoveTab'],
  options?: {
    canAcceptExternal?: boolean
    onDropExternalTab?: PaneInteractionActions['onDropExternalTab']
    targetIndex?: number
    ignoreSamePane?: boolean
    stopPropagation?: boolean
  }
): void {
  dispatchTabDrop(
    event,
    dragState,
    onDropInWindow,
    (payload) => onMoveTab(payload.paneId, targetPaneId, payload.tabId, options?.targetIndex),
    {
      canAcceptExternal: options?.canAcceptExternal,
      onExternalDrop: options?.onDropExternalTab
        ? (dragSessionId) =>
            options.onDropExternalTab?.(
              { kind: 'pane', paneId: targetPaneId, targetIndex: options?.targetIndex },
              dragSessionId
            )
        : undefined,
      shouldAcceptLocal: options?.ignoreSamePane
        ? (payload) => payload.paneId !== targetPaneId
        : undefined,
      stopPropagation: options?.stopPropagation
    }
  )
}

function extractDragEndScreenPoint(event: DragEvent): ScreenPoint | undefined {
  return Number.isFinite(event.screenX) && Number.isFinite(event.screenY)
    ? { x: event.screenX, y: event.screenY }
    : undefined
}

interface PaneTabBarProps {
  paneId: PaneId
  tabs: readonly TabItem[]
  activeTabId: string | null
  canMoveToSplit: boolean
  buffers: DocumentBufferSnapshot
  dragState: TabDragUiState
  actions: Pick<
    PaneInteractionActions,
    | 'onActivateTab'
    | 'onCloseTab'
    | 'onMoveTab'
    | 'onDuplicateTab'
    | 'onDetachTabToNewWindow'
    | 'onDropExternalTab'
    | 'onStartTabDrag'
    | 'onDropTabInWindow'
    | 'onEndTabDrag'
  >
}

export function isPaneTabTriggerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.pane-tab-bar [role="tab"]') !== null
}

export function PaneTabBar({
  paneId,
  tabs,
  activeTabId,
  canMoveToSplit,
  buffers,
  dragState,
  actions
}: PaneTabBarProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const closeMenu = useCallback(() => setContextMenu(null), [])

  useDismissable(contextMenu !== null, menuRef, closeMenu)

  const otherPaneId: PaneId = paneId === 'primary' ? 'secondary' : 'primary'

  return (
    <div
      className="pane-tab-bar"
      role="tablist"
      aria-label={paneId === 'primary' ? '주 탭 목록' : '보조 탭 목록'}
      onDragOver={(event) => allowWikiTabDragOver(event, dragState)}
      onDrop={(event) =>
        handleTabMoveDrop(event, dragState, actions.onDropTabInWindow, paneId, actions.onMoveTab, {
          onDropExternalTab: actions.onDropExternalTab,
          stopPropagation: true
        })
      }
    >
      {tabs.map((tab, index) => {
        const buffer = buffers[tab.bufferKey]
        if (!buffer) return null
        const isActive = tab.id === activeTabId

        return (
          <div
            key={tab.id}
            className={`tab-item${isActive ? ' is-active' : ''}`}
            draggable
            onDragStart={(event) => {
              const payload: DraggingTabPayload = { paneId, tabId: tab.id }
              try {
                event.dataTransfer?.setData(TAB_DRAG_MIME, JSON.stringify(payload))
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move'
                }
              } catch {
                // jsdom environments without DataTransfer still track via draggingTab state
              }
              actions.onStartTabDrag(paneId, tab.id)
            }}
            onDragEnd={(event) => actions.onEndTabDrag(extractDragEndScreenPoint(event))}
            onDragOver={(event) => allowWikiTabDragOver(event, dragState)}
            onDrop={(event) =>
              handleTabMoveDrop(
                event,
                dragState,
                actions.onDropTabInWindow,
                paneId,
                actions.onMoveTab,
                {
                  onDropExternalTab: actions.onDropExternalTab,
                  targetIndex: index,
                  stopPropagation: true
                }
              )
            }
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
              }
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                event.stopPropagation()
                actions.onCloseTab(paneId, tab.id)
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className="tab-trigger"
              title={buffer.path}
              onClick={() => actions.onActivateTab(paneId, tab.id)}
            >
              <span className="tab-label">{buffer.name}</span>
              {buffer.isDirty && (
                <span
                  className="tab-dirty-dot"
                  data-testid="tab-dirty-indicator"
                  aria-label="저장되지 않은 변경 사항"
                >
                  ●
                </span>
              )}
            </button>
            <button
              type="button"
              className="tab-close-btn"
              aria-label={`${buffer.name} 탭 닫기`}
              onClick={(event) => {
                event.stopPropagation()
                actions.onCloseTab(paneId, tab.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}

      {contextMenu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="탭 작업 메뉴"
          className="tree-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!canMoveToSplit}
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              actions.onMoveTab(paneId, otherPaneId, targetTabId)
            }}
          >
            분할 영역으로 이동
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              actions.onDuplicateTab(paneId, targetTabId)
            }}
          >
            분할 영역에 복제 열기
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={!actions.onDetachTabToNewWindow}
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              actions.onDetachTabToNewWindow?.(paneId, targetTabId)
            }}
          >
            새 창으로 이동
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item is-danger"
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              actions.onCloseTab(paneId, targetTabId)
            }}
          >
            닫기
          </button>
        </div>
      )}
    </div>
  )
}
