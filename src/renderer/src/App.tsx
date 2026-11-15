import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListTree } from 'lucide-react'
import type { AppConfig } from '@shared/config'
import type { AppMenuCommand, WikiApi } from '@shared/ipc'
import type { GitStatus } from '@shared/git'
import { formatWindowTitle, type WindowRole } from '@shared/window'
import { isFavoriteWorkspacePath, WorkspaceEntry } from '@shared/workspace'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ActivityBar, type LeftSidebarView } from './components/ActivityBar'
import type { OutlineScrollRequest } from './components/DocumentEditor'
import { DocumentOutlinePanel } from './components/DocumentOutlinePanel'
import { FolderTreeSidebar } from './components/FolderTreeSidebar'
import { GitSidebarPanel } from './components/GitSidebarPanel'
import { PaneInteractionActions } from './components/PaneTabBar'
import { PaneWorkspace } from './components/PaneWorkspace'
import { SettingsPanel } from './components/SettingsPanel'
import { SidebarResizer } from './components/SidebarResizer'
import { WorkspaceView } from './components/WorkspaceView'
import { isMarkdownDocument } from './editor/editorModes'
import { deriveDocumentTitle } from './editor/SlashCommandEngine'
import {
  applyHeadingNumbers,
  findFirstNonFencedSlashTocLine,
  insertOrUpdateTocBlock,
  type MarkdownHeading,
  resolveRawCursorLine,
  stripHeadingNumbers
} from './editor/MarkdownTocEngine'
import { useConfigController } from './hooks/useConfigController'
import { DirtyTabCloseRequest, useEditorWorkspace } from './hooks/useEditorWorkspace'
import { useGitController } from './hooks/useGitController'
import { useWikiApi, WikiApiProvider } from './hooks/useWikiApi'
import { useWindowWidth } from './hooks/useWindowWidth'
import { useWorkspaceTree } from './hooks/useWorkspaceTree'
import { logRendererError, registerRendererGlobalErrorLogging } from './logging/rendererLogger'
import { getPaneActiveTab, type PaneId, type TabViewPatch } from './stores/PaneTabStore'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_WIDTH_BOUNDS
} from './utils/sidebarWidth'
import { toErrorMessage } from '@shared/errors'

interface LeftSidebarState {
  activeView: LeftSidebarView
  isCollapsed: boolean
  width: number
}

interface RightSidebarState {
  isCollapsed: boolean
  width: number
}

function selectLeftSidebarView(
  prev: LeftSidebarState,
  view: LeftSidebarView
): LeftSidebarState {
  if (!prev.isCollapsed && prev.activeView === view) {
    return { ...prev, isCollapsed: true }
  }
  return { ...prev, activeView: view, isCollapsed: false }
}

function getGitChangedCount(workspaceRootPath: string | null, status: GitStatus | null): number {
  if (!workspaceRootPath || !status || !status.isRepo) {
    return 0
  }
  return status.staged.length + status.unstaged.length + status.untracked.length
}

interface PendingDialogState {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
  onCancel?: () => void
}

export interface AppProps {
  wikiApi?: WikiApi
}

export function App({ wikiApi }: AppProps = {}) {
  return (
    <WikiApiProvider api={wikiApi}>
      <AppShell />
    </WikiApiProvider>
  )
}

