import { DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { ThemeMode } from '@shared/config'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { GitDiffRequest } from '@shared/git'
import type { DocumentSearchJumpRequest } from '@shared/search'
import type { ActiveTabDragSession } from '@shared/window'
import type { WorkspaceEntry } from '@shared/workspace'
import type { OutlineActiveHeadingReport, OutlineScrollRequest } from '../editor/outlineScrollSpy'
import type {
  PaneDiffJumpRequest,
  PaneHistoryAvailability,
  PaneSnapshotJumpRequest
} from '../stores/PaneNavigationCoordinator'
import {
  canAcceptIncomingSplitDrop,
  canSplitWithTab,
  PaneId,
  PaneLayoutState,
  SplitDirection
} from '../stores/PaneTabStore'
import {
  allowWikiTabDragOver,
  dispatchTabDrop,
  isExternalTabDragEvent,
  type TabDragUiState
} from '../stores/tabDragDrop'
import type { DocumentEditorFindControl } from './DocumentEditor'
import type { GitDiffContentState, GitDiffNavigationProps } from './GitDiffViewer'
import type { PaneInteractionActions } from './PaneTabBar'
import { PaneView } from './PaneView'
import type { SnapshotContentState } from './SnapshotViewer'
import { SplitSplitter } from './SplitSplitter'

export interface PaneWorkspaceProps {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  diffsByKey: Record<string, GitDiffContentState>
  snapshotsByKey?: Record<string, SnapshotContentState>
  getDiffNavigation?: (request: GitDiffRequest) => GitDiffNavigationProps | undefined
  theme: ThemeMode
  autoSave: boolean
  scrollRequest?: OutlineScrollRequest | null
  searchJumpRequest?: DocumentSearchJumpRequest | null
  diffJumpRequest?: PaneDiffJumpRequest | null
  snapshotJumpRequest?: PaneSnapshotJumpRequest | null
  historyByPane?: Record<PaneId, PaneHistoryAvailability>
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  dragState: TabDragUiState
  getPaneFindControl?: (paneId: PaneId) => DocumentEditorFindControl
  onSetSplitRatio: (ratio: number) => void
  onSplitWithTab: (sourcePaneId: PaneId, tabId: string, splitDirection: SplitDirection) => void
  onActiveHeadingChange?: (report: OutlineActiveHeadingReport) => void
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
  diffsByKey,
  snapshotsByKey,
  getDiffNavigation,
  theme,
  autoSave,
  scrollRequest = null,
  searchJumpRequest = null,
  diffJumpRequest = null,
  snapshotJumpRequest = null,
  historyByPane,
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  dragState,
  getPaneFindControl,
  onSetSplitRatio,
  onSplitWithTab,
  onActiveHeadingChange,
  actions
}: PaneWorkspaceProps) {
  const [isExternalDragOver, setIsExternalDragOver] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const externalDragDepthRef = useRef(0)
  const prevExternalSessionRef = useRef<ActiveTabDragSession | null>(dragState.externalDragSession)

  const hasDraggingTab = dragState.draggingTab !== null

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

  const resetExternalDragHover = useCallback((): void => {
    externalDragDepthRef.current = 0
    setIsExternalDragOver(false)
  }, [])

  useEffect(() => {
    const prevSession = prevExternalSessionRef.current
    prevExternalSessionRef.current = dragState.externalDragSession
    if (
      dragState.draggingTab !== null ||
      (prevSession !== null && dragState.externalDragSession === null)
    ) {
      resetExternalDragHover()
    }
  }, [dragState, resetExternalDragHover])

  const activateExternalDragHover = (
    event: DragEvent<HTMLDivElement>,
    incrementDepth: boolean
  ): void => {
    if (!isExternalTabDragEvent(event, dragState)) return
    externalDragDepthRef.current = incrementDepth
      ? externalDragDepthRef.current + 1
      : Math.max(1, externalDragDepthRef.current)
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
  const canDropLocalToSplit = dragState.draggingTab !== null && canSplitWithTab(layout)
  const canDropExternalToSplit =
    dragState.draggingTab === null && isExternalDragOver && canAcceptIncomingSplitDrop(layout)
  const visibleDropZones =
    canDropLocalToSplit || canDropExternalToSplit
      ? SPLIT_DROP_ZONES.filter((zone) => zone.direction !== layout.splitMode)
      : []
  const sharedPaneProps = {
    splitMode: layout.splitMode,
    theme,
    autoSave,
    scrollRequest,
    searchJumpRequest,
    diffJumpRequest,
    snapshotJumpRequest,
    isShortcutDisabled,
    workspaceMarkdownFiles,
    buffers,
    diffsByKey,
    snapshotsByKey,
    getDiffNavigation,
    dragState,
    onActiveHeadingChange,
    actions
  }

  return (
    <div
      ref={containerRef}
      className={`pane-workspace is-${layout.splitMode}`}
      data-testid="pane-workspace"
      data-split-mode={layout.splitMode}
      onDragEnter={(event) => activateExternalDragHover(event, true)}
      onDragOver={(event) => activateExternalDragHover(event, false)}
      onDragLeave={handleWorkspaceDragLeave}
      onDropCapture={resetExternalDragHover}
    >
      <PaneView
        pane={layout.panes.primary}
        isActivePane={layout.activePaneId === 'primary'}
        flexRatio={isSplit ? layout.splitRatio : undefined}
        history={historyByPane?.primary}
        findControl={getPaneFindControl?.('primary')}
        {...sharedPaneProps}
      />

      {visibleDropZones.map((zone) => (
        <div
          key={zone.direction}
          className={`split-drop-zone is-${zone.direction}`}
          data-testid={zone.testId}
          aria-label={zone.label}
          onDragOver={(event) => allowWikiTabDragOver(event, dragState)}
          onDrop={(event) =>
            dispatchTabDrop(
              event,
              dragState,
              { kind: 'split', direction: zone.direction },
              actions,
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
            history={historyByPane?.secondary}
            findControl={getPaneFindControl?.('secondary')}
            {...sharedPaneProps}
          />
        </>
      )}
    </div>
  )
}
