import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { getWorkspacePathKey, WorkspaceEntry } from '@shared/workspace'
import { isMarkdownDocument, resolveModeShortcut } from '../editor/editorModes'
import { DocumentBuffer, DocumentBufferStore } from '../stores/DocumentBufferStore'
import { PaneId, PaneTabStore } from '../stores/PaneTabStore'
import { toErrorMessage } from '../utils/toErrorMessage'

export interface DirtyTabCloseRequest {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
}

interface InFlightSaveEntry {
  currentKey: string
  promise: Promise<boolean>
}

interface UseEditorWorkspaceOptions {
  autoSave: boolean
  autoSaveDelayMs: number
  isAutoSavePaused: boolean
  onSaveConfigRaw: (rawContent: string) => Promise<unknown>
  onError: (message: string | null) => void
  onConfirmCloseDirtyTab: (request: DirtyTabCloseRequest) => void
}

/**
 * Coordinates the central DocumentBufferStore and 2-pane PaneTabStore with persistence and auto-save.
 */
export function useEditorWorkspace({
  autoSave,
  autoSaveDelayMs,
  isAutoSavePaused,
  onSaveConfigRaw,
  onError,
  onConfirmCloseDirtyTab
}: UseEditorWorkspaceOptions) {
  const bufferStoreRef = useRef<DocumentBufferStore | null>(null)
  if (!bufferStoreRef.current) {
    bufferStoreRef.current = new DocumentBufferStore()
  }
  const tabStoreRef = useRef<PaneTabStore | null>(null)
  if (!tabStoreRef.current) {
    tabStoreRef.current = new PaneTabStore()
  }

  const bufferStore = bufferStoreRef.current
  const tabStore = tabStoreRef.current

  const buffers = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const layout = useSyncExternalStore(tabStore.subscribe, tabStore.getSnapshot)

  const mountedRef = useRef<boolean>(true)
  const isAutoSavePausedRef = useRef<boolean>(isAutoSavePaused)
  const inFlightSavesRef = useRef<Map<string, InFlightSaveEntry>>(new Map())
  const autoSaveTimersRef = useRef<Map<string, { version: number; timerId: number }>>(new Map())
  const lastAutoSaveAttemptVersionRef = useRef<Map<string, number>>(new Map())
  const callbacksRef = useRef({ onSaveConfigRaw, onError, onConfirmCloseDirtyTab })

  isAutoSavePausedRef.current = isAutoSavePaused
  callbacksRef.current = { onSaveConfigRaw, onError, onConfirmCloseDirtyTab }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of autoSaveTimersRef.current.values()) {
        window.clearTimeout(entry.timerId)
      }
      autoSaveTimersRef.current.clear()
    }
  }, [])

  const saveBufferSnapshot = useCallback(
    (snapshot: DocumentBuffer): Promise<boolean> => {
      const existing = inFlightSavesRef.current.get(snapshot.key)
      if (existing) {
        return existing.promise
      }

      bufferStore.setSaving(snapshot.key, true)
      callbacksRef.current.onError(null)

      const entry: InFlightSaveEntry = {
        currentKey: snapshot.key,
        promise: Promise.resolve(false)
      }

      const run = (async (): Promise<boolean> => {
        try {
          if (snapshot.kind === 'config') {
            await callbacksRef.current.onSaveConfigRaw(snapshot.content)
          } else {
            await window.wikiApi.workspace.writeFile(snapshot.path, snapshot.content)
          }
          if (!mountedRef.current) return false
          bufferStore.markSaved(entry.currentKey, snapshot.content)
          return true
        } catch (error: unknown) {
          if (mountedRef.current) {
            callbacksRef.current.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'))
          }
          return false
        } finally {
          if (inFlightSavesRef.current.get(entry.currentKey) === entry) {
            inFlightSavesRef.current.delete(entry.currentKey)
          }
          if (mountedRef.current) {
            bufferStore.setSaving(entry.currentKey, false)
          }
        }
      })()

      entry.promise = run
      inFlightSavesRef.current.set(snapshot.key, entry)
      return run
    },
    [bufferStore]
  )

  const saveBufferByKey = useCallback(
    (bufferKey: string): void => {
      const current = bufferStore.getBuffer(bufferKey)
      if (!current || !current.isDirty || inFlightSavesRef.current.has(current.key)) {
        return
      }
      void saveBufferSnapshot({ ...current })
    },
    [bufferStore, saveBufferSnapshot]
  )

  const saveActivePaneDocument = useCallback((): void => {
    const activeTab = tabStore.getActiveTab()
    if (!activeTab) return
    saveBufferByKey(activeTab.bufferKey)
  }, [saveBufferByKey, tabStore])

  const ensureSavedBuffer = useCallback(
    async (bufferKey: string): Promise<boolean> => {
      const inFlight = inFlightSavesRef.current.get(bufferKey)
      if (inFlight) {
        const ok = await inFlight.promise
        if (!ok) return false
        bufferKey = inFlight.currentKey
      }
      const latest = bufferStore.getBuffer(bufferKey)
      if (!latest || !latest.isDirty) {
        return true
      }
      return saveBufferSnapshot({ ...latest })
    },
    [bufferStore, saveBufferSnapshot]
  )

  const ensureAllWorkspaceBuffersSaved = useCallback(async (): Promise<boolean> => {
    const targetKeys = new Set<string>()
    for (const buf of bufferStore.getDirtyBuffers('workspace')) {
      targetKeys.add(buf.key)
    }
    for (const key of inFlightSavesRef.current.keys()) {
      const buf = bufferStore.getBuffer(key)
      if (buf?.kind === 'workspace') {
        targetKeys.add(key)
      }
    }

    for (const key of targetKeys) {
      const ok = await ensureSavedBuffer(key)
      if (!ok) return false
    }
    return true
  }, [bufferStore, ensureSavedBuffer])

  const getDirtyWorkspaceSummary = useCallback((): string | null => {
    const dirty = bufferStore.getDirtyBuffers('workspace')
    if (dirty.length === 0) return null
    if (dirty.length === 1) return dirty[0].name
    return `${dirty[0].name} 외 ${dirty.length - 1}개`
  }, [bufferStore])

  // Global fallback Ctrl+S and mode-switch shortcut handler when focus is outside a specific pane editor
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isAutoSavePausedRef.current) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (!tabStore.getActiveTab()) return
        event.preventDefault()
        saveActivePaneDocument()
        return
      }

      const activeTab = tabStore.getActiveTab()
      if (!activeTab) return
      const activeBuffer = bufferStore.getBuffer(activeTab.bufferKey)
      if (!activeBuffer) return

      const nextMode = resolveModeShortcut(
        event,
        activeTab.mode,
        isMarkdownDocument(activeBuffer)
      )
      if (nextMode) {
        event.preventDefault()
        if (nextMode !== activeTab.mode) {
          tabStore.updateTabViewState(tabStore.getSnapshot().activePaneId, activeTab.id, {
            mode: nextMode
          })
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
    }
  }, [bufferStore, saveActivePaneDocument, tabStore])

  // Per-buffer debounced auto-save for dirty workspace files
  useEffect(() => {
    const timers = autoSaveTimersRef.current

    if (!autoSave || isAutoSavePaused) {
      for (const entry of timers.values()) {
        window.clearTimeout(entry.timerId)
      }
      timers.clear()
      return
    }

    for (const [key, entry] of timers.entries()) {
      const buf = buffers[key]
      if (
        !buf ||
        buf.kind !== 'workspace' ||
        !buf.isDirty ||
        buf.isSaving ||
        buf.version !== entry.version
      ) {
        window.clearTimeout(entry.timerId)
        timers.delete(key)
      }
    }

    for (const attemptedKey of lastAutoSaveAttemptVersionRef.current.keys()) {
      const buf = buffers[attemptedKey]
      if (!buf || !buf.isDirty) {
        lastAutoSaveAttemptVersionRef.current.delete(attemptedKey)
      }
    }

    for (const buf of Object.values(buffers)) {
      if (buf.kind !== 'workspace' || !buf.isDirty || buf.isSaving) continue
      if (lastAutoSaveAttemptVersionRef.current.get(buf.key) === buf.version) continue
      if (timers.has(buf.key)) continue

      const scheduledVersion = buf.version
      const timerId = window.setTimeout(() => {
        timers.delete(buf.key)
        if (isAutoSavePausedRef.current) return
        const latest = bufferStore.getBuffer(buf.key)
        if (!latest || latest.kind !== 'workspace' || !latest.isDirty || latest.isSaving) return
        if (latest.version !== scheduledVersion) return
        lastAutoSaveAttemptVersionRef.current.set(latest.key, scheduledVersion)
        void saveBufferSnapshot({ ...latest })
      }, autoSaveDelayMs)

      timers.set(buf.key, { version: scheduledVersion, timerId })
    }
  }, [autoSave, autoSaveDelayMs, isAutoSavePaused, buffers, bufferStore, saveBufferSnapshot])

  const openWorkspaceFile = useCallback(
    async (entry: WorkspaceEntry, targetPaneId?: PaneId): Promise<void> => {
      const key = getWorkspacePathKey(entry.path)
      if (bufferStore.hasBuffer(key)) {
        tabStore.openTab(key, { paneId: targetPaneId })
        return
      }

      callbacksRef.current.onError(null)
      try {
        const content = await window.wikiApi.workspace.readFile(entry.path)
        if (!mountedRef.current) return
        const buf = bufferStore.openBuffer({
          kind: 'workspace',
          path: entry.path,
          name: entry.name,
          content
        })
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '파일을 열지 못했습니다.'))
        }
      }
    },
    [bufferStore, tabStore]
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
        const [resolvedPath, raw] = await Promise.all([
          window.wikiApi.config.getConfigPath(),
          window.wikiApi.config.readRaw()
        ])
        if (!mountedRef.current) return
        const buf = bufferStore.openBuffer({
          kind: 'config',
          path: resolvedPath,
          name: 'config.json',
          content: raw
        })
        tabStore.openTab(buf.key, { paneId: targetPaneId })
      } catch (error: unknown) {
        if (mountedRef.current) {
          callbacksRef.current.onError(toErrorMessage(error, '설정 파일을 읽지 못했습니다.'))
        }
      }
    },
    [bufferStore, tabStore]
  )

  const refreshCleanConfig = useCallback(async (): Promise<void> => {
    const configBuffer = bufferStore
      .getAllBuffers()
      .find((buffer) => buffer.kind === 'config')
    if (!configBuffer || configBuffer.isDirty) return

    try {
      const raw = await window.wikiApi.config.readRaw()
      if (!mountedRef.current) return
      bufferStore.refreshCleanContent(configBuffer.key, raw)
    } catch {
      // Preserve primary error banners during background config refresh
    }
  }, [bufferStore])

  const openCreatedFile = useCallback(
    (created: WorkspaceEntry): void => {
      const buf = bufferStore.openBuffer({
        kind: 'workspace',
        path: created.path,
        name: created.name,
        content: ''
      })
      tabStore.openTab(buf.key)
    },
    [bufferStore, tabStore]
  )

  const updateBufferContent = useCallback(
    (bufferKey: string, nextContent: string): void => {
      bufferStore.updateContent(bufferKey, nextContent)
    },
    [bufferStore]
  )

  const clearAutoSaveTimer = useCallback((key: string): void => {
    const timer = autoSaveTimersRef.current.get(key)
    if (timer) {
      window.clearTimeout(timer.timerId)
      autoSaveTimersRef.current.delete(key)
    }
  }, [])

  const cleanupBufferTracking = useCallback(
    (keys: Iterable<string>): void => {
      for (const key of keys) {
        clearAutoSaveTimer(key)
        lastAutoSaveAttemptVersionRef.current.delete(key)
      }
    },
    [clearAutoSaveTimer]
  )

  const forceCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const result = tabStore.closeTab(paneId, tabId)
      if (result?.isLastReferenceForBuffer) {
        cleanupBufferTracking([result.closedTab.bufferKey])
        bufferStore.removeBuffer(result.closedTab.bufferKey)
      }
    },
    [bufferStore, cleanupBufferTracking, tabStore]
  )

  const requestCloseTab = useCallback(
    (paneId: PaneId, tabId: string): void => {
      const tab = tabStore.getTab(paneId, tabId)
      if (!tab) return
      const buffer = bufferStore.getBuffer(tab.bufferKey)
      if (buffer?.isDirty && !tabStore.hasOtherTabForBuffer(tab.bufferKey, tab.id)) {
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
    const removedKeys = bufferStore.clearWorkspaceBuffers()
    cleanupBufferTracking(removedKeys)
    tabStore.closeTabsByBufferKeys(removedKeys)
  }, [bufferStore, cleanupBufferTracking, tabStore])

  const syncRenamedPath = useCallback(
    (oldPath: string, renamed: WorkspaceEntry): void => {
      const remappings = bufferStore.syncRenamedPath(oldPath, renamed.path)
      if (remappings.length === 0) return

      for (const { oldKey, newKey } of remappings) {
        clearAutoSaveTimer(oldKey)
        const attemptedVersion = lastAutoSaveAttemptVersionRef.current.get(oldKey)
        if (attemptedVersion !== undefined) {
          lastAutoSaveAttemptVersionRef.current.delete(oldKey)
          lastAutoSaveAttemptVersionRef.current.set(newKey, attemptedVersion)
        }
        const inFlight = inFlightSavesRef.current.get(oldKey)
        if (inFlight) {
          inFlightSavesRef.current.delete(oldKey)
          inFlight.currentKey = newKey
          inFlightSavesRef.current.set(newKey, inFlight)
        }
      }
      tabStore.remapBufferKeys(remappings)
    },
    [bufferStore, clearAutoSaveTimer, tabStore]
  )

  const syncDeletedPath = useCallback(
    (deletedPath: string): void => {
      const removedKeys = bufferStore.removeBuffersUnderPath(deletedPath)
      cleanupBufferTracking(removedKeys)
      tabStore.closeTabsByBufferKeys(removedKeys)
    },
    [bufferStore, cleanupBufferTracking, tabStore]
  )

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
    duplicateTabToOtherPane: tabStore.duplicateTabToOtherPane,
    updateTabViewState: tabStore.updateTabViewState,
    clearWorkspaceBuffers,
    syncRenamedPath,
    syncDeletedPath
  }
}