function AppShell() {
  const wikiApi = useWikiApi()
  const windowRole: WindowRole = wikiApi.window?.role ?? 'main'
  const isAuxiliaryWindow = windowRole === 'auxiliary'
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [leftSidebar, setLeftSidebar] = useState<LeftSidebarState>({
    activeView: 'workspace',
    isCollapsed: false,
    width: LEFT_SIDEBAR_DEFAULT_WIDTH
  })
  const [rightSidebar, setRightSidebar] = useState<RightSidebarState>(() => ({
    isCollapsed: isAuxiliaryWindow,
    width: RIGHT_SIDEBAR_DEFAULT_WIDTH
  }))
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const windowWidth = useWindowWidth()
  const leftSidebarBounds = getLeftSidebarWidthBounds(windowWidth)
  const leftSidebarWidth = clampSidebarWidth(leftSidebar.width, leftSidebarBounds)

  useEffect(() => {
    setLeftSidebar((prev) =>
      prev.width === leftSidebarWidth ? prev : { ...prev, width: leftSidebarWidth }
    )
  }, [leftSidebarWidth])

  const handleSelectLeftSidebarView = useCallback((view: LeftSidebarView): void => {
    hasUserSelectedSidebarViewRef.current = true
    setLeftSidebar((prev) => selectLeftSidebarView(prev, view))
  }, [])

  const handleResizeLeftSidebar = useCallback((nextWidth: number): void => {
    setLeftSidebar((prev) => (prev.width === nextWidth ? prev : { ...prev, width: nextWidth }))
  }, [])

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
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const scrollNonceRef = useRef(0)
  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const refreshGitStatusRef = useRef<() => Promise<void>>(async () => undefined)
  const reconcileBuffersRef = useRef<() => Promise<readonly string[]>>(async () => [])
  const pendingGitConfirmCancelRef = useRef<(() => void) | null>(null)
  const isDialogOpenRef = useRef<boolean>(false)
  isDialogOpenRef.current = pendingDialog !== null
  const isEditorShortcutDisabled = pendingDialog !== null || (!isAuxiliaryWindow && isSettingsOpen)
  const isSelectingFolderRef = useRef<boolean>(false)
  const hasWorkspaceInteractionRef = useRef<boolean>(false)
  const hasUserSelectedSidebarViewRef = useRef<boolean>(false)
  const isStartupRestoreRef = useRef<boolean>(false)
  const handleInitialConfigLoadedRef = useRef<(loadedConfig: AppConfig) => void>(() => undefined)
  const tabCloseActionsRef = useRef<{
    saveAndCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => Promise<boolean>
    forceCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => void
  }>({
    saveAndCloseTab: async () => false,
    forceCloseTab: () => undefined
  })
  const menuHandlersRef = useRef<Record<AppMenuCommand, () => void>>({
    'open-folder': () => undefined,
    'toggle-theme': () => undefined,
    'toggle-settings': () => undefined
  })

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
    onInitialConfigLoaded: (loadedConfig) => handleInitialConfigLoadedRef.current(loadedConfig)
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
    onWorkspaceSaved: () => void refreshGitStatusRef.current(),
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: handleConfirmCloseDirtyTab
  })

  refreshConfigDocRef.current = refreshCleanConfig
  reconcileBuffersRef.current = reconcileWorkspaceBuffersWithDisk
  tabCloseActionsRef.current = { saveAndCloseTab, forceCloseTab }

  const {
    workspace,
    treeState,
    setSelectedTreePath,
    resolveCreateParentDir,
    openWorkspace,
    refreshTree,
    toggleDirectory,
    ensureExpanded,
    createEntry,
    renameEntry,
    deleteEntry
  } = useWorkspaceTree({
    enabled: !isAuxiliaryWindow,
    onError: reportErrorBanner,
    onWorkspaceOpened: () => {
      clearWorkspaceBuffers()
      if (isStartupRestoreRef.current) {
        isStartupRestoreRef.current = false
        if (!hasUserSelectedSidebarViewRef.current) {
          setLeftSidebar((prev) => ({ ...prev, activeView: 'explorer', isCollapsed: false }))
        }
        return
      }
      setLeftSidebar((prev) =>
        prev.activeView === 'workspace' && !prev.isCollapsed
          ? { ...prev, activeView: 'explorer', isCollapsed: false }
          : prev
      )
    },
    onWorkspaceChanged: () => {
      void reconcileBuffersRef.current().then((warnings) => {
        if (warnings.length > 0) {
          reportErrorBanner(warnings.join(' '))
        }
      })
      void refreshGitStatusRef.current()
    },
    onFileCreated: openCreatedFile,
    onEntryRenamed: syncRenamedPath,
    onEntryDeleted: syncDeletedPath
  })

  handleInitialConfigLoadedRef.current = (loadedConfig) => {
    if (
      isAuxiliaryWindow ||
      hasWorkspaceInteractionRef.current ||
      isSelectingFolderRef.current ||
      workspace !== null
    ) {
      return
    }
    const lastWorkspacePath = loadedConfig.recentWorkspaces[0]
    if (!lastWorkspacePath) {
      return
    }
    hasWorkspaceInteractionRef.current = true
    isStartupRestoreRef.current = true
    void openWorkspace(lastWorkspacePath, {
      silentError: true,
      onSilentError: () => removeRecentWorkspace(lastWorkspacePath)
    }).finally(() => {
      isStartupRestoreRef.current = false
    })
  }

  useEffect(() => {
    return registerRendererGlobalErrorLogging()
  }, [])

  useEffect(() => {
    return () => {
      pendingGitConfirmCancelRef.current?.()
    }
  }, [])

  const promptUnsavedWorkspaceChanges = useCallback(
    (options: {
      message: (dirtySummary: string) => string
      confirmLabel: string
      secondaryLabel: string
    }): Promise<boolean> => {
      const dirtySummary = getDirtyWorkspaceSummary()
      if (!dirtySummary) {
        return Promise.resolve(true)
      }

      return new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (accepted: boolean): void => {
          if (settled) return
          settled = true
          pendingGitConfirmCancelRef.current = null
          resolve(accepted)
        }
        pendingGitConfirmCancelRef.current = () => finish(false)

        setPendingDialog({
          title: '저장하지 않은 변경 사항',
          message: options.message(dirtySummary),
          confirmLabel: options.confirmLabel,
          secondaryLabel: options.secondaryLabel,
          onConfirm: async () => {
            setPendingDialog(null)
            const saved = await ensureAllWorkspaceBuffersSaved()
            finish(saved)
          },
          onSecondary: () => {
            setPendingDialog(null)
            finish(true)
          },
          onCancel: () => finish(false)
        })
      })
    },
    [ensureAllWorkspaceBuffersSaved, getDirtyWorkspaceSummary]
  )

  const confirmDirtyBuffersBeforeGitMutation = useCallback(
    (actionLabel: string): Promise<boolean> =>
      promptUnsavedWorkspaceChanges({
        message: (dirtySummary) =>
          `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. ${actionLabel} 전에 어떻게 할까요?`,
        confirmLabel: '저장 후 진행',
        secondaryLabel: '저장 없이 진행'
      }),
    [promptUnsavedWorkspaceChanges]
  )

  const handleGitWorkspaceMutated = useCallback(async (): Promise<readonly string[]> => {
    await refreshTree()
    return await reconcileWorkspaceBuffersWithDisk()
  }, [reconcileWorkspaceBuffersWithDisk, refreshTree])

  const git = useGitController({
    workspaceRootPath: isAuxiliaryWindow ? null : (workspace?.rootPath ?? null),
    confirmBeforeWorkspaceMutation: confirmDirtyBuffersBeforeGitMutation,
    onWorkspaceMutated: handleGitWorkspaceMutated
  })
  refreshGitStatusRef.current = git.refreshStatus

  const guardUnsavedWorkspaceChanges = useCallback(
    (proceed: () => Promise<unknown>): void => {
      void promptUnsavedWorkspaceChanges({
        message: (dirtySummary) =>
          `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 어떻게 할까요?`,
        confirmLabel: '저장 후 이동',
        secondaryLabel: '버리고 이동'
      }).then((accepted) => {
        if (accepted) {
          void proceed()
        }
      })
    },
    [promptUnsavedWorkspaceChanges]
  )

  const handleSwitchWorkspace = useCallback(
    (targetPath: string): void => {
      hasWorkspaceInteractionRef.current = true
      isStartupRestoreRef.current = false
      guardUnsavedWorkspaceChanges(() => openWorkspace(targetPath))
    },
    [guardUnsavedWorkspaceChanges, openWorkspace]
  )

  const handleSelectFolder = useCallback((): void => {
    if (isDialogOpenRef.current || isSelectingFolderRef.current) {
      return
    }

    isSelectingFolderRef.current = true
    hasWorkspaceInteractionRef.current = true
    isStartupRestoreRef.current = false
    reportErrorBanner(null)
    void wikiApi.workspace.selectFolder().then(
      (selectedPath) => {
        isSelectingFolderRef.current = false
        if (selectedPath && !isDialogOpenRef.current) {
          handleSwitchWorkspace(selectedPath)
        }
      },
      (error: unknown) => {
        isSelectingFolderRef.current = false
        reportErrorBanner(toErrorMessage(error, '폴더 선택에 실패했습니다.'), error)
      }
    )
  }, [handleSwitchWorkspace, reportErrorBanner, wikiApi])

  const handleOpenFile = useCallback(
    (entry: WorkspaceEntry): void => {
      void openWorkspaceFile(entry)
    },
    [openWorkspaceFile]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    setIsSettingsOpen(false)
    void openConfigDocument()
  }, [openConfigDocument])

  menuHandlersRef.current = {
    'open-folder': handleSelectFolder,
    'toggle-theme': toggleTheme,
    'toggle-settings': () => setIsSettingsOpen((open) => !open)
  }

  useEffect(() => {
    if (isAuxiliaryWindow) {
      return
    }
    return wikiApi.menu.onCommand((command) => {
      if (isDialogOpenRef.current) {
        return
      }
      menuHandlersRef.current[command]?.()
    })
  }, [isAuxiliaryWindow, wikiApi])

  const handleRequestDelete = useCallback(
    (entry: WorkspaceEntry): void => {
      setPendingDialog({
        title: '항목 삭제',
        message: `"${entry.name}"을(를) 삭제하시겠습니까?`,
        confirmLabel: '삭제 확인',
        onConfirm: async () => {
          setPendingDialog(null)
          await deleteEntry(entry)
        }
      })
    },
    [deleteEntry]
  )

  const activePane = layout.panes[layout.activePaneId]
  const activeTab = getPaneActiveTab(activePane)
  const activeBuffer = activeTab ? buffers[activeTab.bufferKey] : undefined
  const activeFilePath = activeBuffer?.kind === 'workspace' ? activeBuffer.path : null
  const isActiveMarkdown = activeBuffer ? isMarkdownDocument(activeBuffer) : false
  const totalTabCount = layout.panes.primary.tabs.length + layout.panes.secondary.tabs.length
  const canDetachToNewWindow = !isAuxiliaryWindow || totalTabCount > 1

  useEffect(() => {
    if (!isAuxiliaryWindow) {
      return
    }
    document.title = formatWindowTitle(activeBuffer?.name)
  }, [activeBuffer?.name, isAuxiliaryWindow])

  const hadAuxTabsRef = useRef<boolean>(false)
  useEffect(() => {
    if (!isAuxiliaryWindow) {
      return
    }
    if (totalTabCount > 0) {
      hadAuxTabsRef.current = true
      return
    }
    if (hadAuxTabsRef.current) {
      void wikiApi.window?.closeCurrent().catch(() => undefined)
    }
  }, [isAuxiliaryWindow, totalTabCount, wikiApi])

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

  const isCurrentWorkspaceFavorite =
    workspace !== null && isFavoriteWorkspacePath(config.favoriteWorkspaces, workspace.rootPath)
  const gitChangedCount = getGitChangedCount(workspace?.rootPath ?? null, git.status)

  return (
    <div className="app-shell" data-theme={config.theme}>
      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        {!isAuxiliaryWindow && (
          <>
            <ActivityBar
              activeView={leftSidebar.activeView}
              isCollapsed={leftSidebar.isCollapsed}
              gitChangedCount={gitChangedCount}
              onSelectView={handleSelectLeftSidebarView}
            />

            {!leftSidebar.isCollapsed && (
              <>
                <aside
                  className="left-sidebar"
                  aria-label="왼쪽 사이드바"
                  style={{ width: `${leftSidebarWidth}px` }}
                >
                  {leftSidebar.activeView === 'workspace' && (
                    <WorkspaceView
                      workspace={workspace}
                      isFavorite={isCurrentWorkspaceFavorite}
                      favoriteWorkspaces={config.favoriteWorkspaces}
                      recentWorkspaces={config.recentWorkspaces}
                      onOpenFolder={handleSelectFolder}
                      onSwitchWorkspace={handleSwitchWorkspace}
                      onToggleFavorite={() => {
                        if (workspace) {
                          toggleFavoriteWorkspace(workspace.rootPath, workspace.name)
                        }
                      }}
                      onRemoveFavorite={removeFavoriteWorkspace}
                    />
                  )}
                  {leftSidebar.activeView === 'explorer' && (
                    <FolderTreeSidebar
                      workspace={workspace}
                      tree={treeState}
                      activeFilePath={activeFilePath}
                      onSelectPath={setSelectedTreePath}
                      onToggleDirectory={toggleDirectory}
                      onEnsureExpanded={ensureExpanded}
                      onResolveCreateParentDir={resolveCreateParentDir}
                      onOpenFile={handleOpenFile}
                      onRefreshTree={() => void refreshTree()}
                      onCreateEntry={createEntry}
                      onRenameEntry={renameEntry}
                      onRequestDelete={handleRequestDelete}
                    />
                  )}

                  {leftSidebar.activeView === 'git' && (
                    <GitSidebarPanel
                      workspaceRootPath={workspace?.rootPath ?? null}
                      status={git.status}
                      branchList={git.branchList}
                      pendingAction={git.pendingAction}
                      errorMessage={git.errorMessage}
                      onDismissError={git.dismissError}
                      onRefresh={() => void git.refreshStatus()}
                      onInitRepo={() => void git.initRepo()}
                      onStageFile={(path) => void git.stageFile(path)}
                      onStageAll={() => void git.stageAll()}
                      onUnstageFile={(path, origPath) => void git.unstageFile(path, origPath)}
                      onUnstageAll={() => void git.unstageAll()}
                      onCommit={git.commit}
                      onCheckoutBranch={(branchName) => void git.checkoutBranch(branchName)}
                      onPull={() => void git.pull()}
                      onPush={() => void git.push()}
                      onSync={() => void git.sync()}
                    />
                  )}
                </aside>
                <SidebarResizer
                  edge="right"
                  width={leftSidebarWidth}
                  bounds={leftSidebarBounds}
                  ariaLabel="왼쪽 사이드바 너비 조절"
                  onResize={handleResizeLeftSidebar}
                />
              </>
            )}
          </>
        )}

        <PaneWorkspace
          layout={layout}
          buffers={buffers}
          theme={config.theme}
          autoSave={config.autoSave}
          showHeadingNumbers={config.showHeadingNumbers}
          customCommands={config.customCommands}
          scrollRequest={outlineScrollRequest}
          isShortcutDisabled={isEditorShortcutDisabled}
          canDetachToNewWindow={canDetachToNewWindow}
          onSetSplitRatio={setSplitRatio}
          onSplitWithTab={splitWithTab}
          actions={paneActions}
        />

        {!rightSidebar.isCollapsed ? (
          <>
            <SidebarResizer
              edge="left"
              width={rightSidebar.width}
              bounds={RIGHT_SIDEBAR_WIDTH_BOUNDS}
              ariaLabel="우측 사이드바 너비 조절"
              onResize={handleResizeRightSidebar}
            />
            <aside
              className="right-sidebar"
              aria-label="우측 사이드바"
              style={{ width: `${rightSidebar.width}px` }}
            >
              <DocumentOutlinePanel
                documentName={activeBuffer?.name ?? null}
                content={activeBuffer?.content ?? ''}
                isMarkdownDocument={isActiveMarkdown}
                showHeadingNumbers={config.showHeadingNumbers}
                onToggleHeadingNumbers={toggleShowHeadingNumbers}
                onSelectHeading={handleSelectOutlineHeading}
                onInsertToc={handleOutlineInsertToc}
                onApplyHeadingNumbers={handleOutlineApplyHeadingNumbers}
                onStripHeadingNumbers={handleOutlineStripHeadingNumbers}
                onCollapse={handleCollapseRightSidebar}
              />
            </aside>
          </>
        ) : (
          <button
            type="button"
            className="right-sidebar-expand-tab"
            aria-label="문서 목차 펼치기"
            title="문서 목차 펼치기"
            onClick={handleExpandRightSidebar}
          >
            <ListTree size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </main>

      {!isAuxiliaryWindow && isSettingsOpen && (
        <SettingsPanel
          theme={config.theme}
          autoSave={config.autoSave}
          showHeadingNumbers={config.showHeadingNumbers}
          configPath={configPath}
          customCommands={config.customCommands}
          previewTitle={activeBuffer ? deriveDocumentTitle(activeBuffer.name) : undefined}
          isDismissDisabled={pendingDialog !== null}
          onToggleTheme={toggleTheme}
          onToggleAutoSave={toggleAutoSave}
          onToggleShowHeadingNumbers={toggleShowHeadingNumbers}
          onSaveCustomCommands={updateCustomCommands}
          onOpenConfigEditor={handleOpenConfigEditor}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {pendingDialog && (
        <ConfirmDialog
          title={pendingDialog.title}
          message={pendingDialog.message}
          confirmLabel={pendingDialog.confirmLabel}
          secondaryLabel={pendingDialog.secondaryLabel}
          onConfirm={() => void pendingDialog.onConfirm()}
          onSecondary={
            pendingDialog.onSecondary ? () => void pendingDialog.onSecondary!() : undefined
          }
          onCancel={() => {
            pendingDialog.onCancel?.()
            setPendingDialog(null)
          }}
        />
      )}
    </div>
  )
}
