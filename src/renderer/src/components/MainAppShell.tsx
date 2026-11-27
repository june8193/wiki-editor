import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppMenuCommand, MainMenuAction, WikiApi } from '@shared/ipc'
import { getGitChangedCount, type GitDiffRequest } from '@shared/git'
import type { WorkspaceSearchFileResult } from '@shared/search'
import {
  filterTopLevelWorkspaceEntries,
  formatAbsoluteEntryPath,
  formatRelativeEntryPath,
  isFavoriteWorkspacePath,
  type WorkspaceEntry
} from '@shared/workspace'
import { useConfigController } from '../hooks/useConfigController'
import { useCompareSession } from '../hooks/useCompareSession'
import { useSnapshotTabState } from '../hooks/useSnapshotTabState'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useWorkspaceImageTransfer } from '../hooks/useEditorImageTransfer'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useFrontmatterFieldValues } from '../hooks/useFrontmatterFieldValues'
import { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
import { type GitSessionRuntimeCollaborators, useGitSession } from '../hooks/useGitSession'
import {
  type MainWorkspaceLifecycleCollaborators,
  useMainWorkspaceLifecycle
} from '../hooks/useMainWorkspaceLifecycle'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { useWindowHeight } from '../hooks/useWindowHeight'
import { useWindowTitle } from '../hooks/useWindowTitle'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useTerminalSession } from '../hooks/useTerminalSession'
import { useWorkspaceSearch } from '../hooks/useWorkspaceSearch'
import { useWorkspaceTree } from '../hooks/useWorkspaceTree'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH
} from '../utils/sidebarWidth'
import {
  isNewTerminalShortcut,
  isTerminalToggleShortcut
} from '../utils/terminalShortcuts'
import {
  isEventOutsideShell,
  isKeyboardEventComposing,
  isWorkspaceSearchShortcut,
  type SearchFocusRequest
} from '../utils/workspaceSearch'
import { ActivityBar, type LeftSidebarView } from './ActivityBar'
import { getOrderedVisibleCompareFiles } from '../stores/CompareSession'
import { buildPaneWorkspaceProps, EditorWindowFrame } from './EditorWindowFrame'
import { CompareSidebarPanel } from './CompareSidebarPanel'
import { formatGitRepoCopyPath, type GitCopyPathMode } from '../utils/gitFilePresentation'
import type { GitDiffNavigationProps } from './GitDiffViewer'
import { type EntryPathCopyMode, FolderTreeSidebar } from './FolderTreeSidebar'
import { FrontmatterFilterBar } from './FrontmatterFilterBar'
import { GitSidebarPanel } from './GitSidebarPanel'
import { ManualModal } from './ManualModal'
import manualMarkdown from '../../../../docs/manual.md?raw'
import type { PaneInteractionActions } from './PaneTabBar'
import { SearchSidebarPanel } from './SearchSidebarPanel'
import { SettingsPanel } from './SettingsPanel'
import { SidebarResizer } from './SidebarResizer'
import { TerminalPanel } from './TerminalPanel'
import { TitleBar, type TitleBarMenuGroup } from './TitleBar'
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
  const [isManualOpen, setIsManualOpen] = useState<boolean>(false)
  const [isSymbolPaletteOpen, setIsSymbolPaletteOpen] = useState<boolean>(false)
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
  const workspaceCollaboratorsRef = useRef<MainWorkspaceLifecycleCollaborators | null>(null)
  const workspaceLifecycle = useMainWorkspaceLifecycle({
    collaboratorsRef: workspaceCollaboratorsRef
  })

  const {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleShowHeadingNumbers,
    setDefaultTerminalProfile,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    removeRecentWorkspace
  } = useConfigController({
    onError: reportErrorBanner,
    onExternalConfigCommitted: () => void refreshConfigDocRef.current(),
    onInitialConfigLoaded: workspaceLifecycle.handleInitialConfigLoaded
  })

  const isEditorShortcutDisabled =
    hasActiveModalDialog ||
    isSettingsOpen ||
    isSchemaModalOpen ||
    isManualOpen ||
    isSymbolPaletteOpen
  const isEditorShortcutDisabledRef = useRef<boolean>(isEditorShortcutDisabled)
  isEditorShortcutDisabledRef.current = isEditorShortcutDisabled
  const editor = useEditorWorkspace({
    isAutoSavePaused: hasActiveModalDialog || git.isMutating,
    isShortcutDisabled: isEditorShortcutDisabled,
    loadInitContext: workspaceLifecycle.loadInitContext,
    onWorkspaceSaved: () => void git.actions.refreshStatus(),
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: confirmCloseDirtyTab,
    onConfirmAction: requestConfirm
  })

  refreshConfigDocRef.current = editor.refreshCleanConfig

  const windowWidth = useWindowWidth()
  const windowHeight = useWindowHeight()
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

  const handleSelectLeftSidebarView = useCallback(
    (view: LeftSidebarView): void => {
      workspaceLifecycle.markUserSelectedSidebarView()
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
    [closeStashDialog, focusSearchInput, workspaceLifecycle]
  )

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditorShortcutDisabledRef.current) {
        return
      }
      if (isEventOutsideShell(event.target, shellRef.current)) {
        return
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        !isKeyboardEventComposing(event) &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault()
        workspaceLifecycle.selectFolder()
        return
      }
      if (isTerminalToggleShortcut(event)) {
        event.preventDefault()
        terminalActionsRef.current.toggleTerminal()
        return
      }
      if (isNewTerminalShortcut(event)) {
        event.preventDefault()
        void terminalActionsRef.current.createNewTerminal()
        return
      }
      if (!isWorkspaceSearchShortcut(event)) {
        return
      }
      event.preventDefault()
      workspaceLifecycle.markUserSelectedSidebarView()
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
  }, [focusSearchInput, workspaceLifecycle])

  const windowTitle = useWindowTitle(workspaceLifecycle.loadInitContext)

  const handleResizeLeftSidebar = useCallback((nextWidth: number): void => {
    setLeftSidebar((prev) => (prev.width === nextWidth ? prev : { ...prev, width: nextWidth }))
  }, [])

  const menuHandlersRef = useRef<Record<AppMenuCommand, () => void>>({
    'open-folder': () => undefined,
    'toggle-theme': () => undefined,
    'toggle-settings': () => undefined,
    'open-manual': () => undefined,
    'toggle-terminal': () => undefined,
    'new-terminal': () => undefined
  })

  const {
    workspace,
    treeState,
    markdownFiles,
    getExpandedDirs,
    applyOpenedWorkspace,
    setSelectedTreePath,
    toggleSelectTreePath,
    selectTreePathRange,
    resolveCreateParentDir,
    refreshTree,
    toggleDirectory,
    ensureExpanded,
    createEntry,
    renameEntry,
    moveEntries,
    deleteEntries
  } = useWorkspaceTree({
    onError: reportErrorBanner,
    onWorkspaceChanged: (event) => {
      void editor.reconcileWorkspaceBuffersWithDisk(event).then((warnings) => {
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

  const activeWorkspaceRoot = workspace?.rootPath ?? null
  const terminal = useTerminalSession({
    wikiApi,
    workspaceRootPath: activeWorkspaceRoot,
    windowHeight,
    defaultTerminalProfile: config.defaultTerminalProfile
  })
  const terminalActionsRef = useRef(terminal.actions)
  terminalActionsRef.current = terminal.actions
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

  const activeGitIsRepo =
    git.panelState.workspaceRootPath === activeWorkspaceRoot
      ? (git.panelState.status?.isRepo ?? null)
      : null

  const compare = useCompareSession({
    workspaceRootPath: activeWorkspaceRoot,
    isRepo: activeGitIsRepo,
    diffTabs: {
      openDiffTab: git.actions.openFileDiff,
      reconcileBranchCompareDiffTabs: editor.reconcileBranchCompareDiffTabs
    }
  })

  workspaceCollaboratorsRef.current = {
    tree: {
      getExpandedDirs,
      applyOpenedWorkspace
    },
    editor: {
      getDirtyWorkspaceSummary: editor.getDirtyWorkspaceSummary,
      ensureAllWorkspaceBuffersSaved: editor.ensureAllWorkspaceBuffersSaved,
      clearWorkspaceBuffers: editor.clearWorkspaceBuffers,
      restoreWorkspaceLayout: editor.restoreWorkspaceLayout,
      getLatestLayoutSnapshot: editor.getLayoutSnapshot
    },
    confirm: {
      confirmUnsavedChanges: requestUnsavedChanges,
      isDialogOpen: isAnyDialogOpen
    },
    ui: {
      reportError: reportErrorBanner,
      removeRecentWorkspace,
      onEnterExplorerView: (reason) => {
        setLeftSidebar((prev) =>
          reason === 'startup'
            ? { ...prev, activeView: 'explorer', isCollapsed: false }
            : transitionWorkspaceSidebarToExplorer(prev)
        )
      }
    }
  }

  useEffect(() => {
    workspaceLifecycle.syncPersistenceState()
  }, [activeWorkspaceRoot, editor.layoutSnapshot, treeState.expandedDirs, workspaceLifecycle])

  useEffect(() => {
    return () => {
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
    onBeforeApproveClose: workspaceLifecycle.flushWorkspaceState
  })

  const { openWorkspaceFile, openConfigDocument } = editor
  const { resetForWorkspaceSwitch } = editor.navigation

  gitCollaboratorsRef.current = {
    editor,
    refreshTree
  }

  useEffect(() => {
    setGitWorkspaceRootPath(activeWorkspaceRoot)
    resetForWorkspaceSwitch()
  }, [activeWorkspaceRoot, resetForWorkspaceSwitch, setGitWorkspaceRootPath])

  const handleOpenFile = useCallback(
    (entry: WorkspaceEntry): void => {
      void openWorkspaceFile(entry)
    },
    [openWorkspaceFile]
  )
  const handleOpenSearchResultFile = useCallback(
    (file: WorkspaceSearchFileResult): void => {
      void openWorkspaceFile(file.path, undefined, file.name)
    },
    [openWorkspaceFile]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    setIsSettingsOpen(false)
    void openConfigDocument()
  }, [openConfigDocument])

  menuHandlersRef.current = {
    'open-folder': workspaceLifecycle.selectFolder,
    'toggle-theme': toggleTheme,
    'toggle-settings': () => {
      setIsSchemaModalOpen(false)
      setIsManualOpen(false)
      setIsSettingsOpen((open) => !open)
    },
    'open-manual': () => {
      setIsSettingsOpen(false)
      setIsSchemaModalOpen(false)
      setIsManualOpen(true)
    },
    'toggle-terminal': terminal.actions.toggleTerminal,
    'new-terminal': () => {
      void terminal.actions.createNewTerminal()
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

  const handleCopyGitRepoPath = useCallback(
    (repoRelativePath: string, mode: GitCopyPathMode): void => {
      reportErrorBanner(null)
      const textToCopy = formatGitRepoCopyPath(
        repoRelativePath,
        mode,
        git.panelState.status?.repoRoot ?? null,
        workspace?.rootPath ?? null
      )
      void writeTextToClipboard(wikiApi, textToCopy).catch((error: unknown) => {
        reportErrorBanner(toErrorMessage(error, '경로를 클립보드에 복사하지 못했습니다.'), error)
      })
    },
    [git.panelState.status?.repoRoot, reportErrorBanner, wikiApi, workspace?.rootPath]
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

  const { snapshotsByKey, openSnapshotTargetFile } = useSnapshotTabState({
    layout: editor.layout,
    workspaceRootPath: activeWorkspaceRoot,
    repoRoot: git.panelState.status?.repoRoot ?? null,
    gitApi: wikiApi.git,
    openWorkspaceFile: editor.openWorkspaceFile
  })

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...editor.paneActions,
      onOpenDiffTargetFile: git.actions.openWorkspaceFile,
      onOpenSnapshotTargetFile: openSnapshotTargetFile
    }),
    [editor.paneActions, git.actions.openWorkspaceFile, openSnapshotTargetFile]
  )

  const orderedCompareFiles = useMemo(
    () =>
      compare.state.summary
        ? getOrderedVisibleCompareFiles(compare.state.summary.files, compare.state.fileFilter)
        : [],
    [compare.state.summary, compare.state.fileFilter]
  )
  const orderedCompareFilesRef = useRef(orderedCompareFiles)
  orderedCompareFilesRef.current = orderedCompareFiles
  const openCompareFileDiffRef = useRef(compare.actions.openCompareFileDiff)
  openCompareFileDiffRef.current = compare.actions.openCompareFileDiff
  const diffNavigationCacheRef = useRef<Map<string, GitDiffNavigationProps>>(new Map())

  const getDiffNavigation = useCallback(
    (request: GitDiffRequest): GitDiffNavigationProps | undefined => {
      if (
        request.kind !== 'branch-compare' ||
        !compare.state.summary ||
        compare.state.baseRef !== request.baseRef ||
        compare.state.compareRef !== request.compareRef ||
        compare.state.mode !== request.mode
      ) {
        return undefined
      }
      const index = orderedCompareFiles.findIndex(
        (file) => file.path === request.path && file.origPath === request.origPath
      )
      if (index < 0) {
        return undefined
      }
      const currentIndex = index + 1
      const totalCount = orderedCompareFiles.length
      const cacheKey = `${currentIndex}:${totalCount}`
      const cached = diffNavigationCacheRef.current.get(cacheKey)
      if (cached) {
        return cached
      }
      const nav: GitDiffNavigationProps = {
        currentIndex,
        totalCount,
        onPrevFile: () => {
          const prev = orderedCompareFilesRef.current[index - 1]
          if (prev) {
            openCompareFileDiffRef.current(prev)
          }
        },
        onNextFile: () => {
          const next = orderedCompareFilesRef.current[index + 1]
          if (next) {
            openCompareFileDiffRef.current(next)
          }
        }
      }
      diffNavigationCacheRef.current.set(cacheKey, nav)
      return nav
    },
    [
      orderedCompareFiles,
      compare.state.summary,
      compare.state.baseRef,
      compare.state.compareRef,
      compare.state.mode
    ]
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
                onOpenFolder={workspaceLifecycle.selectFolder}
                onSwitchWorkspace={workspaceLifecycle.switchWorkspace}
                onOpenInNewWindow={workspaceLifecycle.openInNewWindow}
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
                onOpenLineMatch={(file, line) =>
                  void editor.navigation.openSearchLineMatch(
                    file,
                    line,
                    workspaceSearch.response?.query ?? workspaceSearch.query,
                    workspaceSearch.resultOptions
                  )
                }
                onClickSummaryBadge={workspaceSearch.onUpsertBadgeCondition}
              />
            )}

            {leftSidebar.activeView === 'git' && (
              <GitSidebarPanel
                state={git.panelState}
                actions={git.actions}
                onCopyPath={handleCopyGitRepoPath}
              />
            )}

            {leftSidebar.activeView === 'compare' && (
              <CompareSidebarPanel
                state={compare.state}
                isRepo={activeGitIsRepo}
                actions={compare.actions}
                repoRoot={git.panelState.status?.repoRoot ?? null}
                onCopyPath={handleCopyGitRepoPath}
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
      defaultTerminalProfile={config.defaultTerminalProfile}
      terminalProfiles={terminal.profiles}
      configPath={configPath}
      isDismissDisabled={hasActiveModalDialog}
      onToggleTheme={toggleTheme}
      onToggleAutoSave={toggleAutoSave}
      onChangeDefaultTerminalProfile={setDefaultTerminalProfile}
      onOpenConfigEditor={handleOpenConfigEditor}
      onClose={() => setIsSettingsOpen(false)}
    />
  ) : undefined

  const manualModalSlot = isManualOpen ? (
    <ManualModal
      content={manualMarkdown}
      theme={config.theme}
      isDismissDisabled={hasActiveModalDialog}
      onClose={() => setIsManualOpen(false)}
    />
  ) : undefined

  const runMenuCommand = useCallback((command: AppMenuCommand): void => {
    if (!isEditorShortcutDisabledRef.current) {
      menuHandlersRef.current[command]()
    }
  }, [])

  const runMenuAction = useCallback(
    (action: MainMenuAction): void => {
      void wikiApi.menu.runAction?.(action)?.catch((error: unknown) => {
        reportErrorBanner(toErrorMessage(error, '메뉴 작업을 실행하지 못했습니다.'), error)
      })
    },
    [reportErrorBanner, wikiApi.menu]
  )

  const titleBarMenus = useMemo<TitleBarMenuGroup[]>(
    () => [
      {
        id: 'file',
        label: 'File',
        items: [
          {
            kind: 'item',
            id: 'open-folder',
            label: '폴더 열기...',
            shortcut: 'Ctrl+O',
            onSelect: () => runMenuCommand('open-folder')
          },
          { kind: 'separator', id: 'file-sep' },
          {
            kind: 'item',
            id: 'quit',
            label: 'Quit',
            onSelect: () => runMenuAction('quit')
          }
        ]
      },
      {
        id: 'settings',
        label: 'Settings',
        items: [
          {
            kind: 'item',
            id: 'toggle-settings',
            label: '설정 패널',
            onSelect: () => runMenuCommand('toggle-settings')
          },
          {
            kind: 'item',
            id: 'toggle-theme',
            label: '테마 전환',
            onSelect: () => runMenuCommand('toggle-theme')
          }
        ]
      },
      {
        id: 'terminal',
        label: 'Terminal',
        items: [
          {
            kind: 'item',
            id: 'toggle-terminal',
            label: '터미널 토글',
            shortcut: 'Ctrl+`',
            onSelect: () => runMenuCommand('toggle-terminal')
          },
          {
            kind: 'item',
            id: 'new-terminal',
            label: '새 터미널',
            shortcut: 'Ctrl+Shift+`',
            onSelect: () => runMenuCommand('new-terminal')
          }
        ]
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          {
            kind: 'item',
            id: 'open-manual',
            label: '사용자 매뉴얼',
            onSelect: () => runMenuCommand('open-manual')
          },
          { kind: 'separator', id: 'help-sep' },
          {
            kind: 'item',
            id: 'copy-bug-report',
            label: 'Copy Bug Report',
            onSelect: () => runMenuAction('copy-bug-report')
          },
          {
            kind: 'item',
            id: 'open-log-folder',
            label: 'Open Log Folder',
            onSelect: () => runMenuAction('open-log-folder')
          },
          {
            kind: 'item',
            id: 'show-version',
            label: 'Version',
            onSelect: () => runMenuAction('show-version')
          }
        ]
      }
    ],
    [runMenuAction, runMenuCommand]
  )

  const terminalPanelSlot = (
    <TerminalPanel
      isOpen={terminal.isOpen}
      height={terminal.height}
      heightBounds={terminal.heightBounds}
      theme={config.theme}
      tabs={terminal.tabs}
      activeTabId={terminal.activeTabId}
      profiles={terminal.profiles}
      workspaceRootPath={activeWorkspaceRoot}
      errorMessage={terminal.errorMessage}
      onSelectTab={terminal.actions.selectTab}
      onCloseTab={terminal.actions.closeTab}
      onNewTerminal={(profileId) => void terminal.actions.createNewTerminal(profileId)}
      onCollapse={terminal.actions.collapsePanel}
      onResizeHeight={terminal.actions.resizePanel}
      onWriteSession={terminal.actions.writeSession}
      onResizeSession={terminal.actions.resizeSession}
      subscribeSessionData={terminal.actions.subscribeSessionData}
      onOpenExternalUrl={(url) => {
        void wikiApi.terminal?.openExternalUrl(url).catch(() => undefined)
      }}
      onOpenWorkspaceFile={(filePath, lineNumber, column) => {
        void editor.navigation.openFileAtLine(filePath, lineNumber, column)
      }}
    />
  )

  return (
    <EditorWindowFrame
      shellRef={shellRef}
      titleBarSlot={
        <TitleBar
          title={windowTitle}
          menus={titleBarMenus}
          isMenuDisabled={isEditorShortcutDisabled}
        />
      }
      errorMessage={errorMessage}
      pendingDialog={pendingDialog}
      onDismissDialog={dismissDialog}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      workspaceRootPath={workspace?.rootPath ?? null}
      onSymbolPaletteOpenChange={setIsSymbolPaletteOpen}
      getActiveDiffChangedFiles={(request) => {
        if (request.kind === 'branch-compare' && compare.state.summary) {
          return new Set(compare.state.summary.files.map((f) => f.path))
        }
        const commitDetail = git.panelState.graphState.commitDetail
        if (
          request.kind === 'commit' &&
          commitDetail.status === 'loaded' &&
          commitDetail.detail.hash === request.commitHash
        ) {
          return new Set(commitDetail.detail.files.map((f) => f.path))
        }
        const stashDetail = git.panelState.stashDetail
        if (
          request.kind === 'stash' &&
          stashDetail.status === 'loaded' &&
          stashDetail.detail.hash === request.stashHash
        ) {
          return new Set(stashDetail.detail.files.map((f) => f.path))
        }
        if (request.kind === 'unstaged' && git.panelState.status) {
          return new Set(git.panelState.status.unstaged.map((f) => f.path))
        }
        if (request.kind === 'staged' && git.panelState.status) {
          return new Set(git.panelState.status.staged.map((f) => f.path))
        }
        return undefined
      }}
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
          snapshotsByKey,
          getDiffNavigation,
          workspaceMarkdownFiles: markdownFiles
        }
      )}
      leftSidebarSlot={leftSidebarSlot}
      terminalPanelSlot={terminalPanelSlot}
      settingsPanelSlot={settingsPanelSlot}
      manualModalSlot={manualModalSlot}
      isSchemaModalDismissDisabled={git.panelState.stashDialogScope !== null}
      isSchemaModalOpen={isSchemaModalOpen}
      onOpenSchemaModal={() => {
        setIsSettingsOpen(false)
        setIsManualOpen(false)
        setIsSchemaModalOpen(true)
      }}
      onCloseSchemaModal={() => setIsSchemaModalOpen(false)}
      navigation={editor.navigation}
    />
  )
}
