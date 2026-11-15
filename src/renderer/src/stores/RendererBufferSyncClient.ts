import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { toErrorMessage } from '@shared/errors'
import type { WikiBufferApi } from '@shared/ipc'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import { type PaneId, type PaneLayoutState, PaneTabStore } from './PaneTabStore'

export interface DirtyTabClosePrompt {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
}

export function extractLayoutBufferKeys(layout: PaneLayoutState): string[] {
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

  private hubTabCounts: Record<string, number> = {}
  private localTabCounts: Record<string, number> = {}
  private inFlightTabSyncCount = 0
  private suppressLocalTabCountDelta = false
  private latestHubBuffers: DocumentBufferSnapshot = {}
  private readonly pendingLocalEditCounts = new Map<string, number>()
  private readonly creatingKeys = new Set<string>()
  private readonly pendingManualSaveKeys = new Set<string>()
  private readonly remappedKeys = new Map<string, string>()
  private lastSyncedTabSignature: string | null = null
  private mounted = false

  constructor(options: RendererBufferSyncClientOptions) {
    this.bufferStore = options.bufferStore
    this.tabStore = options.tabStore
    this.bufferApi = options.bufferApi
    this.onWorkspaceSaved = options.onWorkspaceSaved
    this.onError = options.onError
    this.onConfirmCloseDirtyTab = options.onConfirmCloseDirtyTab

    this.localTabCounts = countBufferKeys(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
    this.tabStore.subscribe(() => this.handleLocalTabStoreChange())
  }

  start(): () => void {
    this.mounted = true
    this.lastSyncedTabSignature = null
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
      void this.bufferApi.syncWindowTabs([]).catch(() => undefined)
    }
  }

  private handleLocalTabStoreChange(): void {
    const nextLocalCounts = countBufferKeys(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
    if (!this.suppressLocalTabCountDelta) {
      const prevLocalCounts = this.localTabCounts
      const nextHubCounts = { ...this.hubTabCounts }
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
      this.hubTabCounts = nextHubCounts
    }
    this.localTabCounts = nextLocalCounts
  }

  private runWithSuppressedTabDelta(fn: () => void): void {
    this.suppressLocalTabCountDelta = true
    try {
      fn()
    } finally {
      this.suppressLocalTabCountDelta = false
    }
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
      this.creatingKeys.delete(key)
      this.pendingManualSaveKeys.delete(key)
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
      if ((this.hubTabCounts[key] ?? 0) === 0) {
        this.bufferStore.removeBuffer(key)
      }
    }
    this.syncCurrentLayoutTabs()
  }

  private applyKeyRemappings(
    remappings: readonly BufferKeyRemap[],
    options: { suppressTabDelta?: boolean } = {}
  ): void {
    if (remappings.length === 0) return
    for (const { oldKey, newKey } of remappings) {
      if (oldKey === newKey) continue
      this.remappedKeys.set(oldKey, newKey)
      movePendingCount(this.pendingLocalEditCounts, oldKey, newKey)
      moveTrackedKey(this.creatingKeys, oldKey, newKey)
      moveTrackedKey(this.pendingManualSaveKeys, oldKey, newKey)
    }

    if (!options.suppressTabDelta) {
      this.tabStore.remapBufferKeys(remappings)
      return
    }

    if (this.inFlightTabSyncCount > 0) {
      const nextHubCounts = { ...this.hubTabCounts }
      for (const { oldKey, newKey } of remappings) {
        if (oldKey === newKey || !(oldKey in nextHubCounts)) continue
        nextHubCounts[newKey] = (nextHubCounts[newKey] ?? 0) + nextHubCounts[oldKey]
        delete nextHubCounts[oldKey]
      }
      this.hubTabCounts = nextHubCounts
    }
    this.runWithSuppressedTabDelta(() => {
      this.tabStore.remapBufferKeys(remappings)
    })
  }

  private applyHubSnapshot(snapshot: SharedBufferStateSnapshot): void {
    if (this.inFlightTabSyncCount === 0) {
      this.hubTabCounts = { ...snapshot.tabCounts }
    }
    this.latestHubBuffers = snapshot.buffers

    const currentLocal = this.bufferStore.getSnapshot()
    const merged: Record<string, DocumentBuffer> = {}

    for (const [key, hubBuf] of Object.entries(snapshot.buffers)) {
      this.remappedKeys.delete(key)
      const pendingCount = this.pendingLocalEditCounts.get(key) ?? 0
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

    for (const creatingKey of this.creatingKeys) {
      if (!merged[creatingKey] && currentLocal[creatingKey]) {
        merged[creatingKey] = currentLocal[creatingKey]
      }
    }

    this.bufferStore.replaceSnapshot(merged)
  }

  syncWindowTabs = (keys: string[]): void => {
    const signature = keys.join('\0')
    if (this.lastSyncedTabSignature === signature) {
      return
    }
    this.lastSyncedTabSignature = signature
    this.inFlightTabSyncCount += 1
    void this.bufferApi
      .syncWindowTabs(keys)
      .then((snapshot) => {
        this.inFlightTabSyncCount = Math.max(0, this.inFlightTabSyncCount - 1)
        if (this.mounted && this.inFlightTabSyncCount === 0) {
          this.applyHubSnapshot(snapshot)
        }
      })
      .catch(() => {
        this.inFlightTabSyncCount = Math.max(0, this.inFlightTabSyncCount - 1)
      })
  }

  private syncCurrentLayoutTabs(): void {
    this.syncWindowTabs(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
  }

  private handleHubEvent(event: SharedBufferHubEvent): void {
    if (!this.mounted) return

    switch (event.type) {
      case 'state-changed':
        this.applyHubSnapshot(event.snapshot)
        return
      case 'paths-remapped':
        this.applyKeyRemappings(event.remappings, { suppressTabDelta: true })
        this.applyHubSnapshot(event.snapshot)
        return
      case 'buffers-closed':
        this.clearTrackingForKeys(event.closedKeys)
        if (this.inFlightTabSyncCount > 0) {
          const nextHubCounts = { ...this.hubTabCounts }
          for (const closedKey of event.closedKeys) {
            delete nextHubCounts[closedKey]
          }
          this.hubTabCounts = nextHubCounts
        }
        this.runWithSuppressedTabDelta(() => {
          this.tabStore.closeTabsByBufferKeys(event.closedKeys)
        })
        this.applyHubSnapshot(event.snapshot)
        return
      case 'workspace-saved':
        this.onWorkspaceSaved?.()
        return
      case 'save-error': {
        const openKeys = extractLayoutBufferKeys(this.tabStore.getSnapshot())
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
      if (!this.mounted) return
      this.remappedKeys.delete(buf.key)
      if (!this.pendingLocalEditCounts.has(buf.key)) {
        this.bufferStore.upsertBuffer(buf)
      }
      this.tabStore.openTab(buf.key, { paneId: targetPaneId })
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
    const existingConfig = this.bufferStore
      .getAllBuffers()
      .find((buffer) => buffer.kind === 'config')
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
    void this.bufferApi
      .openWorkspaceFile(created.path, created.name, '')
      .catch(() => undefined)
      .finally(() => {
        this.creatingKeys.delete(buf.key)
      })
  }

  updateBufferContent = (bufferKey: string, nextContent: string): void => {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    this.pendingLocalEditCounts.set(
      resolvedKey,
      (this.pendingLocalEditCounts.get(resolvedKey) ?? 0) + 1
    )
    this.bufferStore.updateContent(resolvedKey, nextContent)

    void this.bufferApi
      .updateContent(resolvedKey, nextContent)
      .catch(() => undefined)
      .finally(() => {
        const finalKey = this.resolveLatestKey(resolvedKey)
        const remaining = (this.pendingLocalEditCounts.get(finalKey) ?? 1) - 1
        if (remaining > 0) {
          this.pendingLocalEditCounts.set(finalKey, remaining)
          return
        }
        this.pendingLocalEditCounts.delete(finalKey)
        if (!this.mounted) return
        const latestHubBuf = this.latestHubBuffers[finalKey]
        if (latestHubBuf) {
          this.bufferStore.upsertBuffer(latestHubBuf)
        }
      })
  }

  private async runSaveBufferRequest(key: string): Promise<boolean> {
    this.pendingManualSaveKeys.add(key)
    try {
      const result = await this.bufferApi.saveBuffer(key)
      return result.ok
    } catch (error: unknown) {
      if (this.mounted) {
        this.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
      }
      return false
    } finally {
      this.pendingManualSaveKeys.delete(key)
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

  private async ensureSavedBuffer(bufferKey: string): Promise<boolean> {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    const current = this.latestHubBuffers[resolvedKey] ?? this.bufferStore.getBuffer(resolvedKey)
    if (!current || (!current.isDirty && !current.isSaving)) {
      return true
    }

    return this.runSaveBufferRequest(resolvedKey)
  }

  ensureAllWorkspaceBuffersSaved = async (): Promise<boolean> => {
    const localKeys = new Set(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
    const targetKeys = new Set<string>()
    for (const key of localKeys) {
      const buf = this.latestHubBuffers[key] ?? this.bufferStore.getBuffer(key)
      if (buf && buf.kind === 'workspace' && (buf.isDirty || buf.isSaving)) {
        targetKeys.add(buf.key)
      }
    }

    for (const key of targetKeys) {
      if (!(await this.ensureSavedBuffer(key))) return false
    }
    return true
  }

  getDirtyWorkspaceSummary = (): string | null => {
    const localKeys = new Set(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
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
      (this.hubTabCounts[tab.bufferKey] ?? 1) > 1
    if (buffer?.isDirty && !hasOtherTabAcrossWindows) {
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
    const localWorkspaceKeys = extractLayoutBufferKeys(this.tabStore.getSnapshot()).filter(
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
