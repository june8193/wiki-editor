import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig } from '@shared/config'
import type { AppMenuCommand, WikiApi } from '@shared/ipc'
import { getGitChangedCount } from '@shared/git'
import type { WorkspaceSearchFileResult } from '@shared/search'
import {
  filterTopLevelWorkspaceEntries,
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  isFavoriteWorkspacePath,
  isSameWorkspacePath,
  type WorkspaceChangeEvent,
  type WorkspaceEntry
} from '@shared/workspace'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { promptUnsavedWorkspaceChanges } from '../utils/confirmPrompts'
import { useWorkspaceImageTransfer } from '../hooks/useEditorImageTransfer'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useFrontmatterFieldValues } from '../hooks/useFrontmatterFieldValues'
import { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
import { type GitSessionRuntimeCollaborators, useGitSession } from '../hooks/useGitSession'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useWorkspaceSearch } from '../hooks/useWorkspaceSearch'
import { useWorkspaceSearchJump } from '../hooks/useWorkspaceSearchJump'
import { useWorkspaceStatePersistence } from '../hooks/useWorkspaceStatePersistence'
import { type RestoredWorkspaceContext, useWorkspaceTree } from '../hooks/useWorkspaceTree'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH
} from '../utils/sidebarWidth'
import {
  isEventOutsideShell,
  isWorkspaceSearchShortcut,
  type SearchFocusRequest
} from '../utils/workspaceSearch'
import { ActivityBar, type LeftSidebarView } from './ActivityBar'
import { buildPaneWorkspaceProps, EditorWindowFrame } from './EditorWindowFrame'
import { type EntryPathCopyMode, FolderTreeSidebar } from './FolderTreeSidebar'
import { FrontmatterFilterBar } from './FrontmatterFilterBar'
import { GitSidebarPanel } from './GitSidebarPanel'
import type { PaneInteractionActions } from './PaneTabBar'
import { SearchSidebarPanel } from './SearchSidebarPanel'
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
    requestUnsavedChanges,
    requestConfirm
  } = useConfirmDialog()
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [isSchemaModalOpen, setIsSchemaModalOpen] = useState<boolean>(false)
  const gitCollaboratorsRef = useRef<GitSessionRuntimeCollaborators | null>(null)
  const gitConfirm = useMemo(
    () => ({
      confirmAction: requestConfirm,
      confirmUnsavedChanges: requestUnsavedChanges,
      isDialogOpen: () => isDialogOpenRef.current
    }),
    [isDialogOpenRef, requestConfirm, requestUnsavedChanges]
  )
  const git = useGitSession({
    confirm: gitConfirm,
    collaboratorsRef: gitCollaboratorsRef
  })
  const { setWorkspaceRootPath: setGitWorkspaceRootPath, isStashDialogOpen } = git
  const closeStashDialog = git.actions.closeStashDialog
  const hasActiveModalDialog =
    pendingDialog !== null || git.panelState.stashDialogScope !== null
  const isAnyDialogOpen = useCallback(
    (): boolean => isDialogOpenRef.current || isStashDialogOpen(),
    [isDialogOpenRef, isStashDialogOpen]
  )
  const [leftSidebar, setLeftSidebar] = useState<LeftSidebarState>({
    activeView: 'workspace',
    isCollapsed: false,
    width: LEFT_SIDEBAR_DEFAULT_WIDTH
  })
  const [searchFocusRequest, setSearchFocusRequest] = useState<SearchFocusRequest | null>(null)

  const shellRef = useRef<HTMLDivElement | null>(null)
  const searchFocusNonceRef = useRef<number>(0)
  const leftSidebarRef = useRef<LeftSidebarState>(leftSidebar)
  leftSidebarRef.current = leftSidebar
  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const activeWorkspaceRootRef = useRef<string | null>(null)
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

  const isEditorShortcutDisabled = hasActiveModalDialog || isSettingsOpen || isSchemaModalOpen
  const isEditorShortcutDisabledRef = useRef<boolean>(isEditorShortcutDisabled)
  isEditorShortcutDisabledRef.current = isEditorShortcutDisabled
  const editor = useEditorWorkspace({
    isAutoSavePaused: hasActiveModalDialog || git.isMutating,
    isShortcutDisabled: isEditorShortcutDisabled,
    onWorkspaceSaved: () => void git.actions.refreshStatus(),
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

  const focusSearchInput = useCallback((selectAll: boolean): void => {
    searchFocusNonceRef.current += 1
    setSearchFocusRequest({ nonce: searchFocusNonceRef.current, selectAll })
  }, [])

  const hasUserSelectedSidebarViewRef = useRef<boolean>(false)
  const handleSelectLeftSidebarView = useCallback(
    (view: LeftSidebarView): void => {
      hasUserSelectedSidebarViewRef.current = true
      const current = leftSidebarRef.current
      const next = selectLeftSidebarView(current, view)
      if (next.isCollapsed || next.activeView !== 'git') {
        closeStashDialog()
      }
      const willOpenSearch =
        view === 'search' && (current.isCollapsed || current.activeView !== 'search')
      setLeftSidebar(next)
      if (willOpenSearch) {
        focusSearchInput(false)
      }
    },
    [closeStashDialog, focusSearchInput]
  )

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditorShortcutDisabledRef.current) {
        return
      }
      if (!isWorkspaceSearchShortcut(event)) {
        return
      }
      if (isEventOutsideShell(event.target, shellRef.current)) {
        return
      }
      event.preventDefault()
      hasUserSelectedSidebarViewRef.current = true
      setLeftSidebar((prev) =>
        prev.activeView === 'search' && !prev.isCollapsed
          ? prev
          : { ...prev, activeView: 'search', isCollapsed: false }
      )
      focusSearchInput(true)
    }

    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [focusSearchInput])

  const handleResizeLeftSidebar = useCallback((nextWidth: number): void => {
    setLeftSidebar((prev) => (prev.width === nextWidth ? prev : { ...prev, width: nextWidth }))
  }, [])

  const isSelectingFolderRef = useRef<boolean>(false)
  const hasWorkspaceInteractionRef = useRef<boolean>(false)
  const isStartupRestoreRef = useRef<boolean>(false)
  const hadOpenWorkspaceRef = useRef<boolean>(false)
  const isMountedRef = useRef<boolean>(true)
  const switchWorkspaceSeqRef = useRef<number>(0)
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
      void git.actions.refreshStatus()
    },
    onFileCreated: editor.openCreatedFile,
    onEntryRenamed: editor.syncRenamedPath,
    onEntryDeleted: editor.syncDeletedPath
  })
  hadOpenWorkspaceRef.current = workspace !== null

  const activeWorkspaceRoot = workspace?.rootPath ?? null
  useEffect(() => {
    setIsSchemaModalOpen(false)
  }, [activeWorkspaceRoot])

  const frontmatterSchema = useFrontmatterSchema({
    workspaceRootPath: activeWorkspaceRoot,
    onError: reportErrorBanner
  })
  const frontmatterFieldValues = useFrontmatterFieldValues({
    workspaceRootPath: activeWorkspaceRoot,
    schema: frontmatterSchema.schemaResult?.schema ?? null,
    activeDocumentKey: editor.activeBuffer?.key ?? null
  })

  const workspaceSearch = useWorkspaceSearch({
    workspaceRootPath: activeWorkspaceRoot,
    schema: frontmatterSchema.schemaResult?.schema ?? null
  })

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
      dismissDialog()
    }
  }, [dismissDialog])

  useWindowCloseGuard({
    wikiApi,
    getDirtySummary: editor.getDirtyCloseSummary,
    saveDirtyBuffers: editor.ensureCloseBuffersSaved,
    confirmUnsavedChanges,
    onBeforeShowDialog: () => {
      closeStashDialog()
      dismissDialog()
    },
    onBeforeApproveClose: workspaceStatePersistence.flush
  })

  activeWorkspaceRootRef.current = workspace?.rootPath ?? null

  const guardUnsavedWorkspaceChanges = useCallback(
    (proceed: () => Promise<unknown>): void => {
      void promptUnsavedWorkspaceChanges(
        {
          getDirtySummary: editor.getDirtyWorkspaceSummary,
          saveDirtyBuffers: editor.ensureAllWorkspaceBuffersSaved
        },
        requestUnsavedChanges,
        {
          message: (dirtySummary) =>
            `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 어떻게 할까요?`,
          confirmLabel: '저장 후 이동',
          secondaryLabel: '버리고 이동'
        }
      ).then((accepted) => {
        if (accepted) {
          void proceed()
        }
      })
    },
    [editor.ensureAllWorkspaceBuffersSaved, editor.getDirtyWorkspaceSummary, requestUnsavedChanges]
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
      if (isAnyDialogOpen()) {
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
      isAnyDialogOpen,
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
    if (isAnyDialogOpen() || isSelectingFolderRef.current) {
      return
    }

    isSelectingFolderRef.current = true
    hasWorkspaceInteractionRef.current = true
    isStartupRestoreRef.current = false
    reportErrorBanner(null)
    void wikiApi.workspace.selectFolder().then(
      (selectedPath) => {
        isSelectingFolderRef.current = false
        if (selectedPath && !isAnyDialogOpen()) {
          handleSwitchWorkspace(selectedPath)
        }
      },
      (error: unknown) => {
        isSelectingFolderRef.current = false
        reportErrorBanner(toErrorMessage(error, '폴더 선택에 실패했습니다.'), error)
      }
    )
  }, [handleSwitchWorkspace, isAnyDialogOpen, reportErrorBanner, wikiApi])

  const { openWorkspaceFile, openConfigDocument } = editor
  const { searchJumpRequest, openSearchLineMatch, invalidatePendingSearchJumps } =
    useWorkspaceSearchJump({
      workspaceRootPath: workspace?.rootPath ?? null,
      layout: editor.layout,
      query: workspaceSearch.query,
      responseQuery: workspaceSearch.response?.query ?? null,
      options: workspaceSearch.resultOptions,
      isMountedRef,
      switchWorkspaceSeqRef,
      openWorkspaceFile
    })

  gitCollaboratorsRef.current = {
    editor,
    refreshTree,
    onBeforeOpenTab: invalidatePendingSearchJumps
  }

  useEffect(() => {
    setGitWorkspaceRootPath(activeWorkspaceRoot)
  }, [activeWorkspaceRoot, setGitWorkspaceRootPath])
  const handleOpenFile = useCallback(
    (entry: WorkspaceEntry): void => {
      invalidatePendingSearchJumps()
      void openWorkspaceFile(entry)
    },
    [invalidatePendingSearchJumps, openWorkspaceFile]
  )
  const handleOpenSearchResultFile = useCallback(
    (file: WorkspaceSearchFileResult): void => {
      invalidatePendingSearchJumps()
      void openWorkspaceFile(file.path, undefined, file.name)
    },
    [invalidatePendingSearchJumps, openWorkspaceFile]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    invalidatePendingSearchJumps()
    setIsSettingsOpen(false)
    void openConfigDocument()
  }, [invalidatePendingSearchJumps, openConfigDocument])

  menuHandlersRef.current = {
    'open-folder': handleSelectFolder,
    'toggle-theme': toggleTheme,
    'toggle-settings': () => {
      setIsSchemaModalOpen(false)
      setIsSettingsOpen((open) => !open)
    }
  }

  useEffect(() => {
    return wikiApi.menu.onCommand((command) => {
      if (isAnyDialogOpen()) {
        return
      }
      menuHandlersRef.current[command]?.()
    })
  }, [isAnyDialogOpen, wikiApi])

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

  const originalOnChangeContent = editor.paneActions.onChangeContent
  const handlePaneChangeContent = useCallback(
    (...args: Parameters<typeof originalOnChangeContent>): void => {
      invalidatePendingSearchJumps()
      originalOnChangeContent(...args)
    },
    [invalidatePendingSearchJumps, originalOnChangeContent]
  )

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...editor.paneActions,
      onChangeContent: handlePaneChangeContent,
      onOpenDiffTargetFile: git.actions.openWorkspaceFile
    }),
    [editor.paneActions, git.actions.openWorkspaceFile, handlePaneChangeContent]
  )

  const isCurrentWorkspaceFavorite =
    workspace !== null && isFavoriteWorkspacePath(config.favoriteWorkspaces, workspace.rootPath)
  const gitChangedCount = workspace?.rootPath ? getGitChangedCount(git.panelState.status) : 0

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

            {leftSidebar.activeView === 'search' && (
              <SearchSidebarPanel
                workspaceRootPath={workspace?.rootPath ?? null}
                query={workspaceSearch.query}
                options={workspaceSearch.options}
                hasFilterConditions={workspaceSearch.conditions.length > 0}
                schema={frontmatterSchema.schemaResult?.schema ?? null}
                filterBarSlot={
                  <FrontmatterFilterBar
                    workspaceRootPath={workspace?.rootPath ?? null}
                    schemaResult={frontmatterSchema.schemaResult}
                    fieldValuesByKey={frontmatterFieldValues.valuesByField}
                    conditions={workspaceSearch.conditions}
                    sort={workspaceSearch.sort}
                    onCreateDefaultSchema={frontmatterSchema.createDefaultSchema}
                    onOpenSchemaModal={() => {
                      setIsSettingsOpen(false)
                      setIsSchemaModalOpen(true)
                    }}
                    onRequestFieldValues={frontmatterFieldValues.refreshFieldValues}
                    onAddCondition={workspaceSearch.onAddCondition}
                    onUpdateCondition={workspaceSearch.onUpdateCondition}
                    onRemoveCondition={workspaceSearch.onRemoveCondition}
                    onClearConditions={workspaceSearch.onClearConditions}
                    onChangeSort={workspaceSearch.onChangeSort}
                  />
                }
                response={workspaceSearch.response}
                errorMessage={workspaceSearch.errorMessage}
                isSearching={workspaceSearch.isSearching}
                collapsedFileKeys={workspaceSearch.collapsedFileKeys}
                focusRequest={searchFocusRequest}
                onQueryChange={workspaceSearch.onQueryChange}
                onCompositionStart={workspaceSearch.onCompositionStart}
                onCompositionEnd={workspaceSearch.onCompositionEnd}
                onSubmitSearch={workspaceSearch.onSubmitSearch}
                onToggleOption={workspaceSearch.onToggleOption}
                onToggleFileCollapsed={workspaceSearch.onToggleFileCollapsed}
                onOpenFile={handleOpenSearchResultFile}
                onOpenLineMatch={openSearchLineMatch}
                onClickSummaryBadge={workspaceSearch.onUpsertBadgeCondition}
              />
            )}

            {leftSidebar.activeView === 'git' && (
              <GitSidebarPanel state={git.panelState} actions={git.actions} />
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
      isDismissDisabled={hasActiveModalDialog}
      onToggleTheme={toggleTheme}
      onToggleAutoSave={toggleAutoSave}
      onOpenConfigEditor={handleOpenConfigEditor}
      onClose={() => setIsSettingsOpen(false)}
    />
  ) : undefined

  return (
    <EditorWindowFrame
      shellRef={shellRef}
      errorMessage={errorMessage}
      pendingDialog={pendingDialog}
      onDismissDialog={dismissDialog}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      workspaceRootPath={workspace?.rootPath ?? null}
      frontmatterSchema={frontmatterSchema}
      frontmatterFieldValues={frontmatterFieldValues}
      openWorkspaceFile={openWorkspaceFile}
      reportErrorBanner={reportErrorBanner}
      imageTransferContextValue={imageTransferContextValue}
      paneWorkspaceProps={buildPaneWorkspaceProps(
        config,
        { ...editor, paneActions },
        isEditorShortcutDisabled,
        {
          diffsByKey: git.diffsByKey,
          workspaceMarkdownFiles: markdownFiles
        }
      )}
      leftSidebarSlot={leftSidebarSlot}
      settingsPanelSlot={settingsPanelSlot}
      isSchemaModalDismissDisabled={git.panelState.stashDialogScope !== null}
      isSchemaModalOpen={isSchemaModalOpen}
      onOpenSchemaModal={() => {
        setIsSettingsOpen(false)
        setIsSchemaModalOpen(true)
      }}
      onCloseSchemaModal={() => setIsSchemaModalOpen(false)}
      searchJumpRequest={searchJumpRequest}
    />
  )
}
