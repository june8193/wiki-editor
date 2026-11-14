import { useCallback, useRef, useState } from 'react'
import { isFavoriteWorkspacePath, WorkspaceEntry } from '@shared/workspace'
import { ConfirmDialog } from './components/ConfirmDialog'
import { DocumentEditor } from './components/DocumentEditor'
import { FolderTreeSidebar } from './components/FolderTreeSidebar'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { useConfigController } from './hooks/useConfigController'
import { isDocumentDirty, useDocumentBuffer } from './hooks/useDocumentBuffer'
import { useWorkspaceTree } from './hooks/useWorkspaceTree'
import { toErrorMessage } from './utils/toErrorMessage'

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

  const {
    config,
    configPath,
    setConfigPath,
    toggleTheme,
    toggleAutoSave,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    saveRawConfig
  } = useConfigController({
    onError: setErrorMessage,
    onExternalConfigCommitted: () => void refreshConfigDocRef.current()
  })

  const {
    activeDoc,
    activeDocRef,
    isSavingDoc,
    saveSnapshot,
    saveActiveDocument,
    openWorkspaceFile,
    openConfigDocument,
    refreshCleanConfig,
    updateContent,
    openCreatedFileIfClean,
    clearWorkspaceDocument,
    syncRenamedPath,
    syncDeletedPath
  } = useDocumentBuffer({
    autoSave: config.autoSave,
    autoSaveDelayMs: config.autoSaveDelayMs,
    isAutoSavePaused: pendingDialog !== null,
    onSaveConfigRaw: saveRawConfig,
    onError: setErrorMessage
  })

  refreshConfigDocRef.current = refreshCleanConfig

  const {
    workspace,
    rootEntries,
    childrenByDir,
    expandedDirs,
    loadingDirs,
    selectedTreePath,
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
    onWorkspaceOpened: clearWorkspaceDocument,
    onFileCreated: openCreatedFileIfClean,
    onEntryRenamed: syncRenamedPath,
    onEntryDeleted: syncDeletedPath
  })

  const guardUnsavedChanges = useCallback(
    (proceed: () => Promise<void>): void => {
      const current = activeDocRef.current
      if (!isDocumentDirty(current) || !current) {
        void proceed()
        return
      }

      setPendingDialog({
        title: '저장하지 않은 변경 사항',
        message: `"${current.name}"에 저장하지 않은 변경 사항이 있습니다. 어떻게 할까요?`,
        confirmLabel: '저장 후 이동',
        secondaryLabel: '버리고 이동',
        onConfirm: async () => {
          setPendingDialog(null)
          const saved = await saveSnapshot({ ...current })
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
    [activeDocRef, saveSnapshot]
  )

  const handleSwitchWorkspace = useCallback(
    (targetPath: string): void => {
      guardUnsavedChanges(() => openWorkspace(targetPath))
    },
    [guardUnsavedChanges, openWorkspace]
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
      if (activeDocRef.current?.kind === 'workspace' && activeDocRef.current.path === entry.path) {
        return
      }
      guardUnsavedChanges(() => openWorkspaceFile(entry))
    },
    [activeDocRef, guardUnsavedChanges, openWorkspaceFile]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    guardUnsavedChanges(async () => {
      const resolvedPath = await openConfigDocument()
      if (resolvedPath) {
        setConfigPath(resolvedPath)
      }
    })
  }, [guardUnsavedChanges, openConfigDocument, setConfigPath])

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
          rootEntries={rootEntries}
          childrenByDir={childrenByDir}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          selectedPath={selectedTreePath}
          activeFilePath={activeDoc?.kind === 'workspace' ? activeDoc.path : null}
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

        <DocumentEditor
          document={activeDoc}
          isSaving={isSavingDoc}
          autoSave={config.autoSave}
          onChangeContent={updateContent}
          onSave={saveActiveDocument}
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
