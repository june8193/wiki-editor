import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig } from '@shared/config'
import type { AppMenuCommand, WikiApi } from '@shared/ipc'
import { getGitChangedCount, type GitDiffRequest } from '@shared/git'
import {
  filterTopLevelWorkspaceEntries,
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  isFavoriteWorkspacePath,
  isSameWorkspacePath,
  resolveRepoFileInWorkspace,
  type WorkspaceChangeEvent,
  type WorkspaceEntry
} from '@shared/workspace'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useWorkspaceImageTransfer } from '../hooks/useEditorImageTransfer'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useGitController, type WorkspaceDiscardTarget } from '../hooks/useGitController'
import { useGitDiffTabs } from '../hooks/useGitDiffTabs'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useWorkspaceStatePersistence } from '../hooks/useWorkspaceStatePersistence'
import { type RestoredWorkspaceContext, useWorkspaceTree } from '../hooks/useWorkspaceTree'
import { buildDiscardAllConfirmMessage, getGitFileBaseName } from '../utils/gitFilePresentation'
import {
  createDefaultGitChangesViewState,
  resetGitChangesTreeCollapsedDirs,
  toggleGitChangesGroupCollapsed,
  toggleGitChangesTreeDirCollapsed,
  toggleGitChangesViewMode,
  type GitChangesGroupKey,
  type GitChangesViewState
} from '../utils/gitChangesView'
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

