import { useEffect, useRef, useSyncExternalStore } from 'react'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { isMarkdownDocument, resolveEditorShortcut } from '../editor/editorModes'
import { logRendererInfo } from '../logging/rendererLogger'
import {
  extractLayoutBufferKeys,
  PaneTabStore,
  type PaneTabTransition
} from '../stores/PaneTabStore'
import {
  type DirtyTabClosePrompt,
  RendererBufferSyncClient
} from '../stores/RendererBufferSyncClient'
import { useWikiApi } from './useWikiApi'

export type DirtyTabCloseRequest = DirtyTabClosePrompt

function logPaneTabTransition(
  bufferStore: DocumentBufferStore,
  transition: PaneTabTransition
): void {
  const resolvePath = (bufferKey: string): string =>
    bufferStore.getBuffer(bufferKey)?.path ?? bufferKey

  switch (transition.type) {
    case 'tab-opened':
      logRendererInfo('ui', 'Tab opened', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolvePath(transition.tab.bufferKey),
        mode: transition.tab.mode
      })
      return
    case 'tab-duplicated':
      logRendererInfo('ui', 'Tab duplicated', {
        sourcePaneId: transition.sourcePaneId,
        targetPaneId: transition.targetPaneId,
        sourceTabId: transition.sourceTabId,
        tabId: transition.tab.id,
        filePath: resolvePath(transition.tab.bufferKey),
        mode: transition.tab.mode
      })
      return
    case 'tab-switched':
      logRendererInfo('ui', 'Tab switched', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolvePath(transition.tab.bufferKey),
        mode: transition.tab.mode
      })
      return
    case 'tab-moved':
      logRendererInfo('ui', 'Tab moved', {
        sourcePaneId: transition.sourcePaneId,
        targetPaneId: transition.targetPaneId,
        tabId: transition.tab.id,
        filePath: resolvePath(transition.tab.bufferKey),
        ...(transition.targetIndex !== undefined ? { targetIndex: transition.targetIndex } : {})
      })
      return
    case 'tab-closed':
      logRendererInfo('ui', 'Tab closed', {
        paneId: transition.paneId,
        tabId: transition.closedTab.id,
        filePath: resolvePath(transition.closedTab.bufferKey),
        isLastReferenceForBuffer: transition.isLastReferenceForBuffer
      })
      return
    case 'editor-mode-changed':
      logRendererInfo('ui', 'Editor mode changed', {
        paneId: transition.paneId,
        tabId: transition.tab.id,
        filePath: resolvePath(transition.tab.bufferKey),
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
      onWorkspaceSaved: () => callbacksRef.current.onWorkspaceSaved?.(),
      onError: (message, error) => callbacksRef.current.onError(message, error),
      onConfirmCloseDirtyTab: (request) => callbacksRef.current.onConfirmCloseDirtyTab(request)
    })
    storesRef.current = { bufferStore, tabStore, syncClient }
  }
  const { bufferStore, tabStore, syncClient } = storesRef.current

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)

  useEffect(() => syncClient.start(), [syncClient])

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
      if (!activeTab) return
      const activeBuffer = bufferStore.getBuffer(activeTab.bufferKey)
      const allowRichModes = activeBuffer ? isMarkdownDocument(activeBuffer) : false

      const shortcut = resolveEditorShortcut(event, activeTab.mode, allowRichModes)
      if (!shortcut) return

      event.preventDefault()
      if (shortcut.type === 'save') {
        syncClient.saveActivePaneDocument()
      } else if (shortcut.mode !== activeTab.mode) {
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
    openWorkspaceFile: syncClient.openWorkspaceFile,
    openConfigDocument: syncClient.openConfigDocument,
    refreshCleanConfig: syncClient.refreshCleanConfig,
    openCreatedFile: syncClient.openCreatedFile,
    updateBufferContent: syncClient.updateBufferContent,
    saveBufferByKey: syncClient.saveBufferByKey,
    saveActivePaneDocument: syncClient.saveActivePaneDocument,
    ensureAllWorkspaceBuffersSaved: syncClient.ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary: syncClient.getDirtyWorkspaceSummary,
    requestCloseTab: syncClient.requestCloseTab,
    forceCloseTab: syncClient.forceCloseTab,
    saveAndCloseTab: syncClient.saveAndCloseTab,
    activateTab: tabStore.activateTab,
    focusPane: tabStore.focusPane,
    setSplitMode: tabStore.setSplitMode,
    setSplitRatio: tabStore.setSplitRatio,
    moveTab: tabStore.moveTab,
    splitWithTab: tabStore.splitWithTab,
    duplicateTabToOtherPane: tabStore.duplicateTabToOtherPane,
    updateTabViewState: tabStore.updateTabViewState,
    clearWorkspaceBuffers: syncClient.clearWorkspaceBuffers,
    syncRenamedPath: syncClient.syncRenamedPath,
    syncDeletedPath: syncClient.syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk: syncClient.reconcileWorkspaceBuffersWithDisk
  }
}
