import { useRef, useState } from 'react'
import type { CustomCommandConfig, ThemeMode } from '@shared/config'
import { DocumentBufferSnapshot } from '../stores/DocumentBufferStore'
import { canSplitWithTab, PaneId, PaneLayoutState, SplitDirection } from '../stores/PaneTabStore'
import type { OutlineScrollRequest } from './DocumentEditor'
import { dispatchTabDrop, DraggingTabPayload, PaneInteractionActions } from './PaneTabBar'
import { PaneView } from './PaneView'
import { SplitSplitter } from './SplitSplitter'

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
  const containerRef = useRef<HTMLDivElement | null>(null)

  const clearDragging = (): void => setDraggingTab(null)
  const isSplit = layout.splitMode !== 'single'
  const canDropToSplit = draggingTab !== null && canSplitWithTab(layout)
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

      {layout.splitMode !== 'single' && (
        <>
          <SplitSplitter
            containerRef={containerRef}
            direction={layout.splitMode}
            ratio={layout.splitRatio}
            ariaLabel="화면 분할 크기 조절"
            onChangeRatio={onSetSplitRatio}
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
