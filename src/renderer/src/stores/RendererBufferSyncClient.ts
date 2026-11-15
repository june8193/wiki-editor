import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { DocumentBufferStore, mergePendingLocalBuffer } from '@shared/documentBufferStore'
import { toErrorMessage } from '@shared/errors'
import type { WikiBufferApi } from '@shared/ipc'
import { countBufferKeys } from '@shared/windowTabTracker'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import { type PaneId, PaneTabStore } from './PaneTabStore'

export interface DirtyTabClosePrompt {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
}

function areStringArraysEqual(
  left: readonly string[] | null,
  right: readonly string[]
): boolean {
  if (!left || left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
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

function movePendingFlush(
  flushes: Map<string, Promise<void>>,
  oldKey: string,
  newKey: string
): void {
  const pending = flushes.get(oldKey)
  if (!pending) return
  flushes.delete(oldKey)
  const existing = flushes.get(newKey)
  if (!existing) {
    flushes.set(newKey, pending)
    return
  }
  let combined!: Promise<void>
  combined = Promise.all([existing, pending])
    .then(() => undefined)
    .finally(() => {
      if (flushes.get(newKey) === combined) {
        flushes.delete(newKey)
      }
    })
  flushes.set(newKey, combined)
}

export interface RendererBufferSyncClientOptions {
  bufferStore: DocumentBufferStore
  tabStore: PaneTabStore
  bufferApi: WikiBufferApi
  onWorkspaceSaved?: () => void
  onError: (message: string | null, error?: unknown) => void
  onConfirmCloseDirtyTab: (request: DirtyTabClosePrompt) => void
}

/**
 * Coordinates a renderer window's local DocumentBufferStore, PaneTabStore, and
 * main-process SharedDocumentBufferHub IPC lifecycle.
 */
export class RendererBufferSyncClient {
  private readonly bufferStore: DocumentBufferStore
  private readonly tabStore: PaneTabStore
  private readonly bufferApi: WikiBufferApi
  private onWorkspaceSaved?: () => void
  private onError: (message: string | null, error?: unknown) => void
  private onConfirmCloseDirtyTab: (request: DirtyTabClosePrompt) => void

  private windowId: number | null = null
  private latestHubRevision = -1
  private latestHubTabCounts: Record<string, number> = {}
  private latestHubWindowTabCounts:
    | Readonly<Record<number, Readonly<Record<string, number>>>>
    | undefined
  private localTabCounts: Record<string, number> = {}
  private effectiveTabCounts: Record<string, number> = {}
  private latestHubBuffers: DocumentBufferSnapshot = {}
  private readonly pendingLocalEditCounts = new Map<string, number>()
  private readonly pendingCreateFlushes = new Map<string, Promise<void>>()
  private readonly pendingEditFlushes = new Map<string, Promise<void>>()
  private readonly creatingKeys = new Set<string>()
  private readonly pendingManualSaveKeys = new Set<string>()
  private readonly unsyncedLocalKeys = new Set<string>()
  private readonly remappedKeys = new Map<string, string>()
  private lastSyncedTabKeys: readonly string[] | null = null
  private mounted = false

  constructor(options: RendererBufferSyncClientOptions) {
    this.bufferStore = options.bufferStore
    this.tabStore = options.tabStore
    this.bufferApi = options.bufferApi
    this.onWorkspaceSaved = options.onWorkspaceSaved
    this.onError = options.onError
    this.onConfirmCloseDirtyTab = options.onConfirmCloseDirtyTab

    this.localTabCounts = countBufferKeys(this.tabStore.getBufferKeys())
    this.recomputeEffectiveTabCounts()
    this.tabStore.subscribe(() => this.handleLocalTabStoreChange())
  }

  start(): () => void {
    this.mounted = true
    this.lastSyncedTabKeys = null
    const unsubscribeHub = this.bufferApi.onEvent((event) => this.handleHubEvent(event))

    void this.bufferApi.getSnapshot().then(
      (snapshot) => {
        if (this.mounted) {
          this.applyHubSnapshot(snapshot)
        }
      },
      () => undefined
    )

    return () => {
      this.mounted = false
      unsubscribeHub()
      void this.bufferApi.setAutoSavePaused(false).catch(() => undefined)
      void this.bufferApi.syncWindowTabs([], { releasePending: true }).catch(() => undefined)
    }
  }

  private recomputeEffectiveTabCounts(): void {
    if (this.windowId !== null && this.latestHubWindowTabCounts) {
      const syncedSelf = this.latestHubWindowTabCounts[this.windowId] ?? {}
      const nextCounts: Record<string, number> = {}
      const allKeys = new Set([
        ...Object.keys(this.latestHubTabCounts),
        ...Object.keys(syncedSelf),
        ...Object.keys(this.localTabCounts)
      ])
      for (const key of allKeys) {
        const otherCount = Math.max(
          0,
          (this.latestHubTabCounts[key] ?? 0) - (syncedSelf[key] ?? 0)
        )
        const total = otherCount + (this.localTabCounts[key] ?? 0)
        if (total > 0) {
          nextCounts[key] = total
        }
      }
      this.effectiveTabCounts = nextCounts
      return
    }

    const nextCounts: Record<string, number> = { ...this.latestHubTabCounts }
    for (const [key, localCount] of Object.entries(this.localTabCounts)) {
      nextCounts[key] = Math.max(localCount, nextCounts[key] ?? 0)
    }
    this.effectiveTabCounts = nextCounts
  }

  private handleLocalTabStoreChange(): void {
    this.localTabCounts = countBufferKeys(this.tabStore.getBufferKeys())
    this.recomputeEffectiveTabCounts()
  }

  private resolveLatestKey(initialKey: string): string {
    if (this.bufferStore.hasBuffer(initialKey)) {
      return initialKey
    }
    let cursor = initialKey
    const seen = new Set<string>()
    while (this.remappedKeys.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      cursor = this.remappedKeys.get(cursor)!
    }
    return cursor
  }

  private clearTrackingForKeys(keys: Iterable<string>): void {
    const keySet = keys instanceof Set ? keys : new Set(keys)
    if (keySet.size === 0) return

    for (const key of keySet) {
      this.pendingLocalEditCounts.delete(key)
      this.pendingCreateFlushes.delete(key)
      this.pendingEditFlushes.delete(key)
      this.creatingKeys.delete(key)
      this.pendingManualSaveKeys.delete(key)
      this.unsyncedLocalKeys.delete(key)
    }
    for (const [oldKey, newKey] of this.remappedKeys.entries()) {
      if (keySet.has(oldKey) || keySet.has(newKey)) {
        this.remappedKeys.delete(oldKey)
      }
    }
  }

  private cleanupClosedLocalBuffers(closedKeys: Iterable<string>): void {
    const keyList = [...closedKeys]
    this.clearTrackingForKeys(keyList)
    for (const key of keyList) {
      if ((this.localTabCounts[key] ?? 0) === 0) {
        this.bufferStore.removeBuffer(key)
      }
    }
    this.syncCurrentLayoutTabs()
  }

  private applyKeyRemappings(remappings: readonly BufferKeyRemap[]): void {
    if (remappings.length === 0) return
    for (const { oldKey, newKey } of remappings) {
      if (oldKey === newKey) continue
      this.remappedKeys.set(oldKey, newKey)
      movePendingCount(this.pendingLocalEditCounts, oldKey, newKey)
      movePendingFlush(this.pendingCreateFlushes, oldKey, newKey)
      movePendingFlush(this.pendingEditFlushes, oldKey, newKey)
      moveTrackedKey(this.creatingKeys, oldKey, newKey)
      moveTrackedKey(this.pendingManualSaveKeys, oldKey, newKey)
      moveTrackedKey(this.unsyncedLocalKeys, oldKey, newKey)
    }
    this.tabStore.remapBufferKeys(remappings)
  }

  private applyHubSnapshot(snapshot: SharedBufferStateSnapshot): void {
    if (snapshot.windowId !== undefined && this.windowId === null) {
      this.windowId = snapshot.windowId
    }
    if (snapshot.revision !== undefined) {
      if (snapshot.revision < this.latestHubRevision) {
        this.recomputeEffectiveTabCounts()
        return
      }
      this.latestHubRevision = snapshot.revision
    }
    this.latestHubTabCounts = { ...snapshot.tabCounts }
    this.latestHubWindowTabCounts = snapshot.windowTabCounts
    this.recomputeEffectiveTabCounts()
    this.latestHubBuffers = snapshot.buffers

    const currentLocal = this.bufferStore.getSnapshot()
    const merged: Record<string, DocumentBuffer> = {}

    for (const [key, hubBuf] of Object.entries(snapshot.buffers)) {
      this.remappedKeys.delete(key)
      if ((this.localTabCounts[key] ?? 0) === 0 && !this.creatingKeys.has(key)) {
        continue
      }
      const pendingCount = this.pendingLocalEditCounts.get(key) ?? 0
      const localBuf = currentLocal[key]
      const keepLocalEdits = (pendingCount > 0 || this.unsyncedLocalKeys.has(key)) && localBuf
      merged[key] = keepLocalEdits ? mergePendingLocalBuffer(hubBuf, localBuf) : hubBuf
    }

    for (const creatingKey of this.creatingKeys) {
      if (!merged[creatingKey] && currentLocal[creatingKey]) {
        merged[creatingKey] = currentLocal[creatingKey]
      }
    }

    this.bufferStore.replaceSnapshot(merged)
  }

  syncWindowTabs = (keys: string[]): void => {
    if (areStringArraysEqual(this.lastSyncedTabKeys, keys)) {
      return
    }
    this.lastSyncedTabKeys = [...keys]
    void this.bufferApi
      .syncWindowTabs(keys)
      .then((snapshot) => {
        if (this.mounted) {
          this.applyHubSnapshot(snapshot)
        }
      })
      .catch(() => undefined)
  }

  private syncCurrentLayoutTabs(): void {
    this.syncWindowTabs(this.tabStore.getBufferKeys())
  }

  private handleHubEvent(event: SharedBufferHubEvent): void {
    if (!this.mounted) return

    switch (event.type) {
      case 'state-changed':
        this.applyHubSnapshot(event.snapshot)
        return
      case 'paths-remapped':
        this.applyKeyRemappings(event.remappings)
        this.applyHubSnapshot(event.snapshot)
        return
      case 'buffers-closed':
        this.clearTrackingForKeys(event.closedKeys)
        this.tabStore.closeTabsByBufferKeys(event.closedKeys)
        this.applyHubSnapshot(event.snapshot)
        return
      case 'workspace-saved':
        this.onWorkspaceSaved?.()
        return
      case 'save-error': {
        const openKeys = this.tabStore.getBufferKeys()
        const hasTabInWindow = openKeys.includes(event.key)
        const initiatedByWindow = this.pendingManualSaveKeys.has(event.key)
        if (hasTabInWindow || initiatedByWindow) {
          this.onError(event.message, new Error(event.message))
        }
        return
      }
    }
  }

  private async openRemoteBuffer(
    loadBuffer: () => Promise<DocumentBuffer>,
    targetPaneId: PaneId | undefined,
    fallbackError: string
  ): Promise<void> {
    this.onError(null)
    try {
      const buf = await loadBuffer()
      if (!this.mounted) {
        void this.bufferApi.syncWindowTabs([], { releasePending: true }).catch(() => undefined)
        return
      }
      const targetKey = this.resolveLatestKey(buf.key)
      const latestBuf = this.latestHubBuffers[targetKey]
      if (targetKey !== buf.key && !latestBuf) {
        return
      }
      this.remappedKeys.delete(buf.key)
      this.remappedKeys.delete(targetKey)
      const targetBuf =
        latestBuf && (targetKey !== buf.key || latestBuf.version > buf.version) ? latestBuf : buf
      if (!this.pendingLocalEditCounts.has(targetKey) && !this.unsyncedLocalKeys.has(targetKey)) {
        this.bufferStore.upsertBuffer(targetBuf)
      }
      this.tabStore.openTab(targetKey, { paneId: targetPaneId })
      this.syncCurrentLayoutTabs()
    } catch (error: unknown) {
      if (this.mounted) {
        this.onError(toErrorMessage(error, fallbackError), error)
      }
    }
  }

  openWorkspaceFile = async (entry: WorkspaceEntry, targetPaneId?: PaneId): Promise<void> => {
    const key = getWorkspacePathKey(entry.path)
    this.remappedKeys.delete(key)
    if ((this.localTabCounts[key] ?? 0) > 0 && this.bufferStore.hasBuffer(key)) {
      this.tabStore.openTab(key, { paneId: targetPaneId })
      return
    }

    await this.openRemoteBuffer(
      () => this.bufferApi.openWorkspaceFile(entry.path, entry.name),
      targetPaneId,
      '파일을 열지 못했습니다.'
    )
  }

  openConfigDocument = async (targetPaneId?: PaneId): Promise<void> => {
    const existingConfig = this.bufferStore.getConfigBuffer()
    if (existingConfig && (this.localTabCounts[existingConfig.key] ?? 0) > 0) {
      this.tabStore.openTab(existingConfig.key, { paneId: targetPaneId })
      return
    }

    await this.openRemoteBuffer(
      () => this.bufferApi.openConfigDocument(),
      targetPaneId,
      '설정 파일을 읽지 못했습니다.'
    )
  }

  refreshCleanConfig = async (): Promise<void> => {
    try {
      await this.bufferApi.refreshCleanConfig()
    } catch {
      // Preserve primary error banners during background config refresh
    }
  }

  private deleteTrackedKeyVariants(set: Set<string>, initialKey: string): void {
    set.delete(initialKey)
    set.delete(this.resolveLatestKey(initialKey))
  }

  private trackPendingFlush(
    flushes: Map<string, Promise<void>>,
    initialKey: string,
    prevHubBuffers: DocumentBufferSnapshot,
    hadPriorFlush: boolean,
    syncedSynchronously: boolean,
    flushPromise: Promise<void>
  ): void {
    // Keep synchronous in-memory hub updates immediate while serializing real async IPC or deferred saves.
    if (!hadPriorFlush && this.latestHubBuffers !== prevHubBuffers && syncedSynchronously) {
      return
    }
    let tracked!: Promise<void>
    tracked = flushPromise.finally(() => {
      const finalKey = this.resolveLatestKey(initialKey)
      if (flushes.get(finalKey) === tracked) {
        flushes.delete(finalKey)
      }
      if (flushes.get(initialKey) === tracked) {
        flushes.delete(initialKey)
      }
    })
    flushes.set(initialKey, tracked)
  }

  private finalizeLocalEdit(initialKey: string, synced: boolean): void {
    const finalKey = this.resolveLatestKey(initialKey)
    const currentCount = this.pendingLocalEditCounts.get(finalKey)
    if (currentCount === undefined) return
    if (synced) {
      this.unsyncedLocalKeys.delete(finalKey)
    } else {
      this.unsyncedLocalKeys.add(finalKey)
    }
    if (currentCount > 1) {
      this.pendingLocalEditCounts.set(finalKey, currentCount - 1)
      return
    }
    this.pendingLocalEditCounts.delete(finalKey)
    if (!this.mounted || !synced) return
    if ((this.localTabCounts[finalKey] ?? 0) === 0 && !this.creatingKeys.has(finalKey)) {
      return
    }
    const latestHubBuf = this.latestHubBuffers[finalKey]
    if (latestHubBuf) {
      this.bufferStore.upsertBuffer(latestHubBuf)
    }
  }

  openCreatedFile = (created: WorkspaceEntry): void => {
    const key = getWorkspacePathKey(created.path)
    this.remappedKeys.delete(key)
    const buf = this.bufferStore.openBuffer({
      kind: 'workspace',
      path: created.path,
      name: created.name,
      content: ''
    })
    this.creatingKeys.add(buf.key)
    this.tabStore.openTab(buf.key)
    this.syncCurrentLayoutTabs()

    const prevHubBuffers = this.latestHubBuffers
    const previousCreate = this.pendingCreateFlushes.get(buf.key)
    const sendCreate = (): Promise<void> =>
      this.bufferApi
        .openWorkspaceFile(created.path, created.name, '')
        .then(
          () => {
            if (!this.mounted) {
              void this.bufferApi.syncWindowTabs([], { releasePending: true }).catch(() => undefined)
            }
          },
          () => undefined
        )
        .finally(() => {
          this.deleteTrackedKeyVariants(this.creatingKeys, buf.key)
        })

    const createPromise = previousCreate
      ? previousCreate.then(() => sendCreate())
      : sendCreate()
    this.trackPendingFlush(
      this.pendingCreateFlushes,
      buf.key,
      prevHubBuffers,
      previousCreate !== undefined,
      buf.key in this.latestHubBuffers,
      createPromise
    )
  }

  updateBufferContent = (bufferKey: string, nextContent: string): void => {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    this.pendingLocalEditCounts.set(
      resolvedKey,
      (this.pendingLocalEditCounts.get(resolvedKey) ?? 0) + 1
    )
    this.bufferStore.updateContent(resolvedKey, nextContent)

    const prevHubBuffers = this.latestHubBuffers
    const priorFlush =
      this.pendingEditFlushes.get(resolvedKey) ?? this.pendingCreateFlushes.get(resolvedKey)
    let synced = false
    const sendUpdate = async (targetKey: string): Promise<void> => {
      try {
        await this.bufferApi.updateContent(targetKey, nextContent)
        synced = true
      } catch (error: unknown) {
        if (this.mounted) {
          this.onError(toErrorMessage(error, '문서 변경 사항을 동기화하지 못했습니다.'), error)
        }
      }
    }

    const requestPromise = (
      priorFlush
        ? priorFlush.then(() => {
            const latestKey = this.resolveLatestKey(resolvedKey)
            if (!this.mounted || !this.pendingLocalEditCounts.has(latestKey)) {
              return undefined
            }
            return sendUpdate(latestKey)
          })
        : sendUpdate(resolvedKey)
    ).finally(() => this.finalizeLocalEdit(resolvedKey, synced))

    this.trackPendingFlush(
      this.pendingEditFlushes,
      resolvedKey,
      prevHubBuffers,
      priorFlush !== undefined,
      this.latestHubBuffers[resolvedKey]?.content === nextContent,
      requestPromise
    )
  }

  private async runSaveBufferRequest(key: string): Promise<boolean> {
    const initialKey = this.resolveLatestKey(key)
    this.pendingManualSaveKeys.add(initialKey)
    try {
      let currentKey = initialKey
      while (
        this.pendingCreateFlushes.has(currentKey) ||
        this.pendingEditFlushes.has(currentKey)
      ) {
        const pendingCreate = this.pendingCreateFlushes.get(currentKey)
        if (pendingCreate) {
          await pendingCreate
          currentKey = this.resolveLatestKey(currentKey)
          continue
        }
        await this.pendingEditFlushes.get(currentKey)
        currentKey = this.resolveLatestKey(currentKey)
      }
      const localBuf = this.bufferStore.getBuffer(currentKey)
      const hubBuf = this.latestHubBuffers[currentKey]
      if (
        localBuf &&
        (this.unsyncedLocalKeys.has(currentKey) || !hubBuf || localBuf.content !== hubBuf.content)
      ) {
        await this.bufferApi.updateContent(currentKey, localBuf.content)
        this.unsyncedLocalKeys.delete(currentKey)
      }
      const result = await this.bufferApi.saveBuffer(currentKey)
      return result.ok
    } catch (error: unknown) {
      if (this.mounted) {
        this.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
      }
      return false
    } finally {
      this.deleteTrackedKeyVariants(this.pendingManualSaveKeys, initialKey)
    }
  }

  saveBufferByKey = (bufferKey: string): void => {
    const current = this.bufferStore.getBuffer(bufferKey)
    if (!current || !current.isDirty || current.isSaving) {
      return
    }
    this.onError(null)
    void this.runSaveBufferRequest(current.key)
  }

  saveActivePaneDocument = (): void => {
    const activeTab = this.tabStore.getActiveTab()
    if (!activeTab) return
    this.saveBufferByKey(activeTab.bufferKey)
  }

  private needsBufferSave(key: string): boolean {
    const localBuf = this.bufferStore.getBuffer(key)
    const hubBuf = this.latestHubBuffers[key]
    return Boolean(
      localBuf?.isDirty ||
        localBuf?.isSaving ||
        hubBuf?.isDirty ||
        hubBuf?.isSaving ||
        (this.pendingLocalEditCounts.get(key) ?? 0) > 0 ||
        this.unsyncedLocalKeys.has(key) ||
        this.pendingCreateFlushes.has(key) ||
        this.pendingEditFlushes.has(key)
    )
  }

  private async ensureSavedBuffer(bufferKey: string): Promise<boolean> {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    if (!this.needsBufferSave(resolvedKey)) {
      return true
    }

    return this.runSaveBufferRequest(resolvedKey)
  }

  ensureAllWorkspaceBuffersSaved = async (): Promise<boolean> => {
    const localKeys = new Set(this.tabStore.getBufferKeys())
    const targetKeys = new Set<string>()
    for (const key of localKeys) {
      const resolvedKey = this.resolveLatestKey(key)
      const kind =
        this.bufferStore.getBuffer(resolvedKey)?.kind ?? this.latestHubBuffers[resolvedKey]?.kind
      if (kind === 'workspace' && this.needsBufferSave(resolvedKey)) {
        targetKeys.add(resolvedKey)
      }
    }

    for (const key of targetKeys) {
      if (!(await this.ensureSavedBuffer(key))) return false
    }
    return true
  }

  getDirtyWorkspaceSummary = (): string | null => {
    const localKeys = new Set(this.tabStore.getBufferKeys())
    const dirty = this.bufferStore
      .getDirtyBuffers('workspace')
      .filter((buf) => localKeys.has(buf.key))
    if (dirty.length === 0) return null
    if (dirty.length === 1) return dirty[0].name
    return `${dirty[0].name} 외 ${dirty.length - 1}개`
  }

  forceCloseTab = (paneId: PaneId, tabId: string): void => {
    const result = this.tabStore.closeTab(paneId, tabId)
    if (result?.isLastReferenceForBuffer) {
      this.cleanupClosedLocalBuffers([result.closedTab.bufferKey])
      return
    }
    this.syncCurrentLayoutTabs()
  }

  requestCloseTab = (paneId: PaneId, tabId: string): void => {
    const tab = this.tabStore.getTab(paneId, tabId)
    if (!tab) return
    const buffer = this.bufferStore.getBuffer(tab.bufferKey)
    const hasOtherTabAcrossWindows =
      this.tabStore.hasOtherTabForBuffer(tab.bufferKey, tab.id) ||
      (this.effectiveTabCounts[tab.bufferKey] ?? 1) > 1
    if (buffer?.isDirty && !hasOtherTabAcrossWindows) {
      void this.bufferApi.setAutoSavePaused(true).catch(() => undefined)
      this.onConfirmCloseDirtyTab({ paneId, tabId, buffer })
      return
    }
    this.forceCloseTab(paneId, tabId)
  }

  saveAndCloseTab = async (paneId: PaneId, tabId: string): Promise<boolean> => {
    const tab = this.tabStore.getTab(paneId, tabId)
    if (!tab) return true
    const ok = await this.ensureSavedBuffer(tab.bufferKey)
    if (!ok) return false
    this.forceCloseTab(paneId, tabId)
    return true
  }

  clearWorkspaceBuffers = (): void => {
    const localWorkspaceKeys = this.tabStore.getBufferKeys().filter(
      (key) => this.bufferStore.getBuffer(key)?.kind === 'workspace'
    )
    if (localWorkspaceKeys.length === 0) return

    this.tabStore.closeTabsByBufferKeys(localWorkspaceKeys)
    this.cleanupClosedLocalBuffers(localWorkspaceKeys)
  }

  syncRenamedPath = (oldPath: string, renamed: WorkspaceEntry): void => {
    const remappings = this.bufferStore.syncRenamedPath(oldPath, renamed.path)
    this.applyKeyRemappings(remappings)
    void this.bufferApi.syncRenamedPath(oldPath, renamed.path).catch(() => undefined)
  }

  syncDeletedPath = (deletedPath: string): void => {
    const removedKeys = this.bufferStore.removeBuffersUnderPath(deletedPath)
    this.clearTrackingForKeys(removedKeys)
    if (removedKeys.length > 0) {
      this.tabStore.closeTabsByBufferKeys(removedKeys)
    }
    void this.bufferApi.syncDeletedPath(deletedPath).catch(() => undefined)
  }

  reconcileWorkspaceBuffersWithDisk = async (): Promise<readonly string[]> => {
    const result = await this.bufferApi.reconcileWorkspaceBuffersWithDisk()
    return result.warnings
  }
}
