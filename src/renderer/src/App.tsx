import { useCallback, useMemo, useRef, useState } from 'react'
import { isFavoriteWorkspacePath, WorkspaceEntry } from '@shared/workspace'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FolderTreeSidebar } from './components/FolderTreeSidebar'
import { PaneInteractionActions } from './components/PaneTabBar'
import { PaneWorkspace } from './components/PaneWorkspace'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { useConfigController } from './hooks/useConfigController'
import { DirtyTabCloseRequest, useEditorWorkspace } from './hooks/useEditorWorkspace'
import { useWorkspaceTree } from './hooks/useWorkspaceTree'
import { getPaneActiveTab, SplitMode } from './stores/PaneTabStore'
import { toErrorMessage } from './utils/toErrorMessage'

const SPLIT_MODE_OPTIONS: ReadonlyArray<{
  mode: SplitMode
  ariaLabel: string
  label: string
}> = [
  { mode: 'single', ariaLabel: '단일 화면', label: '단일' },
  { mode: 'horizontal', ariaLabel: '좌우 분할', label: '좌우 분할' },
  { mode: 'vertical', ariaLabel: '상하 분할', label: '상하 분할' }
]

interface PendingDialogState {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
}

export function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)
  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const tabCloseActionsRef = useRef<{
    saveAndCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => Promise<boolean>
    forceCloseTab: (paneId: DirtyTabCloseRequest['paneId'], tabId: string) => void
  }>({
    saveAndCloseTab: async () => false,
    forceCloseTab: () => undefined
  })

  const {
    config,
    configPath,
    toggleTheme,
    toggleAutoSave,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    saveRawConfig
  } = useConfigController({
    onError: setErrorMessage,
    onExternalConfigCommitted: () => void refreshConfigDocRef.current()
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
    activateTab,
    focusPane,
    setSplitMode,
    setSplitRatio,
    moveTab,
    duplicateTabToOtherPane,
    updateTabViewState,
    clearWorkspaceBuffers,
    syncRenamedPath,
    syncDeletedPath
  } = useEditorWorkspace({
    autoSave: config.autoSave,
    autoSaveDelayMs: config.autoSaveDelayMs,
    isAutoSavePaused: pendingDialog !== null,
    onSaveConfigRaw: saveRawConfig,
    onError: setErrorMessage,
    onConfirmCloseDirtyTab: handleConfirmCloseDirtyTab
  })

  refreshConfigDocRef.current = refreshCleanConfig
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
    onError: setErrorMessage,
    onWorkspaceOpened: clearWorkspaceBuffers,
    onFileCreated: openCreatedFile,
    onEntryRenamed: syncRenamedPath,
    onEntryDeleted: syncDeletedPath
  })

  const guardUnsavedWorkspaceChanges = useCallback(
    (proceed: () => Promise<void>): void => {
      const dirtySummary = getDirtyWorkspaceSummary()
      if (!dirtySummary) {
        void proceed()
        return
      }

      setPendingDialog({
        title: '저장하지 않은 변경 사항',
        message: `"${dirtySummary}"에 저장하지 않은 변경 사항이 있습니다. 어떻게 할까요?`,
        confirmLabel: '저장 후 이동',
        secondaryLabel: '버리고 이동',
        onConfirm: async () => {
          setPendingDialog(null)
          const saved = await ensureAllWorkspaceBuffersSaved()
          if (saved) {
            await proceed()
          }
        },
        onSecondary: async () => {
          setPendingDialog(null)
          await proceed()
        }
      })
    },
    [ensureAllWorkspaceBuffersSaved, getDirtyWorkspaceSummary]
  )

  const handleSwitchWorkspace = useCallback(
    (targetPath: string): void => {
      guardUnsavedWorkspaceChanges(() => openWorkspace(targetPath))
    },
    [guardUnsavedWorkspaceChanges, openWorkspace]
  )

  const handleSelectFolder = useCallback((): void => {
    setErrorMessage(null)
    void window.wikiApi.workspace
      .selectFolder()
      .then((selectedPath) => {
        if (selectedPath) {
          handleSwitchWorkspace(selectedPath)
        }
      })
      .catch((error: unknown) => {
        setErrorMessage(toErrorMessage(error, '폴더 선택에 실패했습니다.'))
      })
  }, [handleSwitchWorkspace])

  const handleOpenFile = useCallback(
    (entry: WorkspaceEntry): void => {
      void openWorkspaceFile(entry)
    },
    [openWorkspaceFile]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    void openConfigDocument()
  }, [openConfigDocument])

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

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      onFocusPane: focusPane,
      onActivateTab: activateTab,
      onCloseTab: requestCloseTab,
      onMoveTab: moveTab,
      onDuplicateTab: duplicateTabToOtherPane,
      onChangeContent: updateBufferContent,
      onSaveBuffer: saveBufferByKey,
      onUpdateTabViewState: updateTabViewState
    }),
    [
      activateTab,
      duplicateTabToOtherPane,
      focusPane,
      moveTab,
      requestCloseTab,
      saveBufferByKey,
      updateBufferContent,
      updateTabViewState
    ]
  )

  const isCurrentWorkspaceFavorite =
    workspace !== null && isFavoriteWorkspacePath(config.favoriteWorkspaces, workspace.rootPath)

  return (
    <div className="app-shell" data-theme={config.theme}>
      <header className="app-header">
        <div className="app-header-left">
          <h1 className="app-title">Wiki Editor</h1>
          <WorkspaceSwitcher
            workspace={workspace}
            favoriteWorkspaces={config.favoriteWorkspaces}
            recentWorkspaces={config.recentWorkspaces}
            onSelectFolder={handleSelectFolder}
            onSwitchWorkspace={handleSwitchWorkspace}
            onRemoveFavorite={removeFavoriteWorkspace}
          />
        </div>

        <div className="app-header-actions">
          <div className="split-mode-group" role="group" aria-label="화면 분할">
            {SPLIT_MODE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`btn btn-sm${layout.splitMode === option.mode ? ' is-active' : ''}`}
                aria-label={option.ariaLabel}
                aria-pressed={layout.splitMode === option.mode}
                onClick={() => setSplitMode(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn"
            aria-label="테마 전환"
            aria-pressed={config.theme === 'dark'}
            onClick={toggleTheme}
          >
            {config.theme === 'light' ? '다크 모드' : '라이트 모드'}
          </button>
          <button
            type="button"
            className="btn"
            aria-expanded={isSettingsOpen}
            onClick={() => setIsSettingsOpen((open) => !open)}
          >
            설정
          </button>
        </div>
      </header>

      {errorMessage && (
        <div className="error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      <main className="app-main">
        <FolderTreeSidebar
          workspace={workspace}
          isFavorite={isCurrentWorkspaceFavorite}
          tree={treeState}
          activeFilePath={activeFilePath}
          onToggleFavorite={() => {
            if (workspace) {
              toggleFavoriteWorkspace(workspace.rootPath, workspace.name)
            }
          }}
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

        <PaneWorkspace
          layout={layout}
          buffers={buffers}
          autoSave={config.autoSave}
          isShortcutDisabled={pendingDialog !== null}
          onSetSplitRatio={setSplitRatio}
          actions={paneActions}
        />

        {isSettingsOpen && (
          <SettingsPanel
            theme={config.theme}
            autoSave={config.autoSave}
            configPath={configPath}
            onToggleTheme={toggleTheme}
            onToggleAutoSave={toggleAutoSave}
            onOpenConfigEditor={handleOpenConfigEditor}
            onClose={() => setIsSettingsOpen(false)}
          />
        )}
      </main>

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
          onCancel={() => setPendingDialog(null)}
        />
      )}
    </div>
  )
}
