import { DragEvent, useCallback, useRef, useState } from 'react'
import { useDismissable } from '../hooks/useDismissable'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { PaneId, TabItem } from '../stores/PaneTabStore'

export interface DraggingTabPayload {
  paneId: PaneId
  tabId: string
}

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
}

const TAB_DRAG_MIME = 'application/x-wiki-tab'

export function parseDraggingTabPayload(
  event: DragEvent,
  fallback: DraggingTabPayload | null
): DraggingTabPayload | null {
  try {
    const raw = event.dataTransfer?.getData(TAB_DRAG_MIME)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraggingTabPayload>
      if (
        (parsed.paneId === 'primary' || parsed.paneId === 'secondary') &&
        typeof parsed.tabId === 'string'
      ) {
        return { paneId: parsed.paneId, tabId: parsed.tabId }
      }
    }
  } catch {
    // Ignore malformed drag payload and fall back to in-memory dragging state
  }
  return fallback
}

interface PaneTabBarProps {
  paneId: PaneId
  tabs: readonly TabItem[]
  activeTabId: string | null
  buffers: DocumentBufferSnapshot
  draggingTab: DraggingTabPayload | null
  onDragStartTab: (payload: DraggingTabPayload) => void
  onDragEndTab: () => void
  onActivateTab: (paneId: PaneId, tabId: string) => void
  onCloseTab: (paneId: PaneId, tabId: string) => void
  onMoveTab: (
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number
  ) => void
  onDuplicateTab: (sourcePaneId: PaneId, tabId: string) => void
}

export function PaneTabBar({
  paneId,
  tabs,
  activeTabId,
  buffers,
  draggingTab,
  onDragStartTab,
  onDragEndTab,
  onActivateTab,
  onCloseTab,
  onMoveTab,
  onDuplicateTab
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
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const payload = parseDraggingTabPayload(event, draggingTab)
        if (!payload) return
        onMoveTab(payload.paneId, paneId, payload.tabId)
        onDragEndTab()
      }}
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
              onDragStartTab(payload)
            }}
            onDragEnd={onDragEndTab}
            onDragOver={(event) => {
              event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const payload = parseDraggingTabPayload(event, draggingTab)
              if (!payload) return
              onMoveTab(payload.paneId, paneId, payload.tabId, index)
              onDragEndTab()
            }}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
              }
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                event.stopPropagation()
                onCloseTab(paneId, tab.id)
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
              onClick={() => onActivateTab(paneId, tab.id)}
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
                onCloseTab(paneId, tab.id)
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
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              onMoveTab(paneId, otherPaneId, targetTabId)
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
              onDuplicateTab(paneId, targetTabId)
            }}
          >
            분할 영역에 복제 열기
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item is-danger"
            onClick={() => {
              const targetTabId = contextMenu.tabId
              setContextMenu(null)
              onCloseTab(paneId, targetTabId)
            }}
          >
            닫기
          </button>
        </div>
      )}
    </div>
  )
}
