import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { TEXT_ENCODING_LABELS, type TextEncoding } from '@shared/encoding'
import { toErrorMessage } from '@shared/errors'
import { canDetachTabFromWindow, type WindowInitContext } from '@shared/window'
import type { ConfirmActionDialogRequest } from '../utils/confirmPrompts'
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
import { PaneNavigationCoordinator } from '../stores/PaneNavigationCoordinator'
import {
  type DirtyTabClosePrompt,
  type OpenedWorkspaceDocument,
  RendererBufferSyncClient
} from '../stores/RendererBufferSyncClient'
import { RendererTabDragController } from '../stores/RendererTabDragController'
import {
  type RestoreWorkspaceLayoutOptions,
  restoreWorkspacePaneLayout,
  type WorkspaceLayoutSnapshot
} from '../stores/workspaceLayoutPersistence'
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
      : tab.kind === 'snapshot'
        ? tab.snapshot.request.path
        : (bufferStore.getBuffer(tab.bufferKey)?.path ?? tab.bufferKey)
  const resolveTabModeMeta = (tab: TabItem): Record<string, string> =>
    tab.kind === 'document' ? { mode: tab.mode } : { kind: tab.kind }

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
  loadInitContext?: () => Promise<WindowInitContext | null>
  onWorkspaceSaved?: () => void
  onError: (message: string | null, error?: unknown) => void
  onConfirmCloseDirtyTab: (request: DirtyTabCloseRequest) => void
  onConfirmAction?: (request: ConfirmActionDialogRequest) => Promise<boolean>
}

/**
 * Provides React-bound workspace buffer and 2-pane tab actions backed by the shared buffer hub.
 */
