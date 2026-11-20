import { useEffect, useRef, useState } from 'react'
import { formatWindowTitle } from '@shared/window'
import { useConfigController } from '../hooks/useConfigController'
import { useConfirmDialog } from '../hooks/useConfirmDialog'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useErrorBanner } from '../hooks/useErrorBanner'
import { useFrontmatterFieldValues } from '../hooks/useFrontmatterFieldValues'
import { useFrontmatterSchema } from '../hooks/useFrontmatterSchema'
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
  const [isSchemaModalOpen, setIsSchemaModalOpen] = useState(false)
  const isDialogOpen = pendingDialog !== null
  const isShortcutDisabled = isDialogOpen || isSchemaModalOpen
  const editor = useEditorWorkspace({
    isAutoSavePaused: isDialogOpen,
    isShortcutDisabled,
    onError: reportErrorBanner,
    onConfirmCloseDirtyTab: confirmCloseDirtyTab
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
      isSchemaModalOpen={isSchemaModalOpen}
      onOpenSchemaModal={() => setIsSchemaModalOpen(true)}
      onCloseSchemaModal={() => setIsSchemaModalOpen(false)}
      showHeadingNumbers={config.showHeadingNumbers}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      frontmatterSchema={frontmatterSchema}
      frontmatterFieldValues={frontmatterFieldValues}
      openWorkspaceFile={editor.openWorkspaceFile}
      reportErrorBanner={reportErrorBanner}
      paneWorkspaceProps={buildPaneWorkspaceProps(config, editor, isShortcutDisabled)}
    />
  )
}
