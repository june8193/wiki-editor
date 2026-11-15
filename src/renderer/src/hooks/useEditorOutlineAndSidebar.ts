import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentBufferSnapshot } from '@shared/documentBuffer'
import type { OutlineScrollRequest } from '../components/DocumentEditor'
import type { PaneInteractionActions } from '../components/PaneTabBar'
import { isMarkdownDocument } from '../editor/editorModes'
import {
  applyHeadingNumbers,
  findFirstNonFencedSlashTocLine,
  insertOrUpdateTocBlock,
  type MarkdownHeading,
  resolveRawCursorLine,
  stripHeadingNumbers
} from '../editor/MarkdownTocEngine'
import {
  countLayoutTabs,
  getPaneActiveTab,
  type PaneId,
  type PaneLayoutState,
  type TabViewPatch
} from '../stores/PaneTabStore'
import {
  clampSidebarWidth,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_WIDTH_BOUNDS
} from '../utils/sidebarWidth'

export interface RightSidebarState {
  isCollapsed: boolean
  width: number
}

export interface EditorPaneActionHandlers {
  updateBufferContent: (bufferKey: string, nextContent: string) => void
  focusPane: (paneId: PaneId) => void
  activateTab: (paneId: PaneId, tabId: string) => void
  requestCloseTab: (paneId: PaneId, tabId: string) => void
  moveTab: PaneInteractionActions['onMoveTab']
  duplicateTabToOtherPane: PaneInteractionActions['onDuplicateTab']
  detachTabToNewWindow: (paneId: PaneId, tabId: string) => Promise<void>
  saveBufferByKey: (bufferKey: string) => void
  updateTabViewState: (paneId: PaneId, tabId: string, patch: TabViewPatch) => void
}

export interface UseEditorOutlineAndSidebarOptions {
  initialRightCollapsed: boolean
  buffers: DocumentBufferSnapshot
  layout: PaneLayoutState
  editorActions: EditorPaneActionHandlers
}

/**
 * Coordinates the collapsible/resizable document outline sidebar, heading scroll/TOC/numbering
 * transforms, active buffer projection, and memoized PaneTabBar interaction callbacks.
 */
