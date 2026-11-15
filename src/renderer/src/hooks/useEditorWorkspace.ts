import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { canDetachTabFromWindow } from '@shared/window'
import type { PaneInteractionActions } from '../components/PaneTabBar'
import {
  isImageDocument,
  resolveEditorShortcut,
  resolveEffectiveEditorMode
} from '../editor/editorModes'
import { logRendererInfo } from '../logging/rendererLogger'
import {
  countLayoutTabs,
  extractLayoutBufferKeys,
  getPaneActiveTab,
  PaneTabStore,
  type PaneTabTransition,
  type TabItem
} from '../stores/PaneTabStore'
import {
  type DirtyTabClosePrompt,
  type OpenedWorkspaceDocument,
  RendererBufferSyncClient
} from '../stores/RendererBufferSyncClient'
import { RendererTabDragController } from '../stores/RendererTabDragController'
import { useWikiApi } from './useWikiApi'

export type { OpenedWorkspaceDocument }

export type DirtyTabCloseRequest = DirtyTabClosePrompt

function logPaneTabTransition(
  bufferStore: DocumentBufferStore,
  transition: PaneTabTransition
): void {
  const resolveTabPath = (tab: TabItem): string =>
    tab.kind === 'diff'
      ? tab.diff.request.path
      : (bufferStore.getBuffer(tab.bufferKey)?.path ?? tab.bufferKey)
  const resolveTabModeMeta = (tab: TabItem): Record<string, string> =>
    tab.kind === 'document' ? { mode: tab.mode } : { kind: 'diff' }

  switch (transition.type) {
    case 'tab-opened':
      logRendererInfo('ui', 'Tab opened', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolveTabPath(transition.tab),
        ...resolveTabModeMeta(transition.tab)
      })
      return
    case 'tab-duplicated':
      logRendererInfo('ui', 'Tab duplicated', {
        sourcePaneId: transition.sourcePaneId,
        targetPaneId: transition.targetPaneId,
        sourceTabId: transition.sourceTabId,
        tabId: transition.tab.id,
        filePath: resolveTabPath(transition.tab),
        ...resolveTabModeMeta(transition.tab)
      })
      return
    case 'tab-switched':
      logRendererInfo('ui', 'Tab switched', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolveTabPath(transition.tab),
        ...resolveTabModeMeta(transition.tab)
      })
      return
    case 'tab-moved':
      logRendererInfo('ui', 'Tab moved', {
        sourcePaneId: transition.sourcePaneId,
        targetPaneId: transition.targetPaneId,
        tabId: transition.tab.id,
        filePath: resolveTabPath(transition.tab),
        ...(transition.targetIndex !== undefined ? { targetIndex: transition.targetIndex } : {})
      })
      return
    case 'tab-closed':
      logRendererInfo('ui', 'Tab closed', {
        paneId: transition.paneId,
        tabId: transition.closedTab.id,
        filePath: resolveTabPath(transition.closedTab),
        isLastReferenceForBuffer: transition.isLastReferenceForBuffer
      })
      return
    case 'editor-mode-changed':
      logRendererInfo('ui', 'Editor mode changed', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolveTabPath(transition.tab),
        from: transition.from,
        to: transition.to
      })
      return
    case 'split-mode-changed':
      logRendererInfo('ui', 'Split mode changed', {
        from: transition.from,
        to: transition.to
      })
      return
  }
}

interface UseEditorWorkspaceOptions {
  isAutoSavePaused: boolean
  isShortcutDisabled?: boolean
  onWorkspaceSaved?: () => void
  onError: (message: string | null, error?: unknown) => void
  onConfirmCloseDirtyTab: (request: DirtyTabCloseRequest) => void
}

/**
 * Provides React-bound workspace buffer and 2-pane tab actions backed by the shared buffer hub.
 */
