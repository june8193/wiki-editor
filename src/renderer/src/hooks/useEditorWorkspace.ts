import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { toErrorMessage } from '@shared/errors'
import { getWorkspacePathKey, WorkspaceEntry } from '@shared/workspace'
import { isMarkdownDocument, resolveEditorShortcut } from '../editor/editorModes'
import { logRendererInfo } from '../logging/rendererLogger'
import { DocumentBufferStore } from '../stores/DocumentBufferStore'
import {
  type PaneId,
  type PaneLayoutState,
  PaneTabStore,
  type PaneTabTransition
} from '../stores/PaneTabStore'
import { useWikiApi } from './useWikiApi'

export interface DirtyTabCloseRequest {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
}

function extractLayoutBufferKeys(layout: PaneLayoutState): string[] {
  const keys: string[] = []
  for (const paneId of ['primary', 'secondary'] as const) {
    const pane = layout.panes[paneId]
    if (!pane) continue
    for (const tab of pane.tabs) {
      keys.push(tab.bufferKey)
    }
  }
  return keys
}

function countBufferKeys(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const key of keys) {
    if (!key) continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function movePendingCount(
  counts: Map<string, number>,
  oldKey: string,
  newKey: string
): void {
  const count = counts.get(oldKey)
  if (count === undefined) return
  counts.delete(oldKey)
  counts.set(newKey, (counts.get(newKey) ?? 0) + count)
}

function moveTrackedKey(set: Set<string>, oldKey: string, newKey: string): void {
  if (set.delete(oldKey)) {
    set.add(newKey)
  }
}

function clearRemappingsTouchingKeys(
  remappings: Map<string, string>,
  keys: Iterable<string>
): void {
  const keySet = keys instanceof Set ? keys : new Set(keys)
  if (keySet.size === 0 || remappings.size === 0) return
  for (const [oldKey, newKey] of remappings.entries()) {
    if (keySet.has(oldKey) || keySet.has(newKey)) {
      remappings.delete(oldKey)
    }
  }
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
 * Coordinates the window's 2-pane PaneTabStore with the central SharedDocumentBufferHub via IPC.
 */
export function useEditorWorkspace({
  isAutoSavePaused,
  isShortcutDisabled = isAutoSavePaused,
  onWorkspaceSaved,
  onError,
  onConfirmCloseDirtyTab
}: UseEditorWorkspaceOptions) {
  const wikiApi = useWikiApi()
  const mountedRef = useRef<boolean>(true)
  const isShortcutDisabledRef = useRef<boolean>(isShortcutDisabled)
  const hubTabCountsRef = useRef<Record<string, number>>({})
  const localTabCountsRef = useRef<Record<string, number>>({})
  const inFlightTabSyncCountRef = useRef<number>(0)
  const suppressLocalTabCountDeltaRef = useRef<boolean>(false)
  const latestHubBuffersRef = useRef<DocumentBufferSnapshot>({})
  const pendingLocalEditCountsRef = useRef<Map<string, number>>(new Map())
  const creatingKeysRef = useRef<Set<string>>(new Set())
  const pendingManualSaveKeysRef = useRef<Set<string>>(new Set())
  const remappedKeysRef = useRef<Map<string, string>>(new Map())
  const lastSyncedTabSignatureRef = useRef<string | null>(null)
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

  const bufferStoreRef = useRef<DocumentBufferStore | null>(null)
  if (!bufferStoreRef.current) {
    bufferStoreRef.current = new DocumentBufferStore()
  }
  const bufferStore = bufferStoreRef.current

  const tabStoreRef = useRef<PaneTabStore | null>(null)
  if (!tabStoreRef.current) {
    const store = new PaneTabStore({
      onTransition: (transition) => logPaneTabTransition(bufferStore, transition)
    })
    // Maintain synchronous optimistic tab counts across rapid local open/split/close edits
    // until in-flight syncWindowTabs roundtrips confirm authoritative counts from the hub.
    store.subscribe(() => {
      const nextLocalCounts = countBufferKeys(extractLayoutBufferKeys(store.getSnapshot()))
      if (!suppressLocalTabCountDeltaRef.current) {
        const prevLocalCounts = localTabCountsRef.current
        const nextHubCounts = { ...hubTabCountsRef.current }
        const touchedKeys = new Set([
          ...Object.keys(prevLocalCounts),
          ...Object.keys(nextLocalCounts)
        ])
        for (const key of touchedKeys) {
          const delta = (nextLocalCounts[key] ?? 0) - (prevLocalCounts[key] ?? 0)
          if (delta === 0) continue
          const updated = Math.max(0, (nextHubCounts[key] ?? 0) + delta)
          if (updated === 0) {
            delete nextHubCounts[key]
          } else {
            nextHubCounts[key] = updated
          }
        }
        hubTabCountsRef.current = nextHubCounts
      }
      localTabCountsRef.current = nextLocalCounts
    })
    tabStoreRef.current = store
  }
  const tabStore = tabStoreRef.current

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)

  const runWithSuppressedTabDelta = useCallback((fn: () => void): void => {
    suppressLocalTabCountDeltaRef.current = true
    try {
      fn()
    } finally {
      suppressLocalTabCountDeltaRef.current = false
    }
  }, [])

  const resolveLatestBufferKey = useCallback(
    (initialKey: string): string => {
      if (bufferStore.hasBuffer(initialKey)) {
        return initialKey
      }
      let cursor = initialKey
      const seen = new Set<string>()
      while (remappedKeysRef.current.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor)
        cursor = remappedKeysRef.current.get(cursor)!
      }
      return cursor
    },
    [bufferStore]
  )

  const applyKeyRemappings = useCallback(
    (
      remappings: readonly BufferKeyRemap[],
      options: { suppressTabDelta?: boolean } = {}
    ): void => {
      if (remappings.length === 0) return
      for (const { oldKey, newKey } of remappings) {
        if (oldKey === newKey) continue
        remappedKeysRef.current.set(oldKey, newKey)
        movePendingCount(pendingLocalEditCountsRef.current, oldKey, newKey)
        moveTrackedKey(creatingKeysRef.current, oldKey, newKey)
        moveTrackedKey(pendingManualSaveKeysRef.current, oldKey, newKey)
      }
      if (options.suppressTabDelta) {
        if (inFlightTabSyncCountRef.current > 0) {
          const nextHubCounts = { ...hubTabCountsRef.current }
          for (const { oldKey, newKey } of remappings) {
            if (oldKey === newKey || !(oldKey in nextHubCounts)) continue
            nextHubCounts[newKey] = (nextHubCounts[newKey] ?? 0) + nextHubCounts[oldKey]
            delete nextHubCounts[oldKey]
          }
          hubTabCountsRef.current = nextHubCounts
        }
        runWithSuppressedTabDelta(() => {
          tabStore.remapBufferKeys(remappings)
        })
      } else {
        tabStore.remapBufferKeys(remappings)
      }
    },
    [runWithSuppressedTabDelta, tabStore]
  )

  const applyHubSnapshot = useCallback(
    (snapshot: SharedBufferStateSnapshot): void => {
      if (inFlightTabSyncCountRef.current === 0) {
        hubTabCountsRef.current = { ...snapshot.tabCounts }
      }
      latestHubBuffersRef.current = snapshot.buffers

      const currentLocal = bufferStore.getSnapshot()
      const merged: Record<string, DocumentBuffer> = {}

      for (const [key, hubBuf] of Object.entries(snapshot.buffers)) {
        remappedKeysRef.current.delete(key)
        const pendingCount = pendingLocalEditCountsRef.current.get(key) ?? 0
        const localBuf = currentLocal[key]
        if (pendingCount > 0 && localBuf) {
          merged[key] = {
            ...hubBuf,
            content: localBuf.content,
            isDirty: localBuf.content !== hubBuf.savedContent,
            version: Math.max(localBuf.version, hubBuf.version)
          }
        } else {
          merged[key] = hubBuf
        }
      }

      for (const creatingKey of creatingKeysRef.current) {
        if (!merged[creatingKey] && currentLocal[creatingKey]) {
          merged[creatingKey] = currentLocal[creatingKey]
        }
      }

      bufferStore.replaceSnapshot(merged)
    },
    [bufferStore]
  )

  const pushWindowTabs = useCallback(
    (keys: string[]): void => {
      const signature = keys.join('\0')
      if (lastSyncedTabSignatureRef.current === signature) {
        return
      }
      lastSyncedTabSignatureRef.current = signature
      inFlightTabSyncCountRef.current += 1
      void wikiApi.buffer
        .syncWindowTabs(keys)
        .then((snapshot) => {
          inFlightTabSyncCountRef.current = Math.max(0, inFlightTabSyncCountRef.current - 1)
          if (mountedRef.current && inFlightTabSyncCountRef.current === 0) {
            applyHubSnapshot(snapshot)
          }
        })
        .catch(() => {
          inFlightTabSyncCountRef.current = Math.max(0, inFlightTabSyncCountRef.current - 1)
        })
    },
    [applyHubSnapshot, wikiApi]
  )

  useEffect(() => {
    mountedRef.current = true
    const bufferApi = wikiApi.buffer

    const handleHubEvent = (event: SharedBufferHubEvent): void => {
      if (!mountedRef.current) return

      switch (event.type) {
        case 'state-changed':
          applyHubSnapshot(event.snapshot)
          return
        case 'paths-remapped':
          applyKeyRemappings(event.remappings, { suppressTabDelta: true })
          applyHubSnapshot(event.snapshot)
          return
        case 'buffers-closed':
          clearRemappingsTouchingKeys(remappedKeysRef.current, event.closedKeys)
          for (const closedKey of event.closedKeys) {
            pendingLocalEditCountsRef.current.delete(closedKey)
            creatingKeysRef.current.delete(closedKey)
            pendingManualSaveKeysRef.current.delete(closedKey)
          }
          if (inFlightTabSyncCountRef.current > 0) {
            const nextHubCounts = { ...hubTabCountsRef.current }
            for (const closedKey of event.closedKeys) {
              delete nextHubCounts[closedKey]
            }
            hubTabCountsRef.current = nextHubCounts
          }
          runWithSuppressedTabDelta(() => {
            tabStore.closeTabsByBufferKeys(event.closedKeys)
          })
          applyHubSnapshot(event.snapshot)
          return
        case 'workspace-saved':
          callbacksRef.current.onWorkspaceSaved?.()
          return
        case 'save-error': {
          const openKeys = extractLayoutBufferKeys(tabStore.getSnapshot())
          const hasTabInWindow = openKeys.includes(event.key)
          const initiatedByWindow = pendingManualSaveKeysRef.current.has(event.key)
          if (hasTabInWindow || initiatedByWindow) {
            callbacksRef.current.onError(event.message, new Error(event.message))
          }
          return
        }
      }
    }

    const unsubscribe = bufferApi.onEvent(handleHubEvent)

    void bufferApi.getSnapshot().then(
      (snapshot) => {
        if (mountedRef.current) {
          applyHubSnapshot(snapshot)
        }
      },
      () => undefined
    )

    return () => {
      mountedRef.current = false
      unsubscribe()
      void bufferApi.setAutoSavePaused(false).catch(() => undefined)
      void bufferApi.syncWindowTabs([]).catch(() => undefined)
    }
  }, [applyHubSnapshot, applyKeyRemappings, runWithSuppressedTabDelta, tabStore, wikiApi])

  useEffect(() => {
    void wikiApi.buffer.setAutoSavePaused(isAutoSavePaused).catch(() => undefined)
  }, [isAutoSavePaused, wikiApi])

  useEffect(() => {
    pushWindowTabs(extractLayoutBufferKeys(layout))
  }, [layout, pushWindowTabs])

  const syncTabsNow = useCallback((): void => {
    pushWindowTabs(extractLayoutBufferKeys(tabStore.getSnapshot()))
  }, [pushWindowTabs, tabStore])

  const saveBufferByKey = useCallback(
    (bufferKey: string): void => {
      const current = bufferStore.getBuffer(bufferKey)
      if (!current || !current.isDirty || current.isSaving) {
        return
      }
      callbacksRef.current.onError(null)
      pendingManualSaveKeysRef.current.add(current.key)
      void wikiApi.buffer
        .saveBuffer(current.key)
        .catch((error: unknown) => {
          if (mountedRef.current) {
            callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
          }
        })
        .finally(() => {
          pendingManualSaveKeysRef.current.delete(current.key)
        })
    },
    [bufferStore, wikiApi]
  )

  const saveActivePaneDocument = useCallback((): void => {
    const activeTab = tabStore.getActiveTab()
    if (!activeTab) return
    saveBufferByKey(activeTab.bufferKey)
  }, [saveBufferByKey, tabStore])

  const ensureSavedBuffer = useCallback(
    async (bufferKey: string): Promise<boolean> => {
      const resolvedKey = resolveLatestBufferKey(bufferKey)
      const current = latestHubBuffersRef.current[resolvedKey] ?? bufferStore.getBuffer(resolvedKey)
      if (!current) {
        return true
      }
      if (!current.isDirty && !current.isSaving) {
        return true
      }

      pendingManualSaveKeysRef.current.add(resolvedKey)
      try {
        const result = await wikiApi.buffer.saveBuffer(resolvedKey)
        return result.ok
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
        }
        return false
      } finally {
        pendingManualSaveKeysRef.current.delete(resolvedKey)
      }
    },
    [bufferStore, resolveLatestBufferKey, wikiApi]
  )

  const ensureAllWorkspaceBuffersSaved = useCallback(async (): Promise<boolean> => {
    const localKeys = new Set(extractLayoutBufferKeys(tabStore.getSnapshot()))
    const targetKeys = new Set<string>()
    for (const key of localKeys) {
      const buf = latestHubBuffersRef.current[key] ?? bufferStore.getBuffer(key)
      if (buf && buf.kind === 'workspace' && (buf.isDirty || buf.isSaving)) {
        targetKeys.add(buf.key)
      }
    }

    for (const key of targetKeys) {
      const ok = await ensureSavedBuffer(key)
      if (!ok) return false
    }
    return true
  }, [bufferStore, ensureSavedBuffer, tabStore])

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
      remappedKeysRef.current.delete(key)
      if (bufferStore.hasBuffer(key)) {
        tabStore.openTab(key, { paneId: targetPaneId })
        return
      }

      callbacksRef.current.onError(null)
      try {
        const buf = await wikiApi.buffer.openWorkspaceFile(entry.path, entry.name)
        if (!mountedRef.current) return
        remappedKeysRef.current.delete(buf.key)
        if (!bufferStore.hasBuffer(buf.key)) {
          bufferStore.upsertBuffer(buf)
        }
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '파일을 열지 못했습니다.'), error)
        }
      }
    },
    [bufferStore, tabStore, wikiApi]
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
        if (!mountedRef.current) return
        if (!bufferStore.hasBuffer(buf.key)) {
          bufferStore.upsertBuffer(buf)
        }
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(
            toErrorMessage(error, '설정 파일을 읽지 못했습니다.'),
            error
          )
        }
      }
    },
    [bufferStore, tabStore, wikiApi]
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
      remappedKeysRef.current.delete(key)
      const buf = bufferStore.openBuffer({
        kind: 'workspace',
        path: created.path,
        name: created.name,
        content: ''
      })
      creatingKeysRef.current.add(buf.key)
      tabStore.openTab(buf.key)
      void wikiApi.buffer
        .openWorkspaceFile(created.path, created.name, '')
        .catch(() => undefined)
        .finally(() => {
          creatingKeysRef.current.delete(buf.key)
        })
    },
    [bufferStore, tabStore, wikiApi]
  )

  const updateBufferContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      const resolvedKey = resolveLatestBufferKey(bufferKey)
      const currentCount = pendingLocalEditCountsRef.current.get(resolvedKey) ?? 0
      pendingLocalEditCountsRef.current.set(resolvedKey, currentCount + 1)
      bufferStore.updateContent(resolvedKey, nextContent)

      void wikiApi.buffer
        .updateContent(resolvedKey, nextContent)
        .catch(() => undefined)
        .finally(() => {
          const finalKey = resolveLatestBufferKey(resolvedKey)
          const pending = (pendingLocalEditCountsRef.current.get(finalKey) ?? 1) - 1
          if (pending > 0) {
            pendingLocalEditCountsRef.current.set(finalKey, pending)
            return
          }
          pendingLocalEditCountsRef.current.delete(finalKey)
          if (!mountedRef.current) return
          const latestHubBuf = latestHubBuffersRef.current[finalKey]
          if (latestHubBuf) {
            bufferStore.upsertBuffer(latestHubBuf)
          }
        })
    },
    [bufferStore, resolveLatestBufferKey, wikiApi]
  )

  const forceCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const result = tabStore.closeTab(paneId, tabId)
      if (result?.isLastReferenceForBuffer) {
        const closedKey = result.closedTab.bufferKey
        clearRemappingsTouchingKeys(remappedKeysRef.current, [closedKey])
        if ((hubTabCountsRef.current[closedKey] ?? 0) === 0) {
          pendingLocalEditCountsRef.current.delete(closedKey)
          bufferStore.removeBuffer(closedKey)
        }
      }
      syncTabsNow()
    },
    [bufferStore, syncTabsNow, tabStore]
  )

  const requestCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const tab = tabStore.getTab(paneId, tabId)
      if (!tab) return
      const buffer = bufferStore.getBuffer(tab.bufferKey)
      const hasOtherTabAcrossWindows =
        tabStore.hasOtherTabForBuffer(tab.bufferKey, tab.id) ||
        (hubTabCountsRef.current[tab.bufferKey] ?? 1) > 1
      if (buffer?.isDirty && !hasOtherTabAcrossWindows) {
        callbacksRef.current.onConfirmCloseDirtyTab({ paneId, tabId, buffer })
        return
      }
      forceCloseTab(paneId, tabId)
    },
    [bufferStore, forceCloseTab, tabStore]
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

    clearRemappingsTouchingKeys(remappedKeysRef.current, localWorkspaceKeys)
    tabStore.closeTabsByBufferKeys(localWorkspaceKeys)
    for (const key of localWorkspaceKeys) {
      if ((hubTabCountsRef.current[key] ?? 0) === 0) {
        pendingLocalEditCountsRef.current.delete(key)
        creatingKeysRef.current.delete(key)
        bufferStore.removeBuffer(key)
      }
    }
    syncTabsNow()
  }, [bufferStore, syncTabsNow, tabStore])

  const syncRenamedPath = useCallback(
    (oldPath: string, renamed: WorkspaceEntry): void => {
      const remappings = bufferStore.syncRenamedPath(oldPath, renamed.path)
      applyKeyRemappings(remappings)
      void wikiApi.buffer.syncRenamedPath(oldPath, renamed.path).catch(() => undefined)
    },
    [applyKeyRemappings, bufferStore, wikiApi]
  )

  const syncDeletedPath = useCallback(
    (deletedPath: string): void => {
      const removedKeys = bufferStore.removeBuffersUnderPath(deletedPath)
      clearRemappingsTouchingKeys(remappedKeysRef.current, removedKeys)
      for (const key of removedKeys) {
        pendingLocalEditCountsRef.current.delete(key)
        creatingKeysRef.current.delete(key)
        pendingManualSaveKeysRef.current.delete(key)
      }
      if (removedKeys.length > 0) {
        tabStore.closeTabsByBufferKeys(removedKeys)
      }
      void wikiApi.buffer.syncDeletedPath(deletedPath).catch(() => undefined)
    },
    [bufferStore, tabStore, wikiApi]
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
