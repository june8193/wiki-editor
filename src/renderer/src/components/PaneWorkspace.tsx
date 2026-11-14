import { KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { PaneId, PaneLayoutState, SplitDirection } from '../stores/PaneTabStore'
import type { OutlineScrollRequest } from './DocumentEditor'
import { dispatchTabDrop, DraggingTabPayload, PaneInteractionActions } from './PaneTabBar'
import { PaneView } from './PaneView'

interface PaneWorkspaceProps {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  theme: ThemeMode
  autoSave: boolean
  showHeadingNumbers?: boolean
  customCommands?: readonly CustomCommandConfig[]
  scrollRequest?: OutlineScrollRequest | null
  isShortcutDisabled?: boolean
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
  onSetSplitRatio,
  onSplitWithTab,
  actions
}: PaneWorkspaceProps) {
  const [draggingTab, setDraggingTab] = useState<DraggingTabPayload | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

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

  const clearDragging = (): void => setDraggingTab(null)
  const isSplit = layout.splitMode !== 'single'
  const canDropToSplit =
    draggingTab !== null &&
    (layout.panes.primary.tabs.length > 1 || (isSplit && layout.panes.secondary.tabs.length > 0))
  const visibleDropZones = canDropToSplit
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
    onDragStartTab: setDraggingTab,
    onDragEndTab: clearDragging,
    actions
  }

  return (
    <div
      ref={containerRef}
      className={`pane-workspace is-${layout.splitMode}`}
      data-testid="pane-workspace"
      data-split-mode={layout.splitMode}
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
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) =>
            dispatchTabDrop(
              event,
              draggingTab,
              clearDragging,
              (payload) => onSplitWithTab(payload.paneId, payload.tabId, zone.direction),
              { stopPropagation: true }
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
