import { useCallback, useRef, useState } from 'react'
import { useDismissable } from '../hooks/useDismissable'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { PaneId, TabItem } from '../stores/PaneTabStore'
import {
  allowWikiTabDragOver,
  extractDragEndScreenPoint,
  handleTabMoveDrop,
  type PaneInteractionActions,
  type TabDragUiState,
  writeTabDragDataTransfer
} from '../stores/tabDragDrop'

interface TabContextMenuState {
  tabId: string
  x: number
  y: number
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
        handleTabMoveDrop(event, dragState, paneId, actions, { stopPropagation: true })
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
              writeTabDragDataTransfer(event, { paneId, tabId: tab.id })
              actions.onStartTabDrag(paneId, tab.id)
            }}
            onDragEnd={(event) => actions.onEndTabDrag(extractDragEndScreenPoint(event))}
            onDragOver={(event) => allowWikiTabDragOver(event, dragState)}
            onDrop={(event) =>
              handleTabMoveDrop(event, dragState, paneId, actions, {
                targetIndex: index,
                stopPropagation: true
              })
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
