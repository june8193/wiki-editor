import { useMemo, useState } from 'react'
import { createWindowInitContextLoader } from '@shared/window'
import { useAuxiliaryDiffState } from '../hooks/useAuxiliaryDiffState'
import { useSnapshotTabState } from '../hooks/useSnapshotTabState'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useFrontmatterFieldValues } from '../hooks/useFrontmatterFieldValues'
import { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { useWindowTitle } from '../hooks/useWindowTitle'
import { getPaneActiveTab } from '../stores/PaneTabStore'
import { getGitDiffTabLabel } from '../utils/gitFilePresentation'
import { buildPaneWorkspaceProps, EditorWindowFrame } from './EditorWindowFrame'
import type { PaneInteractionActions } from './PaneTabBar'
import { TitleBar } from './TitleBar'

/**
 * Auxiliary window shell dedicated to detached document tabs: omits application menu bar,
 * activity bar, left sidebar, and settings panel; starts with the right sidebar collapsed;
 * tracks the active document title; and closes when open tabs drop to zero.
 */
export function AuxiliaryAppShell() {
  const wikiApi = useWikiApi()
  const { errorMessage, reportErrorBanner } = useErrorBanner()
  const { pendingDialog, dismissDialog, confirmCloseDirtyTab, confirmUnsavedChanges, requestConfirm } =
    useConfirmDialog()
  const { config, toggleShowHeadingNumbers } = useConfigController({
    onError: reportErrorBanner
  })
  const [isSchemaModalOpen, setIsSchemaModalOpen] = useState(false)
  const loadInitContext = useMemo(
    () => createWindowInitContextLoader(wikiApi.window),
    [wikiApi.window]
  )
  const isDialogOpen = pendingDialog !== null
  const isShortcutDisabled = isDialogOpen || isSchemaModalOpen
  const editor = useEditorWorkspace({
    isAutoSavePaused: isDialogOpen,
    isShortcutDisabled,
    loadInitContext,
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: confirmCloseDirtyTab,
    onConfirmAction: requestConfirm
  })
  const frontmatterSchema = useFrontmatterSchema({
    workspaceRootPath: null,
    onError: reportErrorBanner
  })
  const frontmatterFieldValues = useFrontmatterFieldValues({
    workspaceRootPath: null,
    schema: frontmatterSchema.schemaResult?.schema ?? null,
    activeDocumentKey: editor.activeBuffer?.key ?? null
  })

  const activeTab = getPaneActiveTab(editor.layout.panes[editor.layout.activePaneId])
  const auxiliaryWorkspaceRootPath = useMemo(() => {
    if (activeTab?.kind === 'diff' && activeTab.diff.workspaceRootPath) {
      return activeTab.diff.workspaceRootPath
    }
    if (activeTab?.kind === 'snapshot' && activeTab.snapshot.workspaceRootPath) {
      return activeTab.snapshot.workspaceRootPath
    }
    for (const pane of [editor.layout.panes.primary, editor.layout.panes.secondary]) {
      for (const tab of pane.tabs) {
        if (tab.kind === 'diff' && tab.diff.workspaceRootPath) {
          return tab.diff.workspaceRootPath
        }
        if (tab.kind === 'snapshot' && tab.snapshot.workspaceRootPath) {
          return tab.snapshot.workspaceRootPath
        }
      }
    }
    return null
  }, [activeTab, editor.layout.panes.primary, editor.layout.panes.secondary])

  const { diffsByKey, openDiffTargetFile } = useAuxiliaryDiffState({
    layout: editor.layout,
    gitApi: wikiApi.git,
    openWorkspaceFile: editor.openWorkspaceFile
  })
  const { snapshotsByKey, openSnapshotTargetFile } = useSnapshotTabState({
    layout: editor.layout,
    workspaceRootPath: auxiliaryWorkspaceRootPath,
    gitApi: wikiApi.git,
    openWorkspaceFile: editor.openWorkspaceFile
  })

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      ...editor.paneActions,
      onOpenDiffTargetFile: openDiffTargetFile,
      onOpenSnapshotTargetFile: openSnapshotTargetFile
    }),
    [editor.paneActions, openDiffTargetFile, openSnapshotTargetFile]
  )

  useWindowCloseGuard({
    wikiApi,
    getDirtySummary: editor.getDirtyCloseSummary,
    saveDirtyBuffers: editor.ensureCloseBuffersSaved,
    confirmUnsavedChanges
  })

  const activeTitleName =
    activeTab?.kind === 'diff'
      ? getGitDiffTabLabel(activeTab.diff.request)
      : activeTab?.kind === 'snapshot'
        ? `🔒 ${activeTab.snapshot.request.scope.displayRef} · ${activeTab.snapshot.request.path.split(/[\\/]/).pop() ?? activeTab.snapshot.request.path}`
        : editor.activeBuffer?.name

  const windowTitle = useWindowTitle(loadInitContext, activeTitleName)

  return (
    <EditorWindowFrame
      initialRightSidebarCollapsed
      workspaceRootPath={auxiliaryWorkspaceRootPath}
      titleBarSlot={<TitleBar title={windowTitle} />}
      errorMessage={errorMessage}
      pendingDialog={pendingDialog}
      onDismissDialog={dismissDialog}
      isSchemaModalOpen={isSchemaModalOpen}
      onOpenSchemaModal={() => setIsSchemaModalOpen(true)}
      onCloseSchemaModal={() => setIsSchemaModalOpen(false)}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      frontmatterSchema={frontmatterSchema}
      frontmatterFieldValues={frontmatterFieldValues}
      openWorkspaceFile={editor.openWorkspaceFile}
      reportErrorBanner={reportErrorBanner}
      navigation={editor.navigation}
      paneWorkspaceProps={buildPaneWorkspaceProps(
        config,
        { ...editor, paneActions },
        isShortcutDisabled,
        { diffsByKey, snapshotsByKey }
      )}
    />
  )
}
