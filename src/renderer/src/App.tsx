import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getWorkspaceDisplayName,
  isFavoriteWorkspacePath,
  isNestedOrSamePath,
  remapPathPrefix,
  WorkspaceEntry
} from '@shared/workspace'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ActiveDocument, DocumentEditor } from './components/DocumentEditor'
import { FolderTreeSidebar } from './components/FolderTreeSidebar'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { useConfigController } from './hooks/useConfigController'
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
  const [activeDoc, setActiveDoc] = useState<ActiveDocument | null>(null)
  const [isSavingDoc, setIsSavingDoc] = useState<boolean>(false)
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)

  const mountedRef = useRef<boolean>(true)
  const activeDocRef = useRef<ActiveDocument | null>(null)
  activeDocRef.current = activeDoc

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshCleanConfigEditor = useCallback(async (): Promise<void> => {
    const doc = activeDocRef.current
    if (!doc || doc.kind !== 'config' || doc.content !== doc.savedContent) {
      return
    }
    try {
      const raw = await window.wikiApi.config.readRaw()
      if (!mountedRef.current) return
      setActiveDoc((current) => {
        if (!current || current.kind !== 'config' || current.content !== current.savedContent) {
          return current
        }
        return { ...current, content: raw, savedContent: raw }
      })
    } catch {
      // Preserve primary error banners during background config refresh
    }
  }, [])

  const {
    config,
    configPath,
    setConfigPath,
    toggleTheme,
    toggleAutoSave,
    updateAutoSaveDelay,
    toggleFavoriteWorkspace,
    removeFavoriteWorkspace,
    saveRawConfig
  } = useConfigController({
    onError: setErrorMessage,
    onExternalConfigCommitted: () => void refreshCleanConfigEditor()
  })

  const {
    workspace,
    rootEntries,
    childrenByDir,
    expandedDirs,
    loadingDirs,
    selectedTreePath,
    setSelectedTreePath,
    openWorkspace,
    refreshTree,
    toggleDirectory,
    ensureExpanded,
    createEntry,
    renameEntry,
    deleteEntry
  } = useWorkspaceTree({
    onError: setErrorMessage,
    onWorkspaceOpened: () => {
      setActiveDoc((current) => (current?.kind === 'config' ? current : null))
    },
    onFileCreated: (created) => {
      const currentDoc = activeDocRef.current
      if (!currentDoc || currentDoc.content === currentDoc.savedContent) {
        setActiveDoc({
          kind: 'workspace',
          path: created.path,
          name: created.name,
          content: '',
          savedContent: ''
        })
      }
    },
    onEntryRenamed: (oldPath, renamed) => {
      setActiveDoc((current) => {
        if (!current || current.kind !== 'workspace') return current
        if (!isNestedOrSamePath(current.path, oldPath)) return current
        const nextPath = remapPathPrefix(current.path, oldPath, renamed.path)
        return {
          ...current,
          path: nextPath,
          name: getWorkspaceDisplayName(nextPath)
        }
      })
    },
    onEntryDeleted: (deletedPath) => {
      setActiveDoc((current) => {
        if (!current || current.kind !== 'workspace') return current
        return isNestedOrSamePath(current.path, deletedPath) ? null : current
      })
    }
  })

  const saveDocumentSnapshot = useCallback(
    async (snapshot: ActiveDocument): Promise<boolean> => {
      setIsSavingDoc(true)
      setErrorMessage(null)

      try {
        if (snapshot.kind === 'config') {
          await saveRawConfig(snapshot.content)
        } else {
          await window.wikiApi.workspace.writeFile(snapshot.path, snapshot.content)
        }

        if (!mountedRef.current) return false
        setActiveDoc((current) => {
          if (!current || current.kind !== snapshot.kind || current.path !== snapshot.path) {
            return current
          }
          return { ...current, savedContent: snapshot.content }
        })
        return true
      } catch (error: unknown) {
        if (mountedRef.current) {
          setErrorMessage(toErrorMessage(error, '문서 저장에 실패했습니다.'))
        }
        return false
      } finally {
        if (mountedRef.current) {
          setIsSavingDoc(false)
        }
      }
    },
    [saveRawConfig]
  )

  const handleManualSave = useCallback((): void => {
    const current = activeDocRef.current
    if (!current || current.content === current.savedContent) return
    void saveDocumentSnapshot({ ...current })
  }, [saveDocumentSnapshot])

  useEffect(() => {
    if (!config.autoSave || !activeDoc) return
    if (activeDoc.content === activeDoc.savedContent) return

    const snapshot: ActiveDocument = { ...activeDoc }
    const timer = window.setTimeout(() => {
      void saveDocumentSnapshot(snapshot)
    }, config.autoSaveDelayMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    config.autoSave,
    config.autoSaveDelayMs,
    activeDoc?.kind,
    activeDoc?.path,
    activeDoc?.content,
    activeDoc?.savedContent,
    saveDocumentSnapshot
  ])

  const guardUnsavedChanges = useCallback(
    (proceed: () => Promise<void>): void => {
      const current = activeDocRef.current
      if (!current || current.content === current.savedContent) {
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
          const saved = await saveDocumentSnapshot({ ...current })
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
    [saveDocumentSnapshot]
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
        if (selectedPath && mountedRef.current) {
          handleSwitchWorkspace(selectedPath)
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current) {
          setErrorMessage(toErrorMessage(error, '폴더 선택에 실패했습니다.'))
        }
      })
  }, [handleSwitchWorkspace])

  const handleOpenFile = useCallback(
    (entry: WorkspaceEntry): void => {
      if (activeDocRef.current?.kind === 'workspace' && activeDocRef.current.path === entry.path) {
        return
      }
      guardUnsavedChanges(async () => {
        setErrorMessage(null)
        try {
          const content = await window.wikiApi.workspace.readFile(entry.path)
          if (!mountedRef.current) return
          setActiveDoc({
            kind: 'workspace',
            path: entry.path,
            name: entry.name,
            content,
            savedContent: content
          })
        } catch (error: unknown) {
          if (mountedRef.current) {
            setErrorMessage(toErrorMessage(error, '파일을 열지 못했습니다.'))
          }
        }
      })
    },
    [guardUnsavedChanges]
  )

  const handleOpenConfigEditor = useCallback((): void => {
    guardUnsavedChanges(async () => {
      setErrorMessage(null)
      try {
        const [resolvedPath, raw] = await Promise.all([
          window.wikiApi.config.getConfigPath(),
          window.wikiApi.config.readRaw()
        ])
        if (!mountedRef.current) return
        setConfigPath(resolvedPath)
        setActiveDoc({
          kind: 'config',
          path: resolvedPath,
          name: 'config.json',
          content: raw,
          savedContent: raw
        })
      } catch (error: unknown) {
        if (mountedRef.current) {
          setErrorMessage(toErrorMessage(error, '설정 파일을 읽지 못했습니다.'))
        }
      }
    })
  }, [guardUnsavedChanges, setConfigPath])

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
            workspaceName={workspace?.name ?? null}
            workspacePath={workspace?.rootPath ?? null}
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
          workspaceName={workspace?.name ?? null}
          workspacePath={workspace?.rootPath ?? null}
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
          onSelectEntry={(entry) => setSelectedTreePath(entry.path)}
          onToggleDirectory={toggleDirectory}
          onEnsureExpanded={ensureExpanded}
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
          onChangeContent={(nextContent) =>
            setActiveDoc((current) => (current ? { ...current, content: nextContent } : null))
          }
          onSave={handleManualSave}
        />

        {isSettingsOpen && (
          <SettingsPanel
            theme={config.theme}
            autoSave={config.autoSave}
            autoSaveDelayMs={config.autoSaveDelayMs}
            configPath={configPath}
            onToggleTheme={toggleTheme}
            onToggleAutoSave={toggleAutoSave}
            onUpdateAutoSaveDelay={updateAutoSaveDelay}
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