export function useEditorOutlineAndSidebar({
  initialRightCollapsed,
  buffers,
  layout,
  editorActions
}: UseEditorOutlineAndSidebarOptions) {
  const {
    updateBufferContent,
    focusPane,
    activateTab,
    requestCloseTab,
    moveTab,
    duplicateTabToOtherPane,
    detachTabToNewWindow,
    saveBufferByKey,
    updateTabViewState
  } = editorActions

  const [rightSidebar, setRightSidebar] = useState<RightSidebarState>(() => ({
    isCollapsed: initialRightCollapsed,
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH
  }))
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const scrollNonceRef = useRef(0)

  const handleCollapseRightSidebar = useCallback((): void => {
    setRightSidebar((prev) => (prev.isCollapsed ? prev : { ...prev, isCollapsed: true }))
  }, [])

  const handleExpandRightSidebar = useCallback((): void => {
    setRightSidebar((prev) => (prev.isCollapsed ? { ...prev, isCollapsed: false } : prev))
  }, [])

  const handleResizeRightSidebar = useCallback((nextWidth: number): void => {
    const clampedWidth = clampSidebarWidth(nextWidth, RIGHT_SIDEBAR_WIDTH_BOUNDS)
    setRightSidebar((prev) =>
      prev.width === clampedWidth ? prev : { ...prev, width: clampedWidth }
    )
  }, [])

  const activePane = layout.panes[layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer = activeTab ? buffers[activeTab.bufferKey] : undefined
  const activeFilePath = activeBuffer?.kind === 'workspace' ? activeBuffer.path : null
  const isActiveMarkdown = activeBuffer ? isMarkdownDocument(activeBuffer) : false
  const totalTabCount = countLayoutTabs(layout)

  const applyActiveMarkdownTransform = useCallback(
    (transform: (content: string) => string): void => {
      if (!activeBuffer || !isActiveMarkdown) return
      const nextContent = transform(activeBuffer.content)
      if (nextContent !== activeBuffer.content) {
        updateBufferContent(activeBuffer.key, nextContent)
      }
    },
    [activeBuffer, isActiveMarkdown, updateBufferContent]
  )

  const handleSelectOutlineHeading = useCallback(
    (heading: MarkdownHeading, index: number): void => {
      if (!activeTab || !isActiveMarkdown) return
      scrollNonceRef.current += 1
      setOutlineScrollRequest({
        paneId: activePane.id,
        tabId: activeTab.id,
        mode: activeTab.mode,
        line: heading.line,
        slug: heading.slug,
        index,
        nonce: scrollNonceRef.current
      })
    },
    [activePane.id, activeTab, isActiveMarkdown]
  )

  useEffect(() => {
    if (outlineScrollRequest !== null) {
      setOutlineScrollRequest(null)
    }
  }, [outlineScrollRequest])

  const handleOutlineInsertToc = useCallback((): void => {
    applyActiveMarkdownTransform((content) => {
      const cursorLine =
        activeTab?.mode === 'raw'
          ? resolveRawCursorLine(content, activeTab.cursor.selectionStart)
          : findFirstNonFencedSlashTocLine(content)
      return insertOrUpdateTocBlock(content, cursorLine)
    })
  }, [activeTab?.cursor.selectionStart, activeTab?.mode, applyActiveMarkdownTransform])

  const handleOutlineApplyHeadingNumbers = useCallback((): void => {
    applyActiveMarkdownTransform(applyHeadingNumbers)
  }, [applyActiveMarkdownTransform])

  const handleOutlineStripHeadingNumbers = useCallback((): void => {
    applyActiveMarkdownTransform(stripHeadingNumbers)
  }, [applyActiveMarkdownTransform])

  const handlePaneChangeContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      setOutlineScrollRequest(null)
      updateBufferContent(bufferKey, nextContent)
    },
    [updateBufferContent]
  )

  const handlePaneUpdateTabViewState = useCallback(
    (paneId: PaneId, tabId: string, patch: TabViewPatch): void => {
      if (patch.mode !== undefined) {
        setOutlineScrollRequest(null)
      }
      updateTabViewState(paneId, tabId, patch)
    },
    [updateTabViewState]
  )

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      onFocusPane: focusPane,
      onActivateTab: activateTab,
      onCloseTab: requestCloseTab,
      onMoveTab: moveTab,
      onDuplicateTab: duplicateTabToOtherPane,
      onDetachTabToNewWindow: (paneId, tabId) => void detachTabToNewWindow(paneId, tabId),
      onChangeContent: handlePaneChangeContent,
      onSaveBuffer: saveBufferByKey,
      onUpdateTabViewState: handlePaneUpdateTabViewState
    }),
    [
      activateTab,
      detachTabToNewWindow,
      duplicateTabToOtherPane,
      focusPane,
      handlePaneChangeContent,
      handlePaneUpdateTabViewState,
      moveTab,
      requestCloseTab,
      saveBufferByKey
    ]
  )

  return {
    activeBuffer,
    activeFilePath,
    totalTabCount,
    outlineScrollRequest,
    paneActions,
    outlinePanelProps: {
      documentName: activeBuffer?.name ?? null,
      content: activeBuffer?.content ?? '',
      isMarkdownDocument: isActiveMarkdown,
      onSelectHeading: handleSelectOutlineHeading,
      onInsertToc: handleOutlineInsertToc,
      onApplyHeadingNumbers: handleOutlineApplyHeadingNumbers,
      onStripHeadingNumbers: handleOutlineStripHeadingNumbers
    },
    rightSidebar: {
      isCollapsed: rightSidebar.isCollapsed,
      width: rightSidebar.width,
      onCollapse: handleCollapseRightSidebar,
      onExpand: handleExpandRightSidebar,
      onResize: handleResizeRightSidebar
    }
  }
}
