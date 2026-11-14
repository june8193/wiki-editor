import { KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { PaneLayoutState } from '../stores/PaneTabStore'
import { DraggingTabPayload, handleTabDrop, PaneInteractionActions } from './PaneTabBar'
import { PaneView } from './PaneView'

interface PaneWorkspaceProps {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  theme: ThemeMode
  autoSave: boolean
  isShortcutDisabled?: boolean
  onSetSplitRatio: (ratio: number) => void
  actions: PaneInteractionActions
}

const KEYBOARD_RESIZE_STEP = 0.05

export function PaneWorkspace({
  layout,
  buffers,
  theme,
  autoSave,
  isShortcutDisabled = false,
  onSetSplitRatio,
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

  return (
    <div
      ref={containerRef}
      className={`pane-workspace is-${layout.splitMode}`}
      data-testid="pane-workspace"
      data-split-mode={layout.splitMode}
    >
      <PaneView
        pane={layout.panes.primary}
        splitMode={layout.splitMode}
        isActivePane={layout.activePaneId === 'primary'}
        flexRatio={isSplit ? layout.splitRatio : undefined}
        theme={theme}
        autoSave={autoSave}
        isShortcutDisabled={isShortcutDisabled}
        buffers={buffers}
        draggingTab={draggingTab}
        onDragStartTab={setDraggingTab}
        onDragEndTab={clearDragging}
        actions={actions}
      />

      {!isSplit && draggingTab && layout.panes.primary.tabs.length > 1 && (
        <div
          className="split-drop-zone"
          data-testid="split-drop-zone-secondary"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) =>
            handleTabDrop(event, draggingTab, 'secondary', actions.onMoveTab, clearDragging)
          }
        >
          <span>여기에 드롭하여 분할</span>
        </div>
      )}

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
            splitMode={layout.splitMode}
            isActivePane={layout.activePaneId === 'secondary'}
            flexRatio={1 - layout.splitRatio}
            theme={theme}
            autoSave={autoSave}
            isShortcutDisabled={isShortcutDisabled}
            buffers={buffers}
            draggingTab={draggingTab}
            onDragStartTab={setDraggingTab}
            onDragEndTab={clearDragging}
            actions={actions}
          />
        </>
      )}
    </div>
  )
}
