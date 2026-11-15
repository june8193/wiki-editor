import { DragEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { ActiveTabDragSession } from '@shared/window'
import {
  canAcceptIncomingSplitDrop,
  canSplitWithTab,
  PaneId,
  PaneLayoutState,
  SplitDirection
} from '../stores/PaneTabStore'
import type { OutlineScrollRequest } from './DocumentEditor'
import {
  dispatchTabDrop,
  DraggingTabPayload,
  isExternalTabDragEvent,
  isWikiTabDragActive,
  PaneInteractionActions
} from './PaneTabBar'
import { PaneView } from './PaneView'

export interface PaneWorkspaceProps {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers?: boolean
  customCommands?: readonly CustomCommandConfig[]
  scrollRequest?: OutlineScrollRequest | null
  isShortcutDisabled?: boolean
  draggingTab: DraggingTabPayload | null
  externalDragSession?: ActiveTabDragSession | null
  onSetSplitRatio: (ratio: number) => void
  onSplitWithTab: (sourcePaneId: PaneId, tabId: string, splitDirection: SplitDirection) => void
  actions: PaneInteractionActions
}

const KEYBOARD_RESIZE_STEP = 0.05

const SPLIT_DROP_ZONES: ReadonlyArray<{
  direction: SplitDirection
  testId: string
  label: string
}> = [
  { direction: 'horizontal', testId: 'split-drop-zone-horizontal', label: '여기에 드롭하여 좌우 분할' },
  { direction: 'vertical', testId: 'split-drop-zone-vertical', label: '여기에 드롭하여 상하 분할' }
]

export function PaneWorkspace({
  layout,
  buffers,
  theme,
  autoSave,
  showHeadingNumbers = true,
  customCommands,
  scrollRequest = null,
  isShortcutDisabled = false,
  draggingTab,
  externalDragSession = null,
  onSetSplitRatio,
  onSplitWithTab,
  actions
}: PaneWorkspaceProps) {
  const [isResizing, setIsResizing] = useState(false)
  const [isExternalDragOver, setIsExternalDragOver] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const externalDragDepthRef = useRef(0)
  const prevExternalSessionRef = useRef<ActiveTabDragSession | null>(externalDragSession)

  useEffect(() => {
    if (!isResizing) return

    const handleMove = (event: MouseEvent): void => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (layout.splitMode === 'horizontal' && rect.width > 0) {
        onSetSplitRatio((event.clientX - rect.left) / rect.width)
      } else if (layout.splitMode === 'vertical' && rect.height > 0) {
        onSetSplitRatio((event.clientY - rect.top) / rect.height)
      }
    }

    const handleUp = (): void => {
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('blur', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('blur', handleUp)
    }
  }, [isResizing, layout.splitMode, onSetSplitRatio])

  const handleSplitterKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const isHorizontal = layout.splitMode === 'horizontal'
    const decKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
    const incKey = isHorizontal ? 'ArrowRight' : 'ArrowDown'

    if (event.key === decKey) {
      event.preventDefault()
      onSetSplitRatio(layout.splitRatio - KEYBOARD_RESIZE_STEP)
    } else if (event.key === incKey) {
      event.preventDefault()
      onSetSplitRatio(layout.splitRatio + KEYBOARD_RESIZE_STEP)
    }
  }

  const hasDraggingTab = draggingTab !== null

  useEffect(() => {
    if (!hasDraggingTab) return
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      actions.onCancelTabDrag()
    }
    window.addEventListener('keydown', handleWindowKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true)
    }
  }, [hasDraggingTab, actions])

  useEffect(() => {
    const prevSession = prevExternalSessionRef.current
    prevExternalSessionRef.current = externalDragSession
    if (draggingTab !== null || (prevSession !== null && externalDragSession === null)) {
      externalDragDepthRef.current = 0
      setIsExternalDragOver(false)
    }
  }, [draggingTab, externalDragSession])

  const resetExternalDragHover = (): void => {
    externalDragDepthRef.current = 0
    setIsExternalDragOver(false)
  }

  const handleWorkspaceDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!isExternalTabDragEvent(event, draggingTab, externalDragSession)) return
    externalDragDepthRef.current += 1
    if (!isExternalDragOver) {
      setIsExternalDragOver(true)
    }
  }

  const handleWorkspaceDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!isExternalTabDragEvent(event, draggingTab, externalDragSession)) return
    if (externalDragDepthRef.current === 0) {
      externalDragDepthRef.current = 1
    }
    if (!isExternalDragOver) {
      setIsExternalDragOver(true)
    }
  }

  const handleWorkspaceDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node) {
      if (event.currentTarget.contains(nextTarget)) {
        externalDragDepthRef.current = Math.max(1, externalDragDepthRef.current - 1)
        return
      }
      resetExternalDragHover()
      return
    }
    externalDragDepthRef.current = Math.max(0, externalDragDepthRef.current - 1)
    if (externalDragDepthRef.current === 0) {
      setIsExternalDragOver(false)
    }
  }

  const isSplit = layout.splitMode !== 'single'
  const canDropLocalToSplit = draggingTab !== null && canSplitWithTab(layout)
  const canDropExternalToSplit =
    draggingTab === null && isExternalDragOver && canAcceptIncomingSplitDrop(layout)
  const visibleDropZones =
    canDropLocalToSplit || canDropExternalToSplit
      ? SPLIT_DROP_ZONES.filter((zone) => zone.direction !== layout.splitMode)
      : []
  const sharedPaneProps = {
    splitMode: layout.splitMode,
    theme,
    autoSave,
    showHeadingNumbers,
    customCommands,
    scrollRequest,
    isShortcutDisabled,
    buffers,
    draggingTab,
    externalDragSession,
    actions
  }

  return (
    <div
      ref={containerRef}
      className={`pane-workspace is-${layout.splitMode}`}
      data-testid="pane-workspace"
      data-split-mode={layout.splitMode}
      onDragEnter={handleWorkspaceDragEnter}
      onDragOver={handleWorkspaceDragOver}
      onDragLeave={handleWorkspaceDragLeave}
      onDropCapture={resetExternalDragHover}
    >
      <PaneView
        pane={layout.panes.primary}
        isActivePane={layout.activePaneId === 'primary'}
        flexRatio={isSplit ? layout.splitRatio : undefined}
        {...sharedPaneProps}
      />

      {visibleDropZones.map((zone) => (
        <div
          key={zone.direction}
          className={`split-drop-zone is-${zone.direction}`}
          data-testid={zone.testId}
          aria-label={zone.label}
          onDragOver={(event) => {
            if (isWikiTabDragActive(event, draggingTab, externalDragSession)) {
              event.preventDefault()
            }
          }}
          onDrop={(event) =>
            dispatchTabDrop(
              event,
              draggingTab,
              actions.onDropTabInWindow,
              (payload) => onSplitWithTab(payload.paneId, payload.tabId, zone.direction),
              {
                externalDragSession,
                onExternalDrop: actions.onDropExternalTab
                  ? (dragSessionId) =>
                      actions.onDropExternalTab?.(
                        { kind: 'split', direction: zone.direction },
                        dragSessionId
                      )
                  : undefined,
                stopPropagation: true
              }
            )
          }
        >
          <span>{zone.label}</span>
        </div>
      ))}

      {isSplit && (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-label="화면 분할 크기 조절"
            aria-orientation={layout.splitMode === 'horizontal' ? 'vertical' : 'horizontal'}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(layout.splitRatio * 100)}
            className={`split-divider is-${layout.splitMode}${isResizing ? ' is-dragging' : ''}`}
            onMouseDown={(event) => {
              event.preventDefault()
              setIsResizing(true)
            }}
            onKeyDown={handleSplitterKeyDown}
          />

          <PaneView
            pane={layout.panes.secondary}
            isActivePane={layout.activePaneId === 'secondary'}
            flexRatio={1 - layout.splitRatio}
            {...sharedPaneProps}
          />
        </>
      )}
    </div>
  )
}
