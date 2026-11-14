import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isFavoriteWorkspacePath, WorkspaceEntry } from '@shared/workspace'
import { ConfirmDialog } from './components/ConfirmDialog'
import type { OutlineScrollRequest } from './components/DocumentEditor'
import { DocumentOutlinePanel } from './components/DocumentOutlinePanel'
import { FolderTreeSidebar } from './components/FolderTreeSidebar'
import { GitSidebarPanel } from './components/GitSidebarPanel'
import { PaneInteractionActions } from './components/PaneTabBar'
import { PaneWorkspace } from './components/PaneWorkspace'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
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
import { useWorkspaceTree } from './hooks/useWorkspaceTree'
import { getPaneActiveTab, type PaneId, type TabViewPatch } from './stores/PaneTabStore'
import { toErrorMessage } from './utils/toErrorMessage'

interface PendingDialogState {
  title: string
  message: string
  confirmLabel: string
  secondaryLabel?: string
  onConfirm: () => Promise<void> | void
  onSecondary?: () => Promise<void> | void
  onCancel?: () => void
}

export function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null)
  const [outlineScrollRequest, setOutlineScrollRequest] = useState<OutlineScrollRequest | null>(null)
  const scrollNonceRef = useRef(0)
  const refreshConfigDocRef = useRef<() => Promise<void>>(async () => undefined)
  const refreshGitStatusRef = useRef<() => Promise<void>>(async () => undefined)
  const reconcileBuffersRef = useRef<() => Promise<readonly string[]>>(async () => [])
  const pendingGitConfirmCancelRef = useRef<(() => void) | null>(null)
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
    toggleShowHeadingNumbers,
    updateCustomCommands,
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
    autoSave: config.autoSave,
    autoSaveDelayMs: config.autoSaveDelayMs,
    isAutoSavePaused: pendingDialog !== null,
    onSaveConfigRaw: saveRawConfig,
    onWorkspaceSaved: () => void refreshGitStatusRef.current(),
    onError: setErrorMessage,
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
    onError: setErrorMessage,
    onWorkspaceOpened: clearWorkspaceBuffers,
    onWorkspaceChanged: () => {
      void reconcileBuffersRef.current().then((warnings) => {
        if (warnings.length > 0) {
          setErrorMessage(warnings.join(' '))
        }
      })
      void refreshGitStatusRef.current()
    },
    onFileCreated: openCreatedFile,
    onEntryRenamed: syncRenamedPath,
    onEntryDeleted: syncDeletedPath
  })

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
    workspaceRootPath: workspace?.rootPath ?? null,
    confirmBeforeWorkspaceMutation: confirmDirtyBuffersBeforeGitMutation,
    onWorkspaceMutated: handleGitWorkspaceMutated
  })
  refreshGitStatusRef.current = git.refreshStatus

  const guardUnsavedWorkspaceChanges = useCallback(
    (proceed: () => Promise<void>): void => {
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
  const isActiveMarkdown = activeBuffer ? isMarkdownDocument(activeBuffer) : false

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
      onChangeContent: handlePaneChangeContent,
      onSaveBuffer: saveBufferByKey,
      onUpdateTabViewState: handlePaneUpdateTabViewState
    }),
    [
      activateTab,
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

  return (
    <div className="app-shell" data-theme={config.theme}>
      <header className="app-header">
        <div className="app-header-left">
          <h1 className="app-title">Wiki Editor</h1>
          <button type="button" className="btn" onClick={handleSelectFolder}>
            폴더 열기
          </button>
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
        <aside className="left-sidebar">
          <FolderTreeSidebar
            workspace={workspace}
            isFavorite={isCurrentWorkspaceFavorite}
            workspaceSwitcher={
              <WorkspaceSwitcher
                workspace={workspace}
                favoriteWorkspaces={config.favoriteWorkspaces}
                recentWorkspaces={config.recentWorkspaces}
                onSwitchWorkspace={handleSwitchWorkspace}
                onRemoveFavorite={removeFavoriteWorkspace}
              />
            }
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
          />
        </aside>

        <PaneWorkspace
          layout={layout}
          buffers={buffers}
          theme={config.theme}
          autoSave={config.autoSave}
          showHeadingNumbers={config.showHeadingNumbers}
          customCommands={config.customCommands}
          scrollRequest={outlineScrollRequest}
          isShortcutDisabled={pendingDialog !== null}
          onSetSplitRatio={setSplitRatio}
          onSplitWithTab={splitWithTab}
          actions={paneActions}
        />

        {isSettingsOpen && (
          <SettingsPanel
            theme={config.theme}
            autoSave={config.autoSave}
            showHeadingNumbers={config.showHeadingNumbers}
            configPath={configPath}
            customCommands={config.customCommands}
            previewTitle={activeBuffer ? deriveDocumentTitle(activeBuffer.name) : undefined}
            onToggleTheme={toggleTheme}
            onToggleAutoSave={toggleAutoSave}
            onToggleShowHeadingNumbers={toggleShowHeadingNumbers}
            onSaveCustomCommands={updateCustomCommands}
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
          onCancel={() => {
            pendingDialog.onCancel?.()
            setPendingDialog(null)
          }}
        />
      )}
    </div>
  )
}