export function useEditorWorkspace({
  isAutoSavePaused,
  isShortcutDisabled = isAutoSavePaused,
  onWorkspaceSaved,
  onError,
  onConfirmCloseDirtyTab
}: UseEditorWorkspaceOptions) {
  const wikiApi = useWikiApi()
  const isShortcutDisabledRef = useRef<boolean>(isShortcutDisabled)
  const callbacksRef = useRef({
    onWorkspaceSaved,
    onError,
    onConfirmCloseDirtyTab
  })

  isShortcutDisabledRef.current = isShortcutDisabled
  callbacksRef.current = {
    onWorkspaceSaved,
    onError,
    onConfirmCloseDirtyTab
  }

  const storesRef = useRef<{
    bufferStore: DocumentBufferStore
    tabStore: PaneTabStore
    syncClient: RendererBufferSyncClient
    tabDragController: RendererTabDragController
  } | null>(null)
  if (!storesRef.current) {
    const bufferStore = new DocumentBufferStore()
    const tabStore = new PaneTabStore({
      onTransition: (transition) => logPaneTabTransition(bufferStore, transition)
    })
    const syncClient = new RendererBufferSyncClient({
      bufferStore,
      tabStore,
      bufferApi: wikiApi.buffer,
      windowApi: wikiApi.window,
      onWorkspaceSaved: () => callbacksRef.current.onWorkspaceSaved?.(),
      onError: (message, error) => callbacksRef.current.onError(message, error),
      onConfirmCloseDirtyTab: (request) => callbacksRef.current.onConfirmCloseDirtyTab(request)
    })
    const tabDragController = new RendererTabDragController({
      tabStore,
      bufferSync: syncClient,
      windowApi: wikiApi.window,
      onError: (message, error) => callbacksRef.current.onError(message, error)
    })
    storesRef.current = { bufferStore, tabStore, syncClient, tabDragController }
  }
  const { bufferStore, tabStore, syncClient, tabDragController } = storesRef.current

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)
  const dragState = useSyncExternalStore(
    tabDragController.subscribe,
    tabDragController.getSnapshot
  )
  const activeTab = getPaneActiveTab(layout.panes[layout.activePaneId])
  const activeBuffer =
    activeTab?.kind === 'document' ? buffers[activeTab.bufferKey] : undefined
  const activeFilePath = activeBuffer?.kind === 'workspace' ? activeBuffer.path : null
  const totalTabCount = countLayoutTabs(layout)
  const canDetachToNewWindow = canDetachTabFromWindow(wikiApi.window?.role, totalTabCount)

  const paneActions = useMemo<PaneInteractionActions>(
    () => ({
      onFocusPane: tabStore.focusPane,
      onActivateTab: tabStore.activateTab,
      onCloseTab: syncClient.requestCloseTab,
      onMoveTab: tabStore.moveTab,
      onDuplicateTab: tabStore.duplicateTabToOtherPane,
      ...(canDetachToNewWindow
        ? {
            onDetachTabToNewWindow: (paneId, tabId) =>
              void syncClient.detachTabToNewWindow(paneId, tabId)
          }
        : {}),
      onStartTabDrag: tabDragController.startDrag,
      onDropExternalTab: (target, dragSessionId) =>
        void tabDragController.acceptExternalDrop(target, dragSessionId),
      onDropTabInWindow: tabDragController.completeInWindowDrop,
      onCancelTabDrag: tabDragController.cancelDrag,
      onEndTabDrag: (screenPoint) => void tabDragController.endDrag(screenPoint),
      onChangeContent: syncClient.updateBufferContent,
      onSaveBuffer: syncClient.saveBufferByKey,
      onUpdateTabViewState: tabStore.updateTabViewState,
      onChangeDiffViewMode: tabStore.updateDiffTabViewMode,
      onOpenDiffTargetFile: () => undefined
    }),
    [canDetachToNewWindow, syncClient, tabDragController, tabStore]
  )

  useEffect(() => {
    const stopSync = syncClient.start()
    const stopDrag = tabDragController.start()
    return () => {
      stopDrag()
      stopSync()
    }
  }, [syncClient, tabDragController])

  useEffect(() => {
    void wikiApi.buffer.setAutoSavePaused(isAutoSavePaused).catch(() => undefined)
  }, [isAutoSavePaused, wikiApi])

  useEffect(() => {
    syncClient.syncWindowTabs(extractLayoutBufferKeys(layout))
  }, [layout, syncClient])

  // Global fallback Ctrl+S and mode-switch shortcut handler when focus is outside a specific pane editor
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isShortcutDisabledRef.current) return
      const activeTab = tabStore.getActiveTab()
      if (!activeTab || activeTab.kind === 'diff') return
      const activeBuffer = bufferStore.getBuffer(activeTab.bufferKey)
      const isImage = isImageDocument(activeBuffer)
      const { allowRichModes, effectiveMode } = resolveEffectiveEditorMode(
        activeBuffer,
        activeTab.mode
      )

      const shortcut = resolveEditorShortcut(event, effectiveMode, allowRichModes, isImage)
      if (!shortcut) return

      event.preventDefault()
      if (shortcut.type === 'save') {
        syncClient.saveActivePaneDocument()
      } else if (shortcut.type === 'mode' && shortcut.mode !== activeTab.mode) {
        tabStore.updateTabViewState(tabStore.getSnapshot().activePaneId, activeTab.id, {
          mode: shortcut.mode
        })
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
    }
  }, [bufferStore, syncClient, tabStore])

  return {
    buffers,
    layout,
    activeTab,
    activeBuffer,
    activeFilePath,
    totalTabCount,
    dragState,
    paneActions,
    openWorkspaceFile: syncClient.openWorkspaceFile,
    openConfigDocument: syncClient.openConfigDocument,
    refreshCleanConfig: syncClient.refreshCleanConfig,
    openCreatedFile: syncClient.openCreatedFile,
    updateBufferContent: syncClient.updateBufferContent,
    saveBufferByKey: syncClient.saveBufferByKey,
    saveActivePaneDocument: syncClient.saveActivePaneDocument,
    ensureAllWorkspaceBuffersSaved: syncClient.ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary: syncClient.getDirtyWorkspaceSummary,
    getDirtyCloseSummary: syncClient.getDirtyCloseSummary,
    ensureCloseBuffersSaved: syncClient.ensureCloseBuffersSaved,
    requestCloseTab: syncClient.requestCloseTab,
    forceCloseTab: syncClient.forceCloseTab,
    saveAndCloseTab: syncClient.saveAndCloseTab,
    detachTabToNewWindow: syncClient.detachTabToNewWindow,
    activateTab: tabStore.activateTab,
    focusPane: tabStore.focusPane,
    setSplitMode: tabStore.setSplitMode,
    setSplitRatio: tabStore.setSplitRatio,
    moveTab: tabStore.moveTab,
    splitWithTab: tabStore.splitWithTab,
    duplicateTabToOtherPane: tabStore.duplicateTabToOtherPane,
    updateTabViewState: tabStore.updateTabViewState,
    openDiffTab: tabStore.openDiffTab,
    updateDiffTabViewMode: tabStore.updateDiffTabViewMode,
    clearWorkspaceBuffers: syncClient.clearWorkspaceBuffers,
    syncRenamedPath: syncClient.syncRenamedPath,
    syncDeletedPath: syncClient.syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk: syncClient.reconcileWorkspaceBuffersWithDisk
  }
}
