import {
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import type { ThemeMode } from '@shared/config'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { ActiveTabDragSession } from '@shared/window'
import type { WorkspaceEntry } from '@shared/workspace'
import type { OutlineActiveHeadingReport, OutlineScrollRequest } from '../editor/outlineScrollSpy'
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
import type { GitDiffContentState } from './GitDiffViewer'
import type { PaneInteractionActions } from './PaneTabBar'
import { PaneView } from './PaneView'
import { SplitSplitter } from './SplitSplitter'

export interface PaneWorkspaceProps {
  layout: PaneLayoutState
  buffers: DocumentBufferSnapshot
  diffsByKey: Record<string, GitDiffContentState>
  theme: ThemeMode
  autoSave: boolean
  scrollRequest?: OutlineScrollRequest | null
  isShortcutDisabled?: boolean
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  dragState: TabDragUiState
  onSetSplitRatio: (ratio: number) => void
  onSplitWithTab: (sourcePaneId: PaneId, tabId: string, splitDirection: SplitDirection) => void
  onActiveHeadingChange?: (report: OutlineActiveHeadingReport) => void
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
  diffsByKey,
  theme,
  autoSave,
  scrollRequest = null,
  isShortcutDisabled = false,
  workspaceMarkdownFiles,
  dragState,
  onSetSplitRatio,
  onSplitWithTab,
  onActiveHeadingChange,
  actions
}: PaneWorkspaceProps) {
  const [isResizing, setIsResizing] = useState(false)
  const [isExternalDragOver, setIsExternalDragOver] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const externalDragDepthRef = useRef(0)
  const prevExternalSessionRef = useRef<ActiveTabDragSession | null>(dragState.externalDragSession)

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
    isShortcutDisabled,
    workspaceMarkdownFiles,
    buffers,
    diffsByKey,
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
            {...sharedPaneProps}
          />
        </>
      )}
    </div>
  )
}
