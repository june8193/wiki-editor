import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import type { WikiBufferApi } from '@shared/ipc'
import { type PaneLayoutState, PaneTabStore } from './PaneTabStore'

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
  onSaveError: (message: string, error: Error) => void
}

/**
 * Synchronizes a window's local DocumentBufferStore and PaneTabStore with the main-process
 * SharedDocumentBufferHub while preserving optimistic local edits and synchronous tab counts.
 */
export class RendererBufferSyncClient {
  private readonly bufferStore: DocumentBufferStore
  private readonly tabStore: PaneTabStore
  private readonly bufferApi: WikiBufferApi
  private onWorkspaceSaved?: () => void
  private onSaveError: (message: string, error: Error) => void

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
    this.onSaveError = options.onSaveError

    this.localTabCounts = countBufferKeys(extractLayoutBufferKeys(this.tabStore.getSnapshot()))
    this.tabStore.subscribe(() => this.handleLocalTabStoreChange())
  }

  updateCallbacks(callbacks: {
    onWorkspaceSaved?: () => void
    onSaveError: (message: string, error: Error) => void
  }): void {
    this.onWorkspaceSaved = callbacks.onWorkspaceSaved
    this.onSaveError = callbacks.onSaveError
  }

  start(): () => void {
    this.mounted = true
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

  isMounted(): boolean {
    return this.mounted
  }

  getHubTabCount(key: string): number | undefined {
    return this.hubTabCounts[key]
  }

  getHubBufferOrLocal(key: string): DocumentBuffer | undefined {
    return this.latestHubBuffers[key] ?? this.bufferStore.getBuffer(key)
  }

  resolveLatestKey(initialKey: string): string {
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

  prepareKeyOpen(key: string): void {
    this.remappedKeys.delete(key)
  }

  trackCreatedBuffer(key: string, openPromise: Promise<unknown>): void {
    this.creatingKeys.add(key)
    void openPromise
      .catch(() => undefined)
      .finally(() => {
        this.creatingKeys.delete(key)
      })
  }

  beginLocalEdit(bufferKey: string): string {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    this.pendingLocalEditCounts.set(
      resolvedKey,
      (this.pendingLocalEditCounts.get(resolvedKey) ?? 0) + 1
    )
    return resolvedKey
  }

  finishLocalEdit(initialResolvedKey: string): void {
    const finalKey = this.resolveLatestKey(initialResolvedKey)
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
  }

  async runManualSave<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.pendingManualSaveKeys.add(key)
    try {
      return await task()
    } finally {
      this.pendingManualSaveKeys.delete(key)
    }
  }

  clearTrackingForKeys(keys: Iterable<string>): void {
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

  applyKeyRemappings(
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

  syncWindowTabs(keys: string[]): void {
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

  syncCurrentLayoutTabs(): void {
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
          this.onSaveError(event.message, new Error(event.message))
        }
        return
      }
    }
  }
}
