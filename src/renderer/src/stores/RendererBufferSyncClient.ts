import { isSupportedImageFile } from '@shared/assets'
import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type SaveBufferOptions,
  type SaveBufferResult,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import { DocumentBufferStore, mergePendingLocalBuffer } from '@shared/documentBufferStore'
import type { TextEncoding, UnencodableCharsInfo } from '@shared/encoding'
import { toErrorMessage } from '@shared/errors'
import type { WikiBufferApi, WikiWindowApi } from '@shared/ipc'
import {
  canDetachTabFromWindow,
  createWindowInitContextLoader,
  extractTabViewState,
  isDiffTabTransferPayload,
  isSnapshotTabTransferPayload,
  toTabTransferPayload,
  type TabTransferPayload,
  type WindowInitContext
} from '@shared/window'
import { countBufferKeys } from '@shared/windowTabTracker'
import {
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  type WorkspaceChangeEvent,
  type WorkspaceEntry
} from '@shared/workspace'
import { isImageDocument } from '../editor/editorModes'
import {
  type DocumentTabItem,
  type PaneId,
  PaneTabStore,
  type RestoreWorkspaceLayoutInput,
  type TabItem,
  type TransferredTabDropTarget
} from './PaneTabStore'

export interface OpenedWorkspaceDocument {
  buffer: DocumentBuffer
  tab: DocumentTabItem
  paneId: PaneId
}

export interface DirtyTabClosePrompt {
  paneId: PaneId
  tabId: string
  buffer: DocumentBuffer
  saveAndClose: () => Promise<boolean>
  discardAndClose: () => void
}

export interface WorkspaceFileOpenRequest {
  key: string
  loadPath: string
  name: string
}

type DirtyBufferScope = 'workspace-all' | 'all-windows-close' | 'exclusive-window-close'

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

export interface LossySaveConfirmRequest {
  bufferKey: string
  bufferName: string
  encoding: TextEncoding
  unencodableChars: UnencodableCharsInfo
}

export interface RendererBufferSyncClientOptions {
  bufferStore: DocumentBufferStore
  tabStore: PaneTabStore
  bufferApi: WikiBufferApi
  windowApi?: WikiWindowApi
  loadInitContext?: () => Promise<WindowInitContext | null>
  onWorkspaceSaved?: () => void
  onError: (message: string | null, error?: unknown) => void
  onConfirmCloseDirtyTab: (request: DirtyTabClosePrompt) => void
  onConfirmLossySave?: (request: LossySaveConfirmRequest) => Promise<boolean>
}

/**
 * Coordinates a renderer window's local DocumentBufferStore, PaneTabStore, and
 * main-process SharedDocumentBufferHub IPC lifecycle.
 */
export class RendererBufferSyncClient {
  private readonly bufferStore: DocumentBufferStore
  private readonly tabStore: PaneTabStore
  private readonly bufferApi: WikiBufferApi
  private readonly windowApi?: WikiWindowApi
  private readonly resolveInitContext: () => Promise<WindowInitContext | null>
  private readonly hasInitContextLoader: boolean
  private onWorkspaceSaved?: () => void
  private onError: (message: string | null, error?: unknown) => void
  private onConfirmCloseDirtyTab: (request: DirtyTabClosePrompt) => void
  private onConfirmLossySave?: (request: LossySaveConfirmRequest) => Promise<boolean>

  private windowId: number | null = null
  private hasAppliedInitContext = false
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
  private readonly activeRemoteOpens = new Set<Set<string>>()
  private readonly remappedKeys = new Map<string, string>()
  private lastSyncedTabKeys: readonly string[] | null = null
  private lastSyncedNonBufferTabCount: number | null = null
  private needsPendingOpenRelease = false
  private mounted = false