export function useEditorWorkspace({
  isAutoSavePaused,
  isShortcutDisabled = isAutoSavePaused,
  loadInitContext,
  onWorkspaceSaved,
  onError,
  onConfirmCloseDirtyTab,
  onConfirmAction
}: UseEditorWorkspaceOptions) {
  const wikiApi = useWikiApi()
  const isShortcutDisabledRef = useRef<boolean>(isShortcutDisabled)
  const callbacksRef = useRef({
    onWorkspaceSaved,
    onError,
    onConfirmCloseDirtyTab,
    onConfirmAction
  })

  isShortcutDisabledRef.current = isShortcutDisabled
  callbacksRef.current = {
    onWorkspaceSaved,
    onError,
    onConfirmCloseDirtyTab,
    onConfirmAction
  }

  const storesRef = useRef<{
    bufferStore: DocumentBufferStore
    tabStore: PaneTabStore
    syncClient: RendererBufferSyncClient
    tabDragController: RendererTabDragController
    navigation: PaneNavigationCoordinator
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
      loadInitContext,
      onWorkspaceSaved: () => callbacksRef.current.onWorkspaceSaved?.(),
      onError: (message, error) => callbacksRef.current.onError(message, error),
      onConfirmCloseDirtyTab: (request) => callbacksRef.current.onConfirmCloseDirtyTab(request),
      onConfirmLossySave: async ({ bufferName, encoding, unencodableChars }) => {
        const confirmAction = callbacksRef.current.onConfirmAction
        if (!confirmAction) return false
        const label = TEXT_ENCODING_LABELS[encoding]
        const samplePreview = unencodableChars.samples.join(' ')
        return confirmAction({
          title: '표현할 수 없는 문자 포함',
          message:
            `"${bufferName}"에 ${label} 인코딩으로 표현할 수 없는 문자 ${unencodableChars.count}개` +
            (samplePreview ? `(${samplePreview})` : '') +
            `가 포함되어 있습니다. 그대로 저장하면 해당 문자가 '?'로 대체됩니다. 계속 저장할까요?`,
          confirmLabel: "'?'로 대체하여 저장",
          confirmTone: 'danger'
        })
      }
    })
    const tabDragController = new RendererTabDragController({
      tabStore,
      bufferSync: syncClient,
      windowApi: wikiApi.window,
      onError: (message, error) => callbacksRef.current.onError(message, error)
    })
    const navigation = new PaneNavigationCoordinator({
      tabStore,
      bufferStore,
      openWorkspaceFile: syncClient.openWorkspaceFile
    })
    storesRef.current = { bufferStore, tabStore, syncClient, tabDragController, navigation }
  }
  const { bufferStore, tabStore, syncClient, tabDragController, navigation } = storesRef.current

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)
  const layoutSnapshot = useMemo<WorkspaceLayoutSnapshot>(
    () => ({ layout, buffers }),
    [buffers, layout]
  )
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
      onChangeEncoding: (bufferKey: string, nextEncoding: TextEncoding) => {
        callbacksRef.current.onError(null)
        void syncClient.setEncoding(bufferKey, nextEncoding).catch((error: unknown) => {
          callbacksRef.current.onError(
            toErrorMessage(error, '인코딩 변경에 실패했습니다.'),
            error
          )
        })
      },
      onReopenWithEncoding: (bufferKey: string, targetEncoding: TextEncoding) => {
        void (async () => {
          const buffer = bufferStore.getBuffer(bufferKey)
          if (!buffer) return
          if (buffer.isDirty && callbacksRef.current.onConfirmAction) {
            const label = TEXT_ENCODING_LABELS[targetEncoding]
            const confirmed = await callbacksRef.current.onConfirmAction({
              title: '인코딩으로 다시 열기',
              message: `"${buffer.name}"에 저장하지 않은 변경 사항이 있습니다. ${label} 인코딩으로 다시 열면 변경 사항이 사라집니다. 계속할까요?`,
              confirmLabel: '다시 열기',
              confirmTone: 'danger'
            })
            if (!confirmed) return
          }
          callbacksRef.current.onError(null)
          await syncClient.reopenWithEncoding(bufferKey, targetEncoding)
        })().catch((error: unknown) => {
          callbacksRef.current.onError(
            toErrorMessage(error, '인코딩으로 다시 열기에 실패했습니다.'),
            error
          )
        })
      },
      onUpdateTabViewState: tabStore.updateTabViewState,
      onChangeDiffViewMode: tabStore.updateDiffTabViewMode,
      onPinDiffTab: tabStore.pinDiffTab,
      onPinSnapshotTab: tabStore.pinSnapshotTab,
      onOpenSnapshotTab: tabStore.openSnapshotTab,
      onUpdateSnapshotScrollTop: tabStore.updateSnapshotTabScrollTop
    }),
    [canDetachToNewWindow, syncClient, tabDragController, tabStore]
  )

  useEffect(() => {
    const stopSync = syncClient.start()
    const stopDrag = tabDragController.start()
    return () => {
      navigation.dispose()
      stopDrag()
      stopSync()
    }
  }, [navigation, syncClient, tabDragController])

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
      if (!activeTab || activeTab.kind !== 'document') return
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
    activeBuffer,
    activeFilePath,
    dragState,
    paneActions,
    navigation,
    openWorkspaceFile: syncClient.openWorkspaceFile,
    openConfigDocument: syncClient.openConfigDocument,
    refreshCleanConfig: syncClient.refreshCleanConfig,
    openCreatedFile: syncClient.openCreatedFile,
    ensureAllWorkspaceBuffersSaved: syncClient.ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary: syncClient.getDirtyWorkspaceSummary,
    getDirtyCloseSummary: syncClient.getDirtyCloseSummary,
    ensureCloseBuffersSaved: syncClient.ensureCloseBuffersSaved,
    setSplitRatio: tabStore.setSplitRatio,
    splitWithTab: tabStore.splitWithTab,
    openDiffTab: tabStore.openDiffTab,
    openSnapshotTab: tabStore.openSnapshotTab,
    listOpenDiffRequests: tabStore.listOpenDiffRequests,
    subscribeLayout: tabStore.subscribe,
    closeUnstagedDiffTabsForPaths: tabStore.closeUnstagedDiffTabsForPaths,
    closeUnstagedDiffTabsExcept: tabStore.closeUnstagedDiffTabsExcept,
    closeStagedDiffTabsExcept: tabStore.closeStagedDiffTabsExcept,
    closeAllUnstagedDiffTabs: tabStore.closeAllUnstagedDiffTabs,
    reconcileStashDiffTabs: tabStore.reconcileStashDiffTabs,
    reconcileBranchCompareDiffTabs: tabStore.reconcileBranchCompareDiffTabs,
    prepareWorkspacePathsForDiscard: syncClient.prepareWorkspacePathsForDiscard,
    finishWorkspacePathsDiscard: syncClient.finishWorkspacePathsDiscard,
    clearWorkspaceBuffers: syncClient.clearWorkspaceBuffers,
    restoreWorkspaceLayout: (options: RestoreWorkspaceLayoutOptions) =>
      restoreWorkspacePaneLayout(syncClient, options),
    layoutSnapshot,
    getLayoutSnapshot: (): WorkspaceLayoutSnapshot => ({
      layout: tabStore.getSnapshot(),
      buffers: bufferStore.getSnapshot()
    }),
    syncRenamedPath: syncClient.syncRenamedPath,
    syncDeletedPath: syncClient.syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk: syncClient.reconcileWorkspaceBuffersWithDisk
  }
}
