import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { DocumentBuffer } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { toErrorMessage } from '@shared/errors'
import { getWorkspacePathKey, WorkspaceEntry } from '@shared/workspace'
import { isMarkdownDocument, resolveEditorShortcut } from '../editor/editorModes'
import { logRendererInfo } from '../logging/rendererLogger'
import { type PaneId, PaneTabStore, type PaneTabTransition } from '../stores/PaneTabStore'
import {
  extractLayoutBufferKeys,
  RendererBufferSyncClient
} from '../stores/RendererBufferSyncClient'
import { useWikiApi } from './useWikiApi'

export interface DirtyTabCloseRequest {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
}

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
 * Provides React-bound workspace buffer & 2-pane tab actions backed by the shared buffer hub.
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
      onSaveError: (message, error) => callbacksRef.current.onError(message, error)
    })
    storesRef.current = { bufferStore, tabStore, syncClient }
  }
  const { bufferStore, tabStore, syncClient } = storesRef.current

  syncClient.updateCallbacks({
    onWorkspaceSaved: () => callbacksRef.current.onWorkspaceSaved?.(),
    onSaveError: (message, error) => callbacksRef.current.onError(message, error)
  })

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)

  useEffect(() => syncClient.start(), [syncClient])

  useEffect(() => {
    void wikiApi.buffer.setAutoSavePaused(isAutoSavePaused).catch(() => undefined)
  }, [isAutoSavePaused, wikiApi])

  useEffect(() => {
    syncClient.syncWindowTabs(extractLayoutBufferKeys(layout))
  }, [layout, syncClient])

  const saveBufferByKey = useCallback(
    (bufferKey: string): void => {
      const current = bufferStore.getBuffer(bufferKey)
      if (!current || !current.isDirty || current.isSaving) {
        return
      }
      callbacksRef.current.onError(null)
      void syncClient
        .runManualSave(current.key, () => wikiApi.buffer.saveBuffer(current.key))
        .catch((error: unknown) => {
          if (syncClient.isMounted()) {
            callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
          }
        })
    },
    [bufferStore, syncClient, wikiApi]
  )

  const saveActivePaneDocument = useCallback((): void => {
    const activeTab = tabStore.getActiveTab()
    if (!activeTab) return
    saveBufferByKey(activeTab.bufferKey)
  }, [saveBufferByKey, tabStore])

  const ensureSavedBuffer = useCallback(
    async (bufferKey: string): Promise<boolean> => {
      const resolvedKey = syncClient.resolveLatestKey(bufferKey)
      const current = syncClient.getHubBufferOrLocal(resolvedKey)
      if (!current || (!current.isDirty && !current.isSaving)) {
        return true
      }

      try {
        const result = await syncClient.runManualSave(resolvedKey, () =>
          wikiApi.buffer.saveBuffer(resolvedKey)
        )
        return result.ok
      } catch (error: unknown) {
        if (syncClient.isMounted()) {
          callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
        }
        return false
      }
    },
    [syncClient, wikiApi]
  )

  const ensureAllWorkspaceBuffersSaved = useCallback(async (): Promise<boolean> => {
    const localKeys = new Set(extractLayoutBufferKeys(tabStore.getSnapshot()))
    const targetKeys = new Set<string>()
    for (const key of localKeys) {
      const buf = syncClient.getHubBufferOrLocal(key)
      if (buf && buf.kind === 'workspace' && (buf.isDirty || buf.isSaving)) {
        targetKeys.add(buf.key)
      }
    }

    for (const key of targetKeys) {
      if (!(await ensureSavedBuffer(key))) return false
    }
    return true
  }, [ensureSavedBuffer, syncClient, tabStore])

  const getDirtyWorkspaceSummary = useCallback((): string | null => {
    const localKeys = new Set(extractLayoutBufferKeys(tabStore.getSnapshot()))
    const dirty = bufferStore
      .getDirtyBuffers('workspace')
      .filter((buf) => localKeys.has(buf.key))
    if (dirty.length === 0) return null
    if (dirty.length === 1) return dirty[0].name
    return `${dirty[0].name} 외 ${dirty.length - 1}개`
  }, [bufferStore, tabStore])

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
        saveActivePaneDocument()
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
  }, [bufferStore, saveActivePaneDocument, tabStore])

  const openWorkspaceFile = useCallback(
    async (entry: WorkspaceEntry, targetPaneId?: PaneId): Promise<void> => {
      const key = getWorkspacePathKey(entry.path)
      syncClient.prepareKeyOpen(key)
      if (bufferStore.hasBuffer(key)) {
        tabStore.openTab(key, { paneId: targetPaneId })
        return
      }

      callbacksRef.current.onError(null)
      try {
        const buf = await wikiApi.buffer.openWorkspaceFile(entry.path, entry.name)
        if (!syncClient.isMounted()) return
        syncClient.prepareKeyOpen(buf.key)
        if (!bufferStore.hasBuffer(buf.key)) {
          bufferStore.upsertBuffer(buf)
        }
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (syncClient.isMounted()) {
          callbacksRef.current.onError(toErrorMessage(error, '파일을 열지 못했습니다.'), error)
        }
      }
    },
    [bufferStore, syncClient, tabStore, wikiApi]
  )

  const openConfigDocument = useCallback(
    async (targetPaneId?: PaneId): Promise<void> => {
      const existingConfig = bufferStore
        .getAllBuffers()
        .find((buffer) => buffer.kind === 'config')
      if (existingConfig) {
        tabStore.openTab(existingConfig.key, { paneId: targetPaneId })
        return
      }

      callbacksRef.current.onError(null)
      try {
        const buf = await wikiApi.buffer.openConfigDocument()
        if (!syncClient.isMounted()) return
        if (!bufferStore.hasBuffer(buf.key)) {
          bufferStore.upsertBuffer(buf)
        }
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (syncClient.isMounted()) {
          callbacksRef.current.onError(
            toErrorMessage(error, '설정 파일을 읽지 못했습니다.'),
            error
          )
        }
      }
    },
    [bufferStore, syncClient, tabStore, wikiApi]
  )

  const refreshCleanConfig = useCallback(async (): Promise<void> => {
    try {
      await wikiApi.buffer.refreshCleanConfig()
    } catch {
      // Preserve primary error banners during background config refresh
    }
  }, [wikiApi])

  const openCreatedFile = useCallback(
    (created: WorkspaceEntry): void => {
      const key = getWorkspacePathKey(created.path)
      syncClient.prepareKeyOpen(key)
      const buf = bufferStore.openBuffer({
        kind: 'workspace',
        path: created.path,
        name: created.name,
        content: ''
      })
      tabStore.openTab(buf.key)
      syncClient.trackCreatedBuffer(
        buf.key,
        wikiApi.buffer.openWorkspaceFile(created.path, created.name, '')
      )
    },
    [bufferStore, syncClient, tabStore, wikiApi]
  )

  const updateBufferContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      const resolvedKey = syncClient.beginLocalEdit(bufferKey)
      bufferStore.updateContent(resolvedKey, nextContent)

      void wikiApi.buffer
        .updateContent(resolvedKey, nextContent)
        .catch(() => undefined)
        .finally(() => {
          syncClient.finishLocalEdit(resolvedKey)
        })
    },
    [bufferStore, syncClient, wikiApi]
  )

  const forceCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const result = tabStore.closeTab(paneId, tabId)
      if (result?.isLastReferenceForBuffer) {
        const closedKey = result.closedTab.bufferKey
        syncClient.clearTrackingForKeys([closedKey])
        if ((syncClient.getHubTabCount(closedKey) ?? 0) === 0) {
          bufferStore.removeBuffer(closedKey)
        }
      }
      syncClient.syncCurrentLayoutTabs()
    },
    [bufferStore, syncClient, tabStore]
  )

  const requestCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const tab = tabStore.getTab(paneId, tabId)
      if (!tab) return
      const buffer = bufferStore.getBuffer(tab.bufferKey)
      const hasOtherTabAcrossWindows =
        tabStore.hasOtherTabForBuffer(tab.bufferKey, tab.id) ||
        (syncClient.getHubTabCount(tab.bufferKey) ?? 1) > 1
      if (buffer?.isDirty && !hasOtherTabAcrossWindows) {
        callbacksRef.current.onConfirmCloseDirtyTab({ paneId, tabId, buffer })
        return
      }
      forceCloseTab(paneId, tabId)
    },
    [bufferStore, forceCloseTab, syncClient, tabStore]
  )

  const saveAndCloseTab = useCallback(
    async (paneId: PaneId, tabId: string): Promise<boolean> => {
      const tab = tabStore.getTab(paneId, tabId)
      if (!tab) return true
      const ok = await ensureSavedBuffer(tab.bufferKey)
      if (!ok) return false
      forceCloseTab(paneId, tabId)
      return true
    },
    [ensureSavedBuffer, forceCloseTab, tabStore]
  )

  const clearWorkspaceBuffers = useCallback((): void => {
    const localWorkspaceKeys = extractLayoutBufferKeys(tabStore.getSnapshot()).filter((key) => {
      const buf = bufferStore.getBuffer(key)
      return buf?.kind === 'workspace'
    })
    if (localWorkspaceKeys.length === 0) return

    syncClient.clearTrackingForKeys(localWorkspaceKeys)
    tabStore.closeTabsByBufferKeys(localWorkspaceKeys)
    for (const key of localWorkspaceKeys) {
      if ((syncClient.getHubTabCount(key) ?? 0) === 0) {
        bufferStore.removeBuffer(key)
      }
    }
    syncClient.syncCurrentLayoutTabs()
  }, [bufferStore, syncClient, tabStore])

  const syncRenamedPath = useCallback(
    (oldPath: string, renamed: WorkspaceEntry): void => {
      const remappings = bufferStore.syncRenamedPath(oldPath, renamed.path)
      syncClient.applyKeyRemappings(remappings)
      void wikiApi.buffer.syncRenamedPath(oldPath, renamed.path).catch(() => undefined)
    },
    [bufferStore, syncClient, wikiApi]
  )

  const syncDeletedPath = useCallback(
    (deletedPath: string): void => {
      const removedKeys = bufferStore.removeBuffersUnderPath(deletedPath)
      syncClient.clearTrackingForKeys(removedKeys)
      if (removedKeys.length > 0) {
        tabStore.closeTabsByBufferKeys(removedKeys)
      }
      void wikiApi.buffer.syncDeletedPath(deletedPath).catch(() => undefined)
    },
    [bufferStore, syncClient, tabStore, wikiApi]
  )

  const reconcileWorkspaceBuffersWithDisk = useCallback(async (): Promise<readonly string[]> => {
    const result = await wikiApi.buffer.reconcileWorkspaceBuffersWithDisk()
    return result.warnings
  }, [wikiApi])

  return {
    buffers,
    layout,
    openWorkspaceFile,
    openConfigDocument,
    refreshCleanConfig,
    openCreatedFile,
    updateBufferContent,
    saveBufferByKey,
    saveActivePaneDocument,
    ensureAllWorkspaceBuffersSaved,
    getDirtyWorkspaceSummary,
    requestCloseTab,
    forceCloseTab,
    saveAndCloseTab,
    activateTab: tabStore.activateTab,
    focusPane: tabStore.focusPane,
    setSplitMode: tabStore.setSplitMode,
    setSplitRatio: tabStore.setSplitRatio,
    moveTab: tabStore.moveTab,
    splitWithTab: tabStore.splitWithTab,
    duplicateTabToOtherPane: tabStore.duplicateTabToOtherPane,
    updateTabViewState: tabStore.updateTabViewState,
    clearWorkspaceBuffers,
    syncRenamedPath,
    syncDeletedPath,
    reconcileWorkspaceBuffersWithDisk
  }
}
