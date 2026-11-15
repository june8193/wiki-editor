import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppMenuCommand } from '@shared/ipc'
import type { GitStatus } from '@shared/git'
import { isFavoriteWorkspacePath, WorkspaceEntry } from '@shared/workspace'
import { deriveDocumentTitle } from '../editor/SlashCommandEngine'
import { useGitController } from '../hooks/useGitController'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowEditorShell } from '../hooks/useWindowEditorShell'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useWorkspaceTree } from '../hooks/useWorkspaceTree'
import {
  clampSidebarWidth,
  getLeftSidebarWidthBounds,
  LEFT_SIDEBAR_DEFAULT_WIDTH
} from '../utils/sidebarWidth'
import { ActivityBar, type LeftSidebarView } from './ActivityBar'
import { EditorWindowFrame } from './EditorWindowFrame'
import { FolderTreeSidebar } from './FolderTreeSidebar'
import { GitSidebarPanel } from './GitSidebarPanel'
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

function getGitChangedCount(workspaceRootPath: string | null, status: GitStatus | null): number {
  if (!workspaceRootPath || !status || !status.isRepo) {
    return 0
  }
  return status.staged.length + status.unstaged.length + status.untracked.length
}

/**
 * Primary workspace window shell owning folder watching, left sidebar views, Git integration,
 * application menu shortcuts, and global settings alongside the shared editor workspace.
 */
export function MainAppShell() {
  const wikiApi = useWikiApi()
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [leftSidebar, setLeftSidebar] = useState<LeftSidebarState>({
    activeView: 'workspace',
    isCollapsed: false,
    width: LEFT_SIDEBAR_DEFAULT_WIDTH
  })

  const shell = useWindowEditorShell({
    initialRightCollapsed: false,
    isExtraShortcutDisabled: isSettingsOpen
  })

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

  const isSelectingFolderRef = useRef<boolean>(false)
  const hasWorkspaceInteractionRef = useRef<boolean>(false)
  const isStartupRestoreRef = useRef<boolean>(false)
  const pendingGitConfirmCancelRef = useRef<(() => void) | null>(null)
  const reconcileBuffersRef = useRef<() => Promise<readonly string[]>>(
    shell.reconcileWorkspaceBuffersWithDisk
  )
  reconcileBuffersRef.current = shell.reconcileWorkspaceBuffersWithDisk

  const menuHandlersRef = useRef<Record<AppMenuCommand, () => void>>({
    'open-folder': () => undefined,
    'toggle-theme': () => undefined,
    'toggle-settings': () => undefined
  })

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
    onError: shell.reportErrorBanner,
    onWorkspaceOpened: () => {
      shell.clearWorkspaceBuffers()
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
          shell.reportErrorBanner(warnings.join(' '))
        }
      })
      void shell.onWorkspaceSavedRef.current()
    },
    onFileCreated: shell.openCreatedFile,
    onEntryRenamed: shell.syncRenamedPath,
    onEntryDeleted: shell.syncDeletedPath
  })

  shell.onInitialConfigLoadedRef.current = (loadedConfig) => {
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
      onSilentError: () => shell.removeRecentWorkspace(lastWorkspacePath)
    }).finally(() => {
      isStartupRestoreRef.current = false
    })
  }

  useEffect(() => {
    return () => {
      pendingGitConfirmCancelRef.current?.()
    }
  }, [])

  const { ensureAllWorkspaceBuffersSaved, getDirtyWorkspaceSummary, setPendingDialog } = shell
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
    [ensureAllWorkspaceBuffersSaved, getDirtyWorkspaceSummary, setPendingDialog]
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
  shell.onWorkspaceSavedRef.current = git.refreshStatus

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

  const { reportErrorBanner, isDialogOpenRef, openWorkspaceFile, openConfigDocument } = shell
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
    'toggle-theme': shell.toggleTheme,
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

  const isCurrentWorkspaceFavorite =
    workspace !== null && isFavoriteWorkspacePath(shell.config.favoriteWorkspaces, workspace.rootPath)
  const gitChangedCount = getGitChangedCount(workspace?.rootPath ?? null, git.status)

  const leftChrome = (
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
                favoriteWorkspaces={shell.config.favoriteWorkspaces}
                recentWorkspaces={shell.config.recentWorkspaces}
                onOpenFolder={handleSelectFolder}
                onSwitchWorkspace={handleSwitchWorkspace}
                onToggleFavorite={() => {
                  if (workspace) {
                    shell.toggleFavoriteWorkspace(workspace.rootPath, workspace.name)
                  }
                }}
                onRemoveFavorite={shell.removeFavoriteWorkspace}
              />
            )}
            {leftSidebar.activeView === 'explorer' && (
              <FolderTreeSidebar
                workspace={workspace}
                tree={treeState}
                activeFilePath={shell.activeFilePath}
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
  )

  const overlay = isSettingsOpen ? (
    <SettingsPanel
      theme={shell.config.theme}
      autoSave={shell.config.autoSave}
      showHeadingNumbers={shell.config.showHeadingNumbers}
      configPath={shell.configPath}
      customCommands={shell.config.customCommands}
      previewTitle={shell.activeBuffer ? deriveDocumentTitle(shell.activeBuffer.name) : undefined}
      isDismissDisabled={shell.pendingDialog !== null}
      onToggleTheme={shell.toggleTheme}
      onToggleAutoSave={shell.toggleAutoSave}
      onToggleShowHeadingNumbers={shell.toggleShowHeadingNumbers}
      onSaveCustomCommands={shell.updateCustomCommands}
      onOpenConfigEditor={handleOpenConfigEditor}
      onClose={() => setIsSettingsOpen(false)}
    />
  ) : undefined

  return (
    <EditorWindowFrame
      shell={shell}
      canDetachToNewWindow
      leftChrome={leftChrome}
      overlay={overlay}
    />
  )
}