  constructor(options: RendererBufferSyncClientOptions) {
    this.bufferStore = options.bufferStore
    this.tabStore = options.tabStore
    this.bufferApi = options.bufferApi
    this.windowApi = options.windowApi
    this.hasInitContextLoader = Boolean(
      options.loadInitContext || options.windowApi?.getInitContext
    )
    this.resolveInitContext =
      options.loadInitContext ?? createWindowInitContextLoader(options.windowApi)
    this.onWorkspaceSaved = options.onWorkspaceSaved
    this.onError = options.onError
    this.onConfirmCloseDirtyTab = options.onConfirmCloseDirtyTab
    this.onConfirmLossySave = options.onConfirmLossySave

    this.localTabCounts = countBufferKeys(this.tabStore.getBufferKeys())
    this.recomputeEffectiveTabCounts()
    this.tabStore.subscribe(() => this.handleLocalTabStoreChange())
  }

  get isMounted(): boolean {
    return this.mounted
  }

  start(): () => void {
    this.mounted = true
    this.lastSyncedTabKeys = null
    const unsubscribeHub = this.bufferApi.onEvent((event) => this.handleHubEvent(event))

    const shouldLoadInitContext = !this.hasAppliedInitContext && this.hasInitContextLoader
    const startupPromise = shouldLoadInitContext
      ? Promise.all([this.bufferApi.getSnapshot(), this.resolveInitContext()])
      : this.bufferApi.getSnapshot().then((snapshot) => [snapshot, null] as const)

    void startupPromise.then(
      ([snapshot, initContext]) => {
        if (!this.mounted) return
        let openedInitialTabs = false
        if (initContext && !this.hasAppliedInitContext) {
          this.hasAppliedInitContext = true
          for (const tab of initContext.initialTabs) {
            if (isDiffTabTransferPayload(tab)) {
              this.tabStore.openDiffTab(tab.diff.request, {
                viewMode: tab.diff.viewMode,
                workspaceRootPath: tab.diff.workspaceRootPath,
                pinned: true
              })
              openedInitialTabs = true
              continue
            }
            if (isSnapshotTabTransferPayload(tab)) {
              this.tabStore.openSnapshotTab(tab.snapshot.request, {
                scrollTop: tab.snapshot.scrollTop,
                workspaceRootPath: tab.snapshot.workspaceRootPath,
                pinned: true
              })
              openedInitialTabs = true
              continue
            }
            const resolvedKey = this.resolveLatestKey(tab.bufferKey)
            if (resolvedKey in snapshot.buffers) {
              this.tabStore.openTab(resolvedKey, extractTabViewState(tab))
              openedInitialTabs = true
            }
          }
        }
        this.applyHubSnapshot(snapshot)
        if (openedInitialTabs) {
          this.syncCurrentLayoutTabs()
        }
      },
      () => undefined
    )

    return () => {
      this.mounted = false
      unsubscribeHub()
      void this.bufferApi.setAutoSavePaused(false).catch(() => undefined)
      this.releasePendingWindowTabs()
    }
  }

