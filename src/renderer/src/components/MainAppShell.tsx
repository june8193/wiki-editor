import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig } from '@shared/config'
import type { AppMenuCommand, WikiApi } from '@shared/ipc'
import { getGitChangedCount, type GitDiffRequest } from '@shared/git'
import {
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  isFavoriteWorkspacePath,
  resolveRepoFileInWorkspace,
  type WorkspaceChangeEvent,
  type WorkspaceEntry
} from '@shared/workspace'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useWorkspaceImageTransfer } from '../hooks/useEditorImageTransfer'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useGitController } from '../hooks/useGitController'
import { useGitDiffTabs } from '../hooks/useGitDiffTabs'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useWorkspaceTree } from '../hooks/useWorkspaceTree'
import { getGitFileBaseName } from '../utils/gitFilePresentation'
import {
  createDefaultGitPanelSplitState,
  toggleGitChangesCollapsed,
  toggleGitGraphCollapsed,
  updateChangesHeightRatio,
  type GitPanelSplitState
} from '../utils/gitPanelSplit'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH
} from '../utils/sidebarWidth'
import { ActivityBar, type LeftSidebarView } from './ActivityBar'
import { buildPaneWorkspaceProps, EditorWindowFrame } from './EditorWindowFrame'
import { type EntryPathCopyMode, FolderTreeSidebar } from './FolderTreeSidebar'
import { GitSidebarPanel } from './GitSidebarPanel'
import type { PaneInteractionActions } from './PaneTabBar'
import { SettingsPanel } from './SettingsPanel'
import { SidebarResizer } from './SidebarResizer'
import { WorkspaceView } from './WorkspaceView'
import { toErrorMessage } from '@shared/errors'

