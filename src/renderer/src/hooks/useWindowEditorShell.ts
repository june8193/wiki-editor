import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig } from '@shared/config'
import type { OutlineScrollRequest } from '../components/DocumentEditor'
import { PaneInteractionActions } from '../components/PaneTabBar'
import { isMarkdownDocument } from '../editor/editorModes'
import {
  applyHeadingNumbers,
  findFirstNonFencedSlashTocLine,
  insertOrUpdateTocBlock,
  type MarkdownHeading,
  resolveRawCursorLine,
  stripHeadingNumbers
} from '../editor/MarkdownTocEngine'
import { useConfigController } from './useConfigController'
import { DirtyTabCloseRequest, useEditorWorkspace } from './useEditorWorkspace'
import { logRendererError, registerRendererGlobalErrorLogging } from '../logging/rendererLogger'
import {
  countLayoutTabs,
  getPaneActiveTab,
  type PaneId,
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

export interface PendingDialogState {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
  onCancel?: () => void
}

export interface UseWindowEditorShellOptions {
  initialRightCollapsed: boolean
  isExtraShortcutDisabled?: boolean
}

/**
 * Shared editor workspace, configuration, document outline, right sidebar, and dialog state
 * mounted by both main and auxiliary editor windows.
 */
export function useWindowEditorShell({
  initialRightCollapsed,
  isExtraShortcutDisabled = false
}: UseWindowEditorShellOptions) {
  const [rightSidebar, setRightSidebar] = useState<RightSidebarState>(() => ({
    isCollapsed: initialRightCollapsed,
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH
  }))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const scrollNonceRef = useRef(0)
  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const onWorkspaceSavedRef = useRef<() => Promise<void>>(async () => undefined)
  const onInitialConfigLoadedRef = useRef<(loadedConfig: AppConfig) => void>(() => undefined)
  const isDialogOpenRef = useRef<boolean>(false)
  isDialogOpenRef.current = pendingDialog !== null
  const isEditorShortcutDisabled = pendingDialog !== null || isExtraShortcutDisabled

  const tabCloseActionsRef = useRef<{
    saveAndCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => Promise<boolean>
    forceCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => void
  }>({
    saveAndCloseTab: async () => false,
    forceCloseTab: () => undefined
  })

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

  const reportErrorBanner = useCallback((message: string | null, error?: unknown): void => {
    setErrorMessage(message)
    if (message) {
      logRendererError('ui', 'Error banner displayed', {
        data: { errorMessage: message },
        ...(error !== undefined ? { error } : {})
      })
    }
  }, [])

  const {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleShowHeadingNumbers,
    updateCustomCommands,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    removeRecentWorkspace
  } = useConfigController({
    onError: reportErrorBanner,
    onExternalConfigCommitted: () => void refreshConfigDocRef.current(),
    onInitialConfigLoaded: (loadedConfig) => onInitialConfigLoadedRef.current(loadedConfig)
  })

  const handleConfirmCloseDirtyTab = useCallback((request: DirtyTabCloseRequest): void => {
    setPendingDialog({
      title: '저장하지 않은 변경 사항',
      message: `"${request.buffer.name}"에 저장하지 않은 변경 사항이 있습니다. 저장하고 닫을까요?`,
      confirmLabel: '저장 후 닫기',
      secondaryLabel: '버리고 닫기',
      onConfirm: async () => {
        setPendingDialog(null)
        await tabCloseActionsRef.current.saveAndCloseTab(request.paneId, request.tabId)
      },
      onSecondary: () => {
        setPendingDialog(null)
        tabCloseActionsRef.current.forceCloseTab(request.paneId, request.tabId)
      }
    })
  }, [])

  const {
    buffers,
    layout,
    openWorkspaceFile,
    openConfigDocument,
    refreshCleanConfig,
    openCreatedFile,
    updateBufferContent,
    saveBufferByKey,
    ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary,
    requestCloseTab,
    forceCloseTab,
    saveAndCloseTab,
    detachTabToNewWindow,
    activateTab,
    focusPane,
    setSplitRatio,
    moveTab,
    splitWithTab,
    duplicateTabToOtherPane,
    updateTabViewState,
    clearWorkspaceBuffers,
    syncRenamedPath,
    syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk
  } = useEditorWorkspace({
    isAutoSavePaused: pendingDialog !== null,
    isShortcutDisabled: isEditorShortcutDisabled,
    onWorkspaceSaved: () => void onWorkspaceSavedRef.current(),
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: handleConfirmCloseDirtyTab
  })

  refreshConfigDocRef.current = refreshCleanConfig
  tabCloseActionsRef.current = { saveAndCloseTab, forceCloseTab }

  useEffect(() => {
    return registerRendererGlobalErrorLogging()
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
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleShowHeadingNumbers,
    updateCustomCommands,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    removeRecentWorkspace,
    buffers,
    layout,
    activeBuffer,
    activeFilePath,
    isActiveMarkdown,
    totalTabCount,
    setSplitRatio,
    splitWithTab,
    paneActions,
    openWorkspaceFile,
    openConfigDocument,
    openCreatedFile,
    clearWorkspaceBuffers,
    syncRenamedPath,
    syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk,
    ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary,
    errorMessage,
    reportErrorBanner,
    pendingDialog,
    setPendingDialog,
    isDialogOpenRef,
    isEditorShortcutDisabled,
    rightSidebar,
    handleCollapseRightSidebar,
    handleExpandRightSidebar,
    handleResizeRightSidebar,
    outlineScrollRequest,
    handleSelectOutlineHeading,
    handleOutlineInsertToc,
    handleOutlineApplyHeadingNumbers,
    handleOutlineStripHeadingNumbers,
    onWorkspaceSavedRef,
    onInitialConfigLoadedRef
  }
}

export type WindowEditorShellState = ReturnType<typeof useWindowEditorShell>