  private releasePendingWindowTabs(): void {
    void this.bufferApi.syncWindowTabs([], { releasePending: true }).catch(() => undefined)
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

  private dispatchWindowTabSync(
    keys: readonly string[],
    releasePending = false,
    nonBufferTabCount = 0
  ): void {
    const nextKeys = [...keys]
    this.lastSyncedTabKeys = nextKeys
    this.lastSyncedNonBufferTabCount = nonBufferTabCount
    const options =
      releasePending || nonBufferTabCount > 0
        ? {
            ...(releasePending ? { releasePending: true } : {}),
            ...(nonBufferTabCount > 0 ? { nonBufferTabCount } : {})
          }
        : undefined
    void this.bufferApi
      .syncWindowTabs(nextKeys, options)
      .then((snapshot) => {
        if (this.mounted) {
          this.applyHubSnapshot(snapshot)
        }
      })
      .catch(() => undefined)
  }

  syncWindowTabs = (keys: string[], nonBufferTabCount = 0): void => {
    if (
      areStringArraysEqual(this.lastSyncedTabKeys, keys) &&
      (this.lastSyncedNonBufferTabCount ?? 0) === nonBufferTabCount
    ) {
      return
    }
    this.dispatchWindowTabSync(keys, false, nonBufferTabCount)
  }

  private syncCurrentLayoutTabs(): void {
    const bufferKeys = this.tabStore.getBufferKeys()
    const nonBufferTabCount = Math.max(0, this.tabStore.getTotalTabCount() - bufferKeys.length)
    this.syncWindowTabs(bufferKeys, nonBufferTabCount)
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
        for (const closedSet of this.activeRemoteOpens) {
          for (const closedKey of event.closedKeys) {
            closedSet.add(closedKey)
          }
        }
        this.clearTrackingForKeys(event.closedKeys)
        this.tabStore.closeTabsByBufferKeys(event.closedKeys)
        this.applyHubSnapshot(event.snapshot)
        return
      case 'buffers-force-synced':
        this.clearTrackingForKeys(event.syncedKeys)
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
    fallbackError: string,
    isCancelled?: () => boolean
  ): Promise<OpenedWorkspaceDocument | null> {
    this.onError(null)
    const closedDuringOpen = new Set<string>()
    this.activeRemoteOpens.add(closedDuringOpen)
    try {
      const buf = await loadBuffer()
      if (!this.mounted) {
        this.needsPendingOpenRelease = false
        this.releasePendingWindowTabs()
        return null
      }
      if (isCancelled?.()) {
        this.needsPendingOpenRelease = true
        return null
      }
      const targetKey = this.resolveLatestKey(buf.key)
      if (closedDuringOpen.has(buf.key) || closedDuringOpen.has(targetKey)) {
        this.needsPendingOpenRelease = true
        return null
      }
      if (targetKey !== buf.key && !this.latestHubBuffers[targetKey]) {
        this.needsPendingOpenRelease = true
        return null
      }
      this.remappedKeys.delete(buf.key)
      this.remappedKeys.delete(targetKey)
      this.reconcileIncomingBuffer(buf)
      const tab = this.tabStore.openTab(targetKey, { paneId: targetPaneId })
      const paneId = this.tabStore.getSnapshot().activePaneId
      this.syncCurrentLayoutTabs()
      return { buffer: this.bufferStore.getBuffer(targetKey) ?? buf, tab, paneId }
    } catch (error: unknown) {
      this.needsPendingOpenRelease = true
      if (this.mounted && !isCancelled?.()) {
        this.onError(toErrorMessage(error, fallbackError), error)
      }
      return null
    } finally {
      this.activeRemoteOpens.delete(closedDuringOpen)
      if (this.mounted && this.activeRemoteOpens.size === 0 && this.needsPendingOpenRelease) {
        this.needsPendingOpenRelease = false
        this.dispatchWindowTabSync(this.tabStore.getBufferKeys(), true)
      }
    }
  }

  openWorkspaceFile = async (
    target: WorkspaceEntry | string,
    targetPaneId?: PaneId,
    explicitName?: string,
    isCancelled?: () => boolean
  ): Promise<OpenedWorkspaceDocument | null> => {
    const filePath = typeof target === 'string' ? target : target.path
    const name =
      explicitName ?? (typeof target === 'string' ? getWorkspaceDisplayName(filePath) : target.name)
    const key = getWorkspacePathKey(filePath)
    this.remappedKeys.delete(key)
    const existing = this.bufferStore.getBuffer(key)
    if ((this.localTabCounts[key] ?? 0) > 0 && existing) {
      if (isCancelled?.()) {
        return null
      }
      const tab = this.tabStore.openTab(key, { paneId: targetPaneId })
      const paneId = this.tabStore.getSnapshot().activePaneId
      return { buffer: existing, tab, paneId }
    }

    return this.openRemoteBuffer(
      () => this.bufferApi.openWorkspaceFile(filePath, name),
      targetPaneId,
      '파일을 열지 못했습니다.',
      isCancelled
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

  private trackAsyncFlush(
    flushes: Map<string, Promise<void>>,
    initialKey: string,
    flushPromise: Promise<void>,
    alreadyInSync: boolean
  ): void {
    // Skip queueing when the in-memory hub test harness already settled synchronously.
    if (alreadyInSync) return
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
    if (isSupportedImageFile(created.path)) {
      void this.openWorkspaceFile(created)
      return
    }
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
              this.releasePendingWindowTabs()
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
    const alreadyInSync =
      previousCreate === undefined &&
      this.latestHubBuffers !== prevHubBuffers &&
      buf.key in this.latestHubBuffers
    this.trackAsyncFlush(this.pendingCreateFlushes, buf.key, createPromise, alreadyInSync)
  }

  updateBufferContent = (bufferKey: string, nextContent: string): void => {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    const existing = this.bufferStore.getBuffer(resolvedKey)
    if (existing && isImageDocument(existing)) {
      return
    }
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

    const alreadyInSync =
      priorFlush === undefined &&
      this.latestHubBuffers !== prevHubBuffers &&
      this.latestHubBuffers[resolvedKey]?.content === nextContent
    this.trackAsyncFlush(this.pendingEditFlushes, resolvedKey, requestPromise, alreadyInSync)
  }

  private hasPendingUpdatesForKey(key: string): boolean {
    return this.pendingCreateFlushes.has(key) || this.pendingEditFlushes.has(key)
  }

  private async flushPendingUpdatesForKey(initialKey: string): Promise<string> {
    let currentKey = this.resolveLatestKey(initialKey)
    while (this.hasPendingUpdatesForKey(currentKey)) {
      const pendingCreate = this.pendingCreateFlushes.get(currentKey)
      if (pendingCreate) {
        await pendingCreate
        currentKey = this.resolveLatestKey(currentKey)
        continue
      }
      await this.pendingEditFlushes.get(currentKey)
      currentKey = this.resolveLatestKey(currentKey)
    }
    return currentKey
  }

  private needsHubContentSync(key: string): boolean {
    const localBuf = this.bufferStore.getBuffer(key)
    if (!localBuf || isImageDocument(localBuf)) return false
    const hubBuf = this.latestHubBuffers[key]
    return Boolean(
      this.unsyncedLocalKeys.has(key) || !hubBuf || localBuf.content !== hubBuf.content
    )
  }

  private async pushLocalContentToHub(key: string): Promise<void> {
    const localBuf = this.bufferStore.getBuffer(key)
    if (!localBuf) return
    await this.bufferApi.updateContent(key, localBuf.content)
    this.unsyncedLocalKeys.delete(key)
  }

  private needsAsyncHubSync(key: string): boolean {
    return this.hasPendingUpdatesForKey(key) || this.needsHubContentSync(key)
  }

  private async syncBufferKeyToHub(initialKey: string): Promise<string> {
    const currentKey = this.hasPendingUpdatesForKey(initialKey)
      ? await this.flushPendingUpdatesForKey(initialKey)
      : initialKey
    if (this.mounted && this.needsHubContentSync(currentKey)) {
      await this.pushLocalContentToHub(currentKey)
    }
    return currentKey
  }

  setEncoding = async (
    bufferKey: string,
    encoding: TextEncoding
  ): Promise<DocumentBuffer | null> => {
    const initialKey = this.resolveLatestKey(bufferKey)
    const currentKey = this.needsAsyncHubSync(initialKey)
      ? await this.syncBufferKeyToHub(initialKey)
      : initialKey
    const updated = await this.bufferApi.setEncoding(currentKey, encoding)
    if (updated && this.mounted) {
      this.reconcileIncomingBuffer(updated)
    }
    return updated
  }

  reopenWithEncoding = async (
    bufferKey: string,
    encoding: TextEncoding
  ): Promise<DocumentBuffer | null> => {
    const initialKey = this.resolveLatestKey(bufferKey)
    const currentKey = this.hasPendingUpdatesForKey(initialKey)
      ? await this.flushPendingUpdatesForKey(initialKey)
      : initialKey
    this.deleteTrackedKeyVariants(this.unsyncedLocalKeys, currentKey)
    this.pendingLocalEditCounts.delete(currentKey)
    const reopened = await this.bufferApi.reopenWithEncoding(currentKey, encoding)
    if (reopened && this.mounted) {
      this.bufferStore.upsertBuffer(reopened)
      this.latestHubBuffers = { ...this.latestHubBuffers, [reopened.key]: reopened }
    }
    return reopened
  }

  saveBuffer = async (
    bufferKey: string,
    options?: SaveBufferOptions
  ): Promise<SaveBufferResult> => {
    const initialKey = this.resolveLatestKey(bufferKey)
    this.pendingManualSaveKeys.add(initialKey)
    try {
      const currentKey = this.needsAsyncHubSync(initialKey)
        ? await this.syncBufferKeyToHub(initialKey)
        : initialKey
      return await this.bufferApi.saveBuffer(currentKey, options)
    } finally {
      this.deleteTrackedKeyVariants(this.pendingManualSaveKeys, initialKey)
    }
  }

  private async runSaveBufferRequest(key: string): Promise<boolean> {
    try {
      const result = await this.saveBuffer(key)
      if (!result.ok && result.unencodableChars && this.onConfirmLossySave && this.mounted) {
        const buffer = result.buffer ?? this.bufferStore.getBuffer(key)
        const confirmed = await this.onConfirmLossySave({
          bufferKey: buffer?.key ?? key,
          bufferName: buffer?.name ?? key,
          encoding: buffer?.encoding ?? 'euc-kr',
          unencodableChars: result.unencodableChars
        })
        if (!confirmed || !this.mounted) {
          return false
        }
        const lossyResult = await this.saveBuffer(key, { allowLossy: true })
        if (!lossyResult.ok && lossyResult.errorMessage && this.mounted) {
          this.onError(lossyResult.errorMessage, new Error(lossyResult.errorMessage))
        }
        return lossyResult.ok
      }
      if (!result.ok && result.errorMessage && this.mounted) {
        this.onError(result.errorMessage, new Error(result.errorMessage))
      }
      return result.ok
    } catch (error: unknown) {
      if (this.mounted) {
        this.onError(toErrorMessage(error, '문서 저장에 실패했습니다.'), error)
      }
      return false
    }
  }

  saveBufferByKey = (bufferKey: string): void => {
    const current = this.bufferStore.getBuffer(bufferKey)
    if (!current || isImageDocument(current) || !current.isDirty || current.isSaving) {
      return
    }
    this.onError(null)
    void this.runSaveBufferRequest(current.key)
  }

  saveActivePaneDocument = (): void => {
    const activeTab = this.tabStore.getActiveTab()
    if (!activeTab || activeTab.kind !== 'document') return
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
        this.hasPendingLocalOrFlush(key)
    )
  }

  private async ensureSavedBuffer(bufferKey: string): Promise<boolean> {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    if (!this.needsBufferSave(resolvedKey)) {
      return true
    }

    return this.runSaveBufferRequest(resolvedKey)
  }

  private getWindowCloseDirtyScope(): DirtyBufferScope {
    return this.windowApi?.role === 'auxiliary' ? 'exclusive-window-close' : 'all-windows-close'
  }

  private hasLocalPendingState(key: string): boolean {
    return (
      (this.pendingLocalEditCounts.get(key) ?? 0) > 0 ||
      this.unsyncedLocalKeys.has(key) ||
      this.creatingKeys.has(key)
    )
  }

  private hasPendingLocalOrFlush(key: string): boolean {
    return this.hasLocalPendingState(key) || this.hasPendingUpdatesForKey(key)
  }

  private toTargetKeySet(targetPaths?: readonly string[]): Set<string> | null {
    if (targetPaths === undefined) return null
    const keys = new Set<string>()
    for (const targetPath of targetPaths) {
      const key = getWorkspacePathKey(targetPath)
      if (!key) continue
      keys.add(this.resolveLatestKey(key))
    }
    return keys
  }

  private getScopeCandidates(
    scope: DirtyBufferScope,
    targetKeys: Set<string> | null = null
  ): Array<{ key: string; buffer: DocumentBuffer }> {
    if (targetKeys && targetKeys.size === 0) {
      return []
    }
    const localSnapshot = this.bufferStore.getSnapshot()
    const candidateKeys = new Set<string>()
    for (const rawKey of [
      ...Object.keys(this.latestHubBuffers),
      ...this.tabStore.getBufferKeys(),
      ...Object.keys(localSnapshot)
    ]) {
      candidateKeys.add(this.resolveLatestKey(rawKey))
    }

    const candidates: Array<{ key: string; buffer: DocumentBuffer }> = []
    for (const key of candidateKeys) {
      if (targetKeys && !targetKeys.has(key)) continue
      const localBuf = localSnapshot[key]
      const hubBuf = this.latestHubBuffers[key]
      const buffer = this.hasPendingLocalOrFlush(key) && localBuf ? localBuf : (hubBuf ?? localBuf)
      if (!buffer) continue

      if (scope === 'workspace-all' && buffer.kind !== 'workspace') continue
      if (scope === 'exclusive-window-close') {
        const localCount = this.localTabCounts[key] ?? 0
        if (localCount === 0 || (this.effectiveTabCounts[key] ?? 0) > localCount) {
          continue
        }
      }

      candidates.push({ key, buffer })
    }
    return candidates
  }

  private getDirtySummaryForScope(
    scope: DirtyBufferScope,
    targetKeys: Set<string> | null = null
  ): string | null {
    const dirty = this.getScopeCandidates(scope, targetKeys)
      .filter(({ key, buffer }) => buffer.isDirty || this.hasLocalPendingState(key))
      .map(({ buffer }) => buffer)
    if (dirty.length === 0) return null
    if (dirty.length === 1) return dirty[0].name
    return `${dirty[0].name} 외 ${dirty.length - 1}개`
  }

  private async ensureScopeBuffersSaved(
    scope: DirtyBufferScope,
    targetKeys: Set<string> | null = null
  ): Promise<boolean> {
    const targetKeysToSave = this.getScopeCandidates(scope, targetKeys)
      .filter(({ key }) => this.needsBufferSave(key))
      .map(({ key }) => key)
    if (targetKeysToSave.length === 0) return true

    this.onError(null)
    for (const key of targetKeysToSave) {
      if (!(await this.ensureSavedBuffer(key))) return false
    }
    return true
  }

  ensureAllWorkspaceBuffersSaved = async (targetPaths?: readonly string[]): Promise<boolean> => {
    return this.ensureScopeBuffersSaved('workspace-all', this.toTargetKeySet(targetPaths))
  }

  getDirtyWorkspaceSummary = (targetPaths?: readonly string[]): string | null => {
    return this.getDirtySummaryForScope('workspace-all', this.toTargetKeySet(targetPaths))
  }

  getDirtyCloseSummary = (): string | null => {
    return this.getDirtySummaryForScope(this.getWindowCloseDirtyScope())
  }

  ensureCloseBuffersSaved = async (): Promise<boolean> => {
    return this.ensureScopeBuffersSaved(this.getWindowCloseDirtyScope())
  }

  forceCloseTab = (paneId: PaneId, tabId: string): void => {
    const result = this.tabStore.closeTab(paneId, tabId)
    if (result?.isLastReferenceForBuffer && result.closedTab.kind === 'document') {
      this.cleanupClosedLocalBuffers([result.closedTab.bufferKey])
      return
    }
    this.syncCurrentLayoutTabs()
  }

  requestCloseTab = (paneId: PaneId, tabId: string): void => {
    const tab = this.tabStore.getTab(paneId, tabId)
    if (!tab) return
    if (tab.kind !== 'document') {
      this.forceCloseTab(paneId, tabId)
      return
    }
    const buffer = this.bufferStore.getBuffer(tab.bufferKey)
    const hasOtherTabAcrossWindows =
      this.tabStore.hasOtherTabForBuffer(tab.bufferKey, tab.id) ||
      (this.effectiveTabCounts[tab.bufferKey] ?? 1) > 1
    if (buffer?.isDirty && !hasOtherTabAcrossWindows) {
      void this.bufferApi.setAutoSavePaused(true).catch(() => undefined)
      this.onConfirmCloseDirtyTab({
        paneId,
        tabId,
        buffer,
        saveAndClose: () => this.saveAndCloseTab(paneId, tabId),
        discardAndClose: () => this.forceCloseTab(paneId, tabId)
      })
      return
    }
    this.forceCloseTab(paneId, tabId)
  }

  saveAndCloseTab = async (paneId: PaneId, tabId: string): Promise<boolean> => {
    const tab = this.tabStore.getTab(paneId, tabId)
    if (!tab) return true
    if (tab.kind !== 'document') {
      this.forceCloseTab(paneId, tabId)
      return true
    }
    const ok = await this.ensureSavedBuffer(tab.bufferKey)
    if (!ok) return false
    this.forceCloseTab(paneId, tabId)
    return true
  }

  getWindowId = (): number | null => this.windowId

  isBufferReadyForImmediateDrag = (bufferKey: string): boolean => {
    const resolvedKey = this.resolveLatestKey(bufferKey)
    return !this.pendingCreateFlushes.has(resolvedKey) && resolvedKey in this.latestHubBuffers
  }

  completeTransferredOutTab = async (paneId: PaneId, tabId: string): Promise<void> => {
    const tab = this.tabStore.getTab(paneId, tabId)
    if (!tab || tab.kind !== 'document') return
    const resolvedKey = this.resolveLatestKey(tab.bufferKey)
    if (this.needsAsyncHubSync(resolvedKey)) {
      await this.syncBufferKeyToHub(resolvedKey).catch(() => null)
    }
    if (this.mounted) {
      this.forceCloseTab(paneId, tabId)
    }
  }

  private reconcileIncomingBuffer(buffer: DocumentBuffer): string {
    const targetKey = this.resolveLatestKey(buffer.key)
    const latestBuf = this.latestHubBuffers[targetKey]
    const targetBuf =
      latestBuf && (targetKey !== buffer.key || latestBuf.version > buffer.version)
        ? latestBuf
        : buffer
    if (!this.pendingLocalEditCounts.has(targetKey) && !this.unsyncedLocalKeys.has(targetKey)) {
      this.bufferStore.upsertBuffer(targetBuf)
      this.latestHubBuffers = { ...this.latestHubBuffers, [targetBuf.key]: targetBuf }
    }
    return targetKey
  }

  acceptTransferredTab = (
    buffer: DocumentBuffer | undefined,
    payload: TabTransferPayload,
    target?: TransferredTabDropTarget
  ): TabItem | null => {
    if (isDiffTabTransferPayload(payload) || isSnapshotTabTransferPayload(payload)) {
      const accepted = this.tabStore.acceptTransferredTab(payload, target)
      this.syncCurrentLayoutTabs()
      return accepted
    }
    if (!buffer) {
      return null
    }
    const targetKey = this.reconcileIncomingBuffer(buffer)
    const accepted = this.tabStore.acceptTransferredTab(
      { ...payload, bufferKey: targetKey },
      target
    )
    this.syncCurrentLayoutTabs()
    return accepted
  }

  syncTabBufferForTransfer = async (
    paneId: PaneId,
    tabId: string
  ): Promise<DocumentTabItem | null> => {
    const initialTab = this.tabStore.getTab(paneId, tabId)
    if (!initialTab || initialTab.kind !== 'document') return null

    const initialKey = this.resolveLatestKey(initialTab.bufferKey)
    if (this.needsAsyncHubSync(initialKey)) {
      await this.syncBufferKeyToHub(initialKey)
      if (!this.mounted) return null
    }

    const latest = this.tabStore.getTab(paneId, tabId)
    return latest?.kind === 'document' ? latest : null
  }

  detachTabToNewWindow = async (paneId: PaneId, tabId: string): Promise<void> => {
    if (!this.windowApi) return
    if (!canDetachTabFromWindow(this.windowApi.role, this.tabStore.getTotalTabCount())) {
      return
    }

    try {
      const initialTab = this.tabStore.getTab(paneId, tabId)
      if (!initialTab) return
      const latestTab =
        initialTab.kind === 'diff'
          ? initialTab
          : await this.syncTabBufferForTransfer(paneId, tabId)
      if (!latestTab) return
      if (!canDetachTabFromWindow(this.windowApi.role, this.tabStore.getTotalTabCount())) {
        return
      }

      await this.windowApi.detachTabToNewWindow(toTabTransferPayload(latestTab))
      this.forceCloseTab(paneId, latestTab.id)
    } catch (error: unknown) {
      if (this.mounted) {
        this.onError(toErrorMessage(error, '새 창으로 이동하지 못했습니다.'), error)
      }
    }
  }

  clearWorkspaceBuffers = (): void => {
    const localWorkspaceKeys = this.tabStore.getBufferKeys().filter((key) => {
      const resolvedKey = this.resolveLatestKey(key)
      const kind =
        this.bufferStore.getBuffer(resolvedKey)?.kind ?? this.latestHubBuffers[resolvedKey]?.kind
      return kind === 'workspace'
    })
    if (localWorkspaceKeys.length > 0) {
      this.tabStore.closeTabsByBufferKeys(localWorkspaceKeys)
      this.cleanupClosedLocalBuffers(localWorkspaceKeys)
    }
    this.tabStore.closeAllDiffTabs()
    this.tabStore.closeAllSnapshotTabs()
    void this.bufferApi.clearWorkspaceBuffers().catch(() => undefined)
  }

  openWorkspaceFilesSilently = async (
    files: readonly WorkspaceFileOpenRequest[]
  ): Promise<Map<string, DocumentBuffer>> => {
    const loadedBuffersByKey = new Map<string, DocumentBuffer>()
    if (files.length === 0) {
      return loadedBuffersByKey
    }
    const settled = await Promise.allSettled(
      files.map(async (file) => ({
        key: file.key,
        buffer: await this.bufferApi.openWorkspaceFile(file.loadPath, file.name)
      }))
    )
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        loadedBuffersByKey.set(result.value.key, result.value.buffer)
      }
    }
    return loadedBuffersByKey
  }