function transitionWorkspaceSidebarToExplorer(prev: LeftSidebarState): LeftSidebarState {
  return prev.activeView === 'workspace' && !prev.isCollapsed
    ? { ...prev, activeView: 'explorer', isCollapsed: false }
    : prev
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
    confirmUnsavedChanges,
    confirmAction
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
  const [gitChangesView, setGitChangesView] = useState<GitChangesViewState>(
    createDefaultGitChangesViewState
  )
  const [isGitWorkspaceMutating, setIsGitWorkspaceMutating] = useState(false)

  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const refreshGitStatusRef = useRef<() => Promise<void>>(async () => undefined)
  const activeWorkspaceRootRef = useRef<string | null>(null)
  const activeGitRepoRootRef = useRef<string | null>(null)
  const activeDiscardTargetPathsRef = useRef<readonly string[] | null>(null)
  const onInitialConfigLoadedRef = useRef<(loadedConfig: AppConfig) => void>(() => undefined)
  const tryStartupWorkspaceOpenRef = useRef<() => void>(() => undefined)
  const startupInitRef = useRef<{
    initResolved: boolean
    initialWorkspacePath: string | null
    loadedConfig: AppConfig | null
  }>({
    initResolved: !wikiApi.window?.getInitContext,
    initialWorkspacePath: null,
    loadedConfig: null
  })
  const onWorkspaceRestoredRef = useRef<
    (context: RestoredWorkspaceContext) => Promise<void> | void
  >(() => undefined)
  const workspaceRestoreSeqRef = useRef<number>(0)

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
    isAutoSavePaused: pendingDialog !== null || isGitWorkspaceMutating,
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

  const handleToggleGitChangesViewMode = useCallback((): void => {
    setGitChangesView(toggleGitChangesViewMode)
  }, [])

  const handleToggleGitChangesGroupCollapsed = useCallback((group: GitChangesGroupKey): void => {
    setGitChangesView((prev) => toggleGitChangesGroupCollapsed(prev, group))
  }, [])

  const handleToggleGitChangesTreeDirCollapsed = useCallback((dirKey: string): void => {
    setGitChangesView((prev) => toggleGitChangesTreeDirCollapsed(prev, dirKey))
  }, [])

  const isSelectingFolderRef = useRef<boolean>(false)
  const hasWorkspaceInteractionRef = useRef<boolean>(false)
  const isStartupRestoreRef = useRef<boolean>(false)
  const hadOpenWorkspaceRef = useRef<boolean>(false)
  const isMountedRef = useRef<boolean>(true)
  const switchWorkspaceSeqRef = useRef<number>(0)
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
    toggleSelectTreePath,
    selectTreePathRange,
    resolveCreateParentDir,
    openWorkspace,
    refreshTree,
    toggleDirectory,
    ensureExpanded,
    createEntry,
    renameEntry,
    moveEntries,
    deleteEntries
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
      setLeftSidebar(transitionWorkspaceSidebarToExplorer)
    },
    onWorkspaceRestored: (context) => onWorkspaceRestoredRef.current(context),
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

  const activeWorkspaceRoot = workspace?.rootPath ?? null
  useEffect(() => {
    setGitChangesView(resetGitChangesTreeCollapsedDirs)
  }, [activeWorkspaceRoot])

  const workspaceStatePersistence = useWorkspaceStatePersistence({
    workspaceRootPath: workspace?.rootPath ?? null,
    expandedDirs: treeState.expandedDirs,
    layoutSnapshot: editor.layoutSnapshot,
    getLatestLayoutSnapshot: editor.getLayoutSnapshot
  })
  onWorkspaceRestoredRef.current = (context) => {
    const restoreSeq = ++workspaceRestoreSeqRef.current
    return editor
      .restoreWorkspaceLayout({
        rootPath: context.rootPath,
        persistedLayout: context.persistedState?.layout ?? null,
        rootEntries: context.rootEntries,
        restoredChildrenByDir: context.restoredChildrenByDir,
        readDir: (dirPath) => wikiApi.workspace.readDir(dirPath),
        isCancelled: () => restoreSeq !== workspaceRestoreSeqRef.current
      })
      .then(({ restored, hadPrunedTabs, reconciledLayout }) => {
        if (!restored || restoreSeq !== workspaceRestoreSeqRef.current) {
          return
        }
        workspaceStatePersistence.markRestored({
          rootPath: context.rootPath,
          persistedState: context.persistedState,
          restoredExpandedDirs: context.restoredExpandedDirs,
          restoredLayout: reconciledLayout,
          hadPrunedState: context.hadPrunedExpandedDirs || hadPrunedTabs
        })
      })
  }

  tryStartupWorkspaceOpenRef.current = () => {
    if (
      hasWorkspaceInteractionRef.current ||
      isSelectingFolderRef.current ||
      activeWorkspaceRootRef.current !== null
    ) {
      return
    }
    const { initResolved, initialWorkspacePath, loadedConfig } = startupInitRef.current
    if (!initResolved) {
      return
    }

    const startStartupWorkspaceOpen = (
      targetPath: string,
      options?: { silentError?: boolean; onSilentError?: () => void }
    ): void => {
      hasWorkspaceInteractionRef.current = true
      isStartupRestoreRef.current = true
      void openWorkspace(targetPath, options).finally(() => {
        isStartupRestoreRef.current = false
      })
    }

    if (initialWorkspacePath) {
      startStartupWorkspaceOpen(initialWorkspacePath)
      return
    }

    const lastWorkspacePath = loadedConfig?.recentWorkspaces[0]
    if (!lastWorkspacePath) {
      return
    }
    startStartupWorkspaceOpen(lastWorkspacePath, {
      silentError: true,
      onSilentError: () => removeRecentWorkspace(lastWorkspacePath)
    })
  }

  onInitialConfigLoadedRef.current = (loadedConfig) => {
    startupInitRef.current.loadedConfig = loadedConfig
    tryStartupWorkspaceOpenRef.current()
  }

  useEffect(() => {
    let cancelled = false
    const finalizeInitContext = (initialPath: string | null): void => {
      if (cancelled) return
      startupInitRef.current.initResolved = true
      startupInitRef.current.initialWorkspacePath = initialPath
      tryStartupWorkspaceOpenRef.current()
    }

    const getInitContext = wikiApi.window?.getInitContext
    if (!getInitContext) {
      finalizeInitContext(null)
      return
    }

    startupInitRef.current.initResolved = false
    startupInitRef.current.initialWorkspacePath = null
    void getInitContext()
      .then((context) => context?.initialWorkspacePath?.trim() || null)
      .catch(() => null)
      .then(finalizeInitContext)

    return () => {
      cancelled = true
    }
  }, [wikiApi])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      pendingGitConfirmCancelRef.current?.()
    }
  }, [])

  useWindowCloseGuard({
    wikiApi,
    getDirtySummary: editor.getDirtyCloseSummary,
    saveDirtyBuffers: editor.ensureCloseBuffersSaved,
    confirmUnsavedChanges,
    onBeforeShowDialog: () => pendingGitConfirmCancelRef.current?.(),
    onBeforeApproveClose: workspaceStatePersistence.flush
  })

  activeWorkspaceRootRef.current = workspace?.rootPath ?? null

  const {
    ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary,
    closeUnstagedDiffTabsForPaths,
    closeAllUnstagedDiffTabs,
    prepareWorkspacePathsForDiscard,
    finishWorkspacePathsDiscard
  } = editor

  const resolveTargetWorkspacePaths = useCallback((targetRepoPaths: readonly string[]): string[] => {
    const workspaceRoot = activeWorkspaceRootRef.current
    if (!workspaceRoot) return []
    const repoRoot = activeGitRepoRootRef.current ?? workspaceRoot
    const resolved: string[] = []
    for (const repoRelativePath of targetRepoPaths) {
      const resolvedEntry = resolveRepoFileInWorkspace(repoRoot, workspaceRoot, repoRelativePath)
      if (resolvedEntry) {
        resolved.push(resolvedEntry.path)
      }
    }
    return resolved
  }, [])

  const awaitGitConfirm = useCallback(
    (openDialog: (onResolve: (approved: boolean) => void) => () => void): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        pendingGitConfirmCancelRef.current = openDialog((approved) => {
          pendingGitConfirmCancelRef.current = null
          resolve(approved)
        })
      }),
    []
  )

  const promptUnsavedWorkspaceChanges = useCallback(
    (options: {
      targetPaths?: readonly string[]
      message: (dirtySummary: string) => string
      confirmLabel: string
      secondaryLabel: string
    }): Promise<boolean> => {
      const dirtySummary = getDirtyWorkspaceSummary(options.targetPaths)
      if (!dirtySummary) {
        return Promise.resolve(true)
      }

      return awaitGitConfirm((onResolve) =>
        confirmUnsavedChanges({
          message: options.message(dirtySummary),
          confirmLabel: options.confirmLabel,
          secondaryLabel: options.secondaryLabel,
          onSave: () => ensureAllWorkspaceBuffersSaved(options.targetPaths),
          onResolve
        })
      )
    },
    [
      awaitGitConfirm,
      confirmUnsavedChanges,
      ensureAllWorkspaceBuffersSaved,
      getDirtyWorkspaceSummary
    ]
  )

  const confirmDirtyBuffersBeforeGitMutation = useCallback(
    (actionLabel: string, targetRepoPaths?: readonly string[]): Promise<boolean> => {
      const targetPaths = targetRepoPaths
        ? resolveTargetWorkspacePaths(targetRepoPaths)
        : undefined
      return promptUnsavedWorkspaceChanges({
        targetPaths,
        message: (dirtySummary) =>
          `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. ${actionLabel} 전에 어떻게 할까요?`,
        confirmLabel: '저장 후 진행',
        secondaryLabel: '저장 없이 진행'
      })
    },
    [promptUnsavedWorkspaceChanges, resolveTargetWorkspacePaths]
  )

  const confirmAutoStageCommit = useCallback(
    (): Promise<boolean> =>
      awaitGitConfirm((onResolve) =>
        confirmAction({
          title: '자동 Stage 후 커밋',
          message:
            '스테이지된 변경 사항이 없습니다. 모든 변경 사항을 자동으로 Stage하고 커밋할까요?',
          confirmLabel: 'Stage 후 커밋',
          onResolve
        })
      ),
    [awaitGitConfirm, confirmAction]
  )

  const handleBeforeWorkspaceDiscard = useCallback(
    async (target: WorkspaceDiscardTarget): Promise<void> => {
      const targetPaths = resolveTargetWorkspacePaths(target.paths)
      activeDiscardTargetPathsRef.current = targetPaths
      if (targetPaths.length === 0) return
      await prepareWorkspacePathsForDiscard(targetPaths)
    },
    [prepareWorkspacePathsForDiscard, resolveTargetWorkspacePaths]
  )

  const handleAfterWorkspaceDiscard = useCallback(
    async (target: WorkspaceDiscardTarget, succeeded: boolean): Promise<void> => {
      const targetPaths =
        activeDiscardTargetPathsRef.current ?? resolveTargetWorkspacePaths(target.paths)
      activeDiscardTargetPathsRef.current = null
      if (targetPaths.length > 0) {
        await finishWorkspacePathsDiscard(targetPaths, succeeded)
      }
      if (succeeded) {
        if (target.scope === 'all') {
          closeAllUnstagedDiffTabs()
        } else {
          closeUnstagedDiffTabsForPaths(target.paths)
        }
        await refreshTree()
      }
    },
    [
      closeAllUnstagedDiffTabs,
      closeUnstagedDiffTabsForPaths,
      finishWorkspacePathsDiscard,
      refreshTree,
      resolveTargetWorkspacePaths
    ]
  )

  const handleGitWorkspaceMutated = useCallback(async (): Promise<readonly string[]> => {
    await refreshTree()
    return await reconcileBuffersRef.current()
  }, [refreshTree])

  const git = useGitController({
    workspaceRootPath: workspace?.rootPath ?? null,
    confirmAutoStageCommit,
    confirmBeforeWorkspaceMutation: confirmDirtyBuffersBeforeGitMutation,
    onBeforeWorkspaceDiscard: handleBeforeWorkspaceDiscard,
    onAfterWorkspaceDiscard: handleAfterWorkspaceDiscard,
    onWorkspaceMutated: handleGitWorkspaceMutated,
    onWorkspaceMutationActiveChange: setIsGitWorkspaceMutating
  })
  activeGitRepoRootRef.current = git.status?.repoRoot ?? null
  refreshGitStatusRef.current = git.refreshStatus

  const handleRequestDiscardAll = useCallback((): void => {
    if (isDialogOpenRef.current || git.pendingAction !== null || !git.status?.isRepo) {
      return
    }
    const trackedCount = git.status.unstaged.length
    const untrackedCount = git.status.untracked.length
    if (trackedCount === 0 && untrackedCount === 0) {
      return
    }
    setPendingDialog({
      title: '전체 변경 사항 롤백',
      message: buildDiscardAllConfirmMessage(trackedCount, untrackedCount),
      confirmLabel: '전체 롤백',
      confirmTone: 'danger',
      onConfirm: () => {
        setPendingDialog(null)
        void git.discardAll()
      }
    })
  }, [git.discardAll, git.pendingAction, git.status, isDialogOpenRef, setPendingDialog])

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

  /**
   * Attempts to focus an existing main window holding `targetPath` and returns
   * whether the current window should proceed with a local workspace switch.
   */
  const focusExistingAndCheckProceed = useCallback(
    async (targetPath: string, switchSeq: number): Promise<boolean> => {
      const focusIfOpen = wikiApi.workspace.focusIfOpen
      if (!focusIfOpen) {
        return true
      }
      let focused = false
      try {
        focused = (await focusIfOpen(targetPath)).focused
      } catch {
        focused = false
      }
      if (!isMountedRef.current || switchSeq !== switchWorkspaceSeqRef.current) {
        return false
      }
      if (focused) {
        reportErrorBanner(null)
        return false
      }
      return true
    },
    [reportErrorBanner, wikiApi]
  )

  const proceedSwitchAfterFocusCheck = useCallback(
    (targetPath: string, switchSeq: number): void => {
      if (isDialogOpenRef.current) {
        return
      }
      if (!hadOpenWorkspaceRef.current) {
        void openWorkspace(targetPath)
        return
      }
      guardUnsavedWorkspaceChanges(async () => {
        if (!(await focusExistingAndCheckProceed(targetPath, switchSeq))) {
          return
        }
        const prevRoot = activeWorkspaceRootRef.current
        await workspaceStatePersistence.suspendAndFlush()
        const openResult = await openWorkspace(targetPath)
        if (
          openResult === 'failed' &&
          prevRoot &&
          activeWorkspaceRootRef.current &&
          isSameWorkspacePath(activeWorkspaceRootRef.current, prevRoot)
        ) {
          workspaceStatePersistence.resumeForWorkspace(prevRoot)
        }
      })
    },
    [
      focusExistingAndCheckProceed,
      guardUnsavedWorkspaceChanges,
      isDialogOpenRef,
      openWorkspace,
      workspaceStatePersistence
    ]
  )

  const handleSwitchWorkspace = useCallback(
    (targetPath: string): void => {
      hasWorkspaceInteractionRef.current = true
      isStartupRestoreRef.current = false
      const currentRoot = activeWorkspaceRootRef.current
      if (currentRoot && isSameWorkspacePath(currentRoot, targetPath)) {
        switchWorkspaceSeqRef.current += 1
        setLeftSidebar(transitionWorkspaceSidebarToExplorer)
        return
      }
      const switchSeq = ++switchWorkspaceSeqRef.current
      if (!wikiApi.workspace.focusIfOpen) {
        proceedSwitchAfterFocusCheck(targetPath, switchSeq)
        return
      }
      void focusExistingAndCheckProceed(targetPath, switchSeq).then((shouldProceed) => {
        if (shouldProceed) {
          proceedSwitchAfterFocusCheck(targetPath, switchSeq)
        }
      })
    },
    [focusExistingAndCheckProceed, proceedSwitchAfterFocusCheck, wikiApi]
  )

  const handleOpenWorkspaceInNewWindow = useCallback(
    (targetPath: string): void => {
      const openInNewWindow = wikiApi.workspace.openInNewWindow
      if (!openInNewWindow) {
        reportErrorBanner('새 창에서 워크스페이스를 열 수 없습니다.')
        return
      }
      reportErrorBanner(null)
      void openInNewWindow(targetPath).catch((error: unknown) => {
        reportErrorBanner(
          toErrorMessage(error, '새 창에서 워크스페이스를 열지 못했습니다.'),
          error
        )
      })
    },
    [reportErrorBanner, wikiApi]
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

  const handleOpenRepoWorkspaceFile = useCallback(
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
    (entries: readonly WorkspaceEntry[]): void => {
      const targets = filterTopLevelWorkspaceEntries(entries)
      if (targets.length === 0) return

      const message =
        targets.length === 1
          ? `"${targets[0].name}"을(를) 삭제하시겠습니까?`
          : `선택한 ${targets.length}개 항목을 삭제하시겠습니까?`

      setPendingDialog({
        title: '항목 삭제',
        message,
        confirmLabel: '삭제 확인',
        onConfirm: async () => {
          setPendingDialog(null)
          await deleteEntries(targets)
        }
      })
    },
    [deleteEntries, setPendingDialog]
  )

  const handleCopyEntryPath = useCallback(
    (entries: readonly WorkspaceEntry[], mode: EntryPathCopyMode): void => {
      if (entries.length === 0) return
      reportErrorBanner(null)
      const textToCopy = entries
        .map((entry) =>
          mode === 'relative'
            ? formatRelativeEntryPath(entry, workspace?.rootPath)
            : formatAbsoluteEntryPath(entry)
        )
        .join('\n')

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
    setDraggingWorkspaceImagePaths,
    clearDraggingWorkspaceImage,
    imageTransferContextValue
  } = useWorkspaceImageTransfer(handleReportImageError)

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...editor.paneActions,
      onOpenDiffTargetFile: handleOpenRepoWorkspaceFile
    }),
    [editor.paneActions, handleOpenRepoWorkspaceFile]
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
                onOpenInNewWindow={handleOpenWorkspaceInNewWindow}
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
                onToggleSelectPath={toggleSelectTreePath}
                onSelectPathRange={selectTreePathRange}
                onToggleDirectory={toggleDirectory}
                onEnsureExpanded={ensureExpanded}
                onResolveCreateParentDir={resolveCreateParentDir}
                onOpenFile={handleOpenFile}
                onRefreshTree={() => void refreshTree()}
                onCreateEntry={createEntry}
                onRenameEntry={renameEntry}
                onMoveEntries={moveEntries}
                onRequestDelete={handleRequestDelete}
                onCopyEntryPath={handleCopyEntryPath}
                onDragStartWorkspaceImages={setDraggingWorkspaceImagePaths}
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
                changesViewState={gitChangesView}
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
                onDiscardFile={(path) => void git.discardFile(path)}
                onDiscardAll={handleRequestDiscardAll}
                onCommit={git.commit}
                onCheckoutBranch={(branchName) => void git.checkoutBranch(branchName)}
                onPull={() => void git.pull()}
                onPush={() => void git.push()}
                onFetch={() => void git.fetch()}
                onSync={() => void git.sync()}
                onOpenFileDiff={handleOpenFileDiff}
                onOpenWorkspaceFile={handleOpenRepoWorkspaceFile}
                onToggleChangesCollapsed={handleToggleGitChangesCollapsed}
                onToggleGraphCollapsed={handleToggleGitGraphCollapsed}
                onResizeChangesRatio={handleResizeGitChangesRatio}
                onToggleChangesViewMode={handleToggleGitChangesViewMode}
                onToggleChangesGroupCollapsed={handleToggleGitChangesGroupCollapsed}
                onToggleChangesTreeDirCollapsed={handleToggleGitChangesTreeDirCollapsed}
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
