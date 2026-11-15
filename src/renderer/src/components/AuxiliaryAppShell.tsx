import { useEffect, useRef } from 'react'
import { formatWindowTitle } from '@shared/window'
import { useConfigController } from '../hooks/useConfigController'
import { useEditorOutlineAndSidebar } from '../hooks/useEditorOutlineAndSidebar'
import { useEditorWorkspace } from '../hooks/useEditorWorkspace'
import { useWikiApi } from '../hooks/useWikiApi'
import { useWindowAlerts } from '../hooks/useWindowAlerts'
import { EditorWindowFrame } from './EditorWindowFrame'

/**
 * Auxiliary editor shell dedicated to detached document tabs: omits workspace/settings chrome,
 * keeps right outline collapsed initially, tracks the active document title, and closes once empty.
 */
export function AuxiliaryAppShell() {
  const wikiApi = useWikiApi()
  const alerts = useWindowAlerts()
  const { config, toggleShowHeadingNumbers } = useConfigController({
    onError: alerts.reportErrorBanner
  })
  const editor = useEditorWorkspace({
    isAutoSavePaused: alerts.pendingDialog !== null,
    isShortcutDisabled: alerts.pendingDialog !== null,
    onError: alerts.reportErrorBanner,
    onConfirmCloseDirtyTab: alerts.handleConfirmCloseDirtyTab
  })
  alerts.bindTabCloseActions(editor.saveAndCloseTab, editor.forceCloseTab)

  const frame = useEditorOutlineAndSidebar({
    initialRightCollapsed: true,
    buffers: editor.buffers,
    layout: editor.layout,
    editorActions: editor
  })

  useEffect(() => {
    document.title = formatWindowTitle(frame.activeBuffer?.name)
  }, [frame.activeBuffer?.name])

  const hadTabsRef = useRef<boolean>(false)
  useEffect(() => {
    if (frame.totalTabCount > 0) {
      hadTabsRef.current = true
      return
    }
    if (hadTabsRef.current) {
      void wikiApi.window?.closeCurrent().catch(() => undefined)
    }
  }, [frame.totalTabCount, wikiApi])

  return (
    <EditorWindowFrame
      theme={config.theme}
      autoSave={config.autoSave}
      showHeadingNumbers={config.showHeadingNumbers}
      customCommands={config.customCommands}
      errorMessage={alerts.errorMessage}
      pendingDialog={alerts.pendingDialog}
      onDismissDialog={() => alerts.setPendingDialog(null)}
      onToggleHeadingNumbers={toggleShowHeadingNumbers}
      workspaceProps={{
        layout: editor.layout,
        buffers: editor.buffers,
        scrollRequest: frame.outlineScrollRequest,
        isShortcutDisabled: alerts.pendingDialog !== null,
        canDetachToNewWindow: frame.totalTabCount > 1,
        onSetSplitRatio: editor.setSplitRatio,
        onSplitWithTab: editor.splitWithTab,
        actions: frame.paneActions
      }}
      outlinePanelProps={frame.outlinePanelProps}
      rightSidebar={frame.rightSidebar}
    />
  )
}