interface LeftSidebarState {
  activeView: LeftSidebarView
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

async function writeTextToClipboard(wikiApi: WikiApi, text: string): Promise<void> {
  if (wikiApi.clipboard?.writeText) {
    await wikiApi.clipboard.writeText(text)
    return
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('클립보드를 사용할 수 없습니다.')
}

/**
 * Main window shell owning workspace opening and watching, activity bar, left sidebar views,
 * Git panel integration, application menu bar commands, and settings panel alongside the pane workspace.
 */
export function MainAppShell() {
  const wikiApi = useWikiApi()
  const { errorMessage, reportErrorBanner } = useErrorBanner()
  const {
    pendingDialog,
    setPendingDialog,
    dismissDialog,
    isDialogOpenRef,
    confirmCloseDirtyTab,
    confirmUnsavedChanges
  } = useConfirmDialog()
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [leftSidebar, setLeftSidebar] = useState<LeftSidebarState>({
    activeView: 'workspace',
    isCollapsed: false,
    width: LEFT_SIDEBAR_DEFAULT_WIDTH
  })
  const [gitPanelSplit, setGitPanelSplit] = useState<GitPanelSplitState>(
    createDefaultGitPanelSplitState
  )

  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const refreshGitStatusRef = useRef<() => Promise<void>>(async () => undefined)
  const onInitialConfigLoadedRef = useRef<(loadedConfig: AppConfig) => void>(() => undefined)

  const {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleShowHeadingNumbers,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    removeRecentWorkspace
  } = useConfigController({
    onError: reportErrorBanner,
    onExternalConfigCommitted: () => void refreshConfigDocRef.current(),
    onInitialConfigLoaded: (loadedConfig) => onInitialConfigLoadedRef.current(loadedConfig)
  })

  const isEditorShortcutDisabled = pendingDialog !== null || isSettingsOpen
  const editor = useEditorWorkspace({
    isAutoSavePaused: pendingDialog !== null,
    isShortcutDisabled: isEditorShortcutDisabled,
    onWorkspaceSaved: () => void refreshGitStatusRef.current(),
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: confirmCloseDirtyTab
  })

  refreshConfigDocRef.current = editor.refreshCleanConfig

  const windowWidth = useWindowWidth()
  const leftSidebarBounds = getLeftSidebarWidthBounds(windowWidth)
  const leftSidebarWidth = clampSidebarWidth(leftSidebar.width, leftSidebarBounds)

  useEffect(() => {
    setLeftSidebar((prev) =>
      prev.width === leftSidebarWidth ? prev : { ...prev, width: leftSidebarWidth }
    )
  }, [leftSidebarWidth])

  const hasUserSelectedSidebarViewRef = useRef<boolean>(false)
  const handleSelectLeftSidebarView = useCallback((view: LeftSidebarView): void => {
    hasUserSelectedSidebarViewRef.current = true
    setLeftSidebar((prev) => selectLeftSidebarView(prev, view))
  }, [])

  const handleResizeLeftSidebar = useCallback((nextWidth: number): void => {
    setLeftSidebar((prev) => (prev.width === nextWidth ? prev : { ...prev, width: nextWidth }))
  }, [])

  const handleToggleGitChangesCollapsed = useCallback((): void => {
    setGitPanelSplit(toggleGitChangesCollapsed)
  }, [])

  const handleToggleGitGraphCollapsed = useCallback((): void => {
    setGitPanelSplit(toggleGitGraphCollapsed)
  }, [])

  const handleResizeGitChangesRatio = useCallback((nextRatio: number): void => {
    setGitPanelSplit((prev) => updateChangesHeightRatio(prev, nextRatio))
  }, [])

  const isSelectingFolderRef = useRef<boolean>(false)
  const hasWorkspaceInteractionRef = useRef<boolean>(false)
  const isStartupRestoreRef = useRef<boolean>(false)
  const hadOpenWorkspaceRef = useRef<boolean>(false)
  const pendingGitConfirmCancelRef = useRef<(() => void) | null>(null)
  const reconcileBuffersRef = useRef<
    (changeEvent?: WorkspaceChangeEvent) => Promise<readonly string[]>
  >(editor.reconcileWorkspaceBuffersWithDisk)
  reconcileBuffersRef.current = editor.reconcileWorkspaceBuffersWithDisk

  const menuHandlersRef = useRef<Record<AppMenuCommand, () => void>>({
    'open-folder': () => undefined,
    'toggle-theme': () => undefined,
    'toggle-settings': () => undefined
  })

  const {
    workspace,
    treeState,
    markdownFiles,
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
    onError: reportErrorBanner,
    onWorkspaceOpened: () => {
      if (hadOpenWorkspaceRef.current) {
        editor.clearWorkspaceBuffers()
      }
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
    onWorkspaceChanged: (event) => {
      void reconcileBuffersRef.current(event).then((warnings) => {
        if (warnings.length > 0) {
          reportErrorBanner(warnings.join(' '))
        }
      })
      void refreshGitStatusRef.current()
    },
    onFileCreated: editor.openCreatedFile,
    onEntryRenamed: editor.syncRenamedPath,
    onEntryDeleted: editor.syncDeletedPath
  })
  hadOpenWorkspaceRef.current = workspace !== null

  onInitialConfigLoadedRef.current = (loadedConfig) => {
    if (
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
    return () => {
      pendingGitConfirmCancelRef.current?.()
    }
  }, [])

  useWindowCloseGuard({
    wikiApi,
    getDirtySummary: editor.getDirtyCloseSummary,
    saveDirtyBuffers: editor.ensureCloseBuffersSaved,
    confirmUnsavedChanges,
    onBeforeShowDialog: () => pendingGitConfirmCancelRef.current?.()
  })

  const { ensureAllWorkspaceBuffersSaved, getDirtyWorkspaceSummary } = editor
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
        pendingGitConfirmCancelRef.current = confirmUnsavedChanges({
          message: options.message(dirtySummary),
          confirmLabel: options.confirmLabel,
          secondaryLabel: options.secondaryLabel,
          onSave: ensureAllWorkspaceBuffersSaved,
          onResolve: (accepted) => {
            pendingGitConfirmCancelRef.current = null
            resolve(accepted)
          }
        })
      })
    },
    [
      confirmUnsavedChanges,
      ensureAllWorkspaceBuffersSaved,
      getDirtyWorkspaceSummary
    ]
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
    return await reconcileBuffersRef.current()
  }, [refreshTree])

  const git = useGitController({
    workspaceRootPath: workspace?.rootPath ?? null,
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
      if (!hadOpenWorkspaceRef.current) {
        void openWorkspace(targetPath)
        return
      }
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
  }, [handleSwitchWorkspace, isDialogOpenRef, reportErrorBanner, wikiApi])

  const { openWorkspaceFile, openConfigDocument, openDiffTab } = editor
  const { diffsByKey, refreshDiffRequest } = useGitDiffTabs({
    workspaceRootPath: workspace?.rootPath ?? null,
    gitStatus: git.status,
    layout: editor.layout
  })

  const handleOpenFileDiff = useCallback(
    (request: GitDiffRequest): void => {
      openDiffTab(request)
      refreshDiffRequest(request)
    },
    [openDiffTab, refreshDiffRequest]
  )

  const handleOpenDiffTargetFile = useCallback(
    (repoRelativePath: string): void => {
      const target = resolveRepoFileInWorkspace(
        git.status?.repoRoot,
        workspace?.rootPath,
        repoRelativePath
      )
      if (!target) return
      void openWorkspaceFile(target.path, undefined, getGitFileBaseName(repoRelativePath))
    },
    [git.status?.repoRoot, openWorkspaceFile, workspace?.rootPath]
  )
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
    return wikiApi.menu.onCommand((command) => {
      if (isDialogOpenRef.current) {
        return
      }
      menuHandlersRef.current[command]?.()
    })
  }, [isDialogOpenRef, wikiApi])

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
    [deleteEntry, setPendingDialog]
  )

  const handleCopyEntryPath = useCallback(
    (entry: WorkspaceEntry, mode: EntryPathCopyMode): void => {
      reportErrorBanner(null)
      const textToCopy =
        mode === 'relative'
          ? formatRelativeEntryPath(entry, workspace?.rootPath)
          : formatAbsoluteEntryPath(entry)

      void writeTextToClipboard(wikiApi, textToCopy).catch((error: unknown) => {
        reportErrorBanner(toErrorMessage(error, '경로를 클립보드에 복사하지 못했습니다.'), error)
      })
    },
    [reportErrorBanner, wikiApi, workspace?.rootPath]
  )

  const handleReportImageError = useCallback(
    (title: string, error: unknown): void => {
      const detail = toErrorMessage(error, '')
      reportErrorBanner(detail ? `${title}: ${detail}` : title, error)
    },
    [reportErrorBanner]
  )

  const {
    setDraggingWorkspaceImagePath,
    clearDraggingWorkspaceImage,
    imageTransferContextValue
  } = useWorkspaceImageTransfer(handleReportImageError)

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...editor.paneActions,
      onOpenDiffTargetFile: handleOpenDiffTargetFile
    }),
    [editor.paneActions, handleOpenDiffTargetFile]
  )

  const isCurrentWorkspaceFavorite =
    workspace !== null && isFavoriteWorkspacePath(config.favoriteWorkspaces, workspace.rootPath)
  const gitChangedCount = workspace?.rootPath ? getGitChangedCount(git.status) : 0

  const leftSidebarSlot = (
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
                activeFilePath={editor.activeFilePath}
                onSelectPath={setSelectedTreePath}
                onToggleDirectory={toggleDirectory}
                onEnsureExpanded={ensureExpanded}
                onResolveCreateParentDir={resolveCreateParentDir}
                onOpenFile={handleOpenFile}
                onRefreshTree={() => void refreshTree()}
                onCreateEntry={createEntry}
                onRenameEntry={renameEntry}
                onRequestDelete={handleRequestDelete}
                onCopyEntryPath={handleCopyEntryPath}
                onDragStartWorkspaceImage={setDraggingWorkspaceImagePath}
                onDragEndWorkspaceImage={clearDraggingWorkspaceImage}
              />
            )}

            {leftSidebar.activeView === 'git' && (
              <GitSidebarPanel
                workspaceRootPath={workspace?.rootPath ?? null}
                status={git.status}
                branchList={git.branchList}
                graphState={git.graphState}
                pendingAction={git.pendingAction}
                errorMessage={git.errorMessage}
                splitState={gitPanelSplit}
                onDismissError={git.dismissError}
                onRefresh={() => void git.refreshStatus()}
                onChangeLogScope={(nextScope) => void git.changeLogScope(nextScope)}
                onLoadMoreCommits={() => void git.loadMoreCommits()}
                onToggleCommitDetail={(commitHash) => void git.toggleCommitDetail(commitHash)}
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
                onOpenFileDiff={handleOpenFileDiff}
                onToggleChangesCollapsed={handleToggleGitChangesCollapsed}
                onToggleGraphCollapsed={handleToggleGitGraphCollapsed}
                onResizeChangesRatio={handleResizeGitChangesRatio}
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
  )

  const settingsPanelSlot = isSettingsOpen ? (
    <SettingsPanel
      theme={config.theme}
      autoSave={config.autoSave}
      configPath={configPath}
      isDismissDisabled={pendingDialog !== null}
      onToggleTheme={toggleTheme}
      onToggleAutoSave={toggleAutoSave}
      onOpenConfigEditor={handleOpenConfigEditor}
      onClose={() => setIsSettingsOpen(false)}
    />
  ) : undefined

  return (
    <EditorWindowFrame
      errorMessage={errorMessage}
      pendingDialog={pendingDialog}
      onDismissDialog={dismissDialog}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      workspaceRootPath={workspace?.rootPath ?? null}
      openWorkspaceFile={openWorkspaceFile}
      reportErrorBanner={reportErrorBanner}
      imageTransferContextValue={imageTransferContextValue}
      paneWorkspaceProps={buildPaneWorkspaceProps(
        config,
        { ...editor, paneActions },
        isEditorShortcutDisabled,
        {
          diffsByKey,
          workspaceMarkdownFiles: markdownFiles
        }
      )}
      leftSidebarSlot={leftSidebarSlot}
      settingsPanelSlot={settingsPanelSlot}
    />
  )
}