  commitRestoredWorkspaceLayout = (
    loadedBuffers: Iterable<DocumentBuffer>,
    buildRestoreInput: (
      resolvedKeyByPathKey: ReadonlyMap<string, string>
    ) => RestoreWorkspaceLayoutInput
  ): boolean => {
    if (!this.mounted) {
      return false
    }
    const resolvedKeyByPathKey = new Map<string, string>()
    for (const buffer of loadedBuffers) {
      const pathKey = getWorkspacePathKey(buffer.path)
      if (!pathKey || resolvedKeyByPathKey.has(pathKey)) continue
      resolvedKeyByPathKey.set(pathKey, this.reconcileIncomingBuffer(buffer))
    }
    this.tabStore.restoreWorkspaceLayout(buildRestoreInput(resolvedKeyByPathKey), {
      preserveTab: (tab) =>
        tab.kind === 'document' && this.bufferStore.getBuffer(tab.bufferKey)?.kind === 'config'
    })
    this.syncCurrentLayoutTabs()
    return true
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

  reconcileWorkspaceBuffersWithDisk = async (
    changeEvent?: WorkspaceChangeEvent
  ): Promise<readonly string[]> => {
    const result = await this.bufferApi.reconcileWorkspaceBuffersWithDisk(changeEvent)
    return result.warnings
  }

  prepareWorkspacePathsForDiscard = async (targetPaths: readonly string[]): Promise<void> => {
    if (targetPaths.length === 0) return
    await this.bufferApi.prepareDiscardPaths(targetPaths)
  }

  finishWorkspacePathsDiscard = async (
    targetPaths: readonly string[],
    forceSync: boolean
  ): Promise<void> => {
    if (targetPaths.length === 0) return
    if (forceSync) {
      const targetKeys = this.toTargetKeySet(targetPaths)
      if (targetKeys && targetKeys.size > 0) {
        this.clearTrackingForKeys(targetKeys)
      }
    }
    await this.bufferApi.finishDiscardPaths(targetPaths, forceSync)
  }
}
