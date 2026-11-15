import { useEffect, useRef } from 'react'
import { formatWindowTitle } from '@shared/window'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowCloseGuard } from '../hooks/useWindowCloseGuard'
import { buildPaneWorkspaceProps, EditorWindowFrame } from './EditorWindowFrame'

/**
 * Auxiliary window shell dedicated to detached document tabs: omits application menu bar,
 * activity bar, left sidebar, and settings panel; starts with the right sidebar collapsed;
 * tracks the active document title; and closes when open tabs drop to zero.
 */
export function AuxiliaryAppShell() {
  const wikiApi = useWikiApi()
  const { errorMessage, reportErrorBanner } = useErrorBanner()
  const { pendingDialog, dismissDialog, confirmCloseDirtyTab, confirmUnsavedChanges } =
    useConfirmDialog()
  const { config, toggleShowHeadingNumbers } = useConfigController({
    onError: reportErrorBanner
  })
  const isDialogOpen = pendingDialog !== null
  const editor = useEditorWorkspace({
    isAutoSavePaused: isDialogOpen,
    isShortcutDisabled: isDialogOpen,
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: confirmCloseDirtyTab
  })

  useWindowCloseGuard({
    wikiApi,
    getDirtySummary: editor.getDirtyCloseSummary,
    saveDirtyBuffers: editor.ensureCloseBuffersSaved,
    confirmUnsavedChanges
  })

  useEffect(() => {
    document.title = formatWindowTitle(editor.activeBuffer?.name)
  }, [editor.activeBuffer?.name])

  const hadTabsRef = useRef<boolean>(false)
  useEffect(() => {
    if (editor.totalTabCount > 0) {
      hadTabsRef.current = true
      return
    }
    if (hadTabsRef.current) {
      void wikiApi.window?.closeCurrent().catch(() => undefined)
    }
  }, [editor.totalTabCount, wikiApi])

  return (
    <EditorWindowFrame
      initialRightSidebarCollapsed
      errorMessage={errorMessage}
      pendingDialog={pendingDialog}
      onDismissDialog={dismissDialog}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      openWorkspaceFile={editor.openWorkspaceFile}
      reportErrorBanner={reportErrorBanner}
      paneWorkspaceProps={buildPaneWorkspaceProps(config, editor, isDialogOpen)}
    />
  )
}
