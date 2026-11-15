import { BufferAutoSaveScheduler } from './bufferAutoSaveScheduler'
import {
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentKind,
  isMissingWorkspaceFileError,
  type ReconcileBuffersResult,
  type SaveBufferResult,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot
} from './documentBuffer'
import { DocumentBufferStore } from './documentBufferStore'
import { toErrorMessage } from './errors'
import { getWorkspacePathKey } from './workspace'

export interface SharedDocumentBufferStorage {
  readWorkspaceFile: (filePath: string) => Promise<string>
  writeWorkspaceFile: (filePath: string, content: string) => Promise<void>
  getConfigPath: () => Promise<string>
  readConfigRaw: () => Promise<string>
  saveConfigRaw: (raw: string) => Promise<unknown>
}

export interface SharedDocumentBufferHubOptions {
  storage: SharedDocumentBufferStorage
  initialAutoSave?: boolean
  initialAutoSaveDelayMs?: number
  logError?: (message: string, details?: Record<string, unknown>) => void
}

interface InFlightSaveEntry {
  currentKey: string
  promise: Promise<SaveBufferResult>
}

function areTabCountMapsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * Single authoritative coordinator for document buffers shared across windows.
 * Owns canonical DocumentBuffer state, per-window tab reference counting,
 * path rename/delete synchronization, and disk reconciliation.
 */
export class SharedDocumentBufferHub {
  private readonly store = new DocumentBufferStore()
  private readonly listeners = new Set<(event: SharedBufferHubEvent) => void>()
  private readonly windowTabs = new Map<number, Map<string, number>>()
  private readonly pendingOpenWindows = new Map<string, Set<number>>()
  private readonly inFlightOpens = new Map<string, Promise<DocumentBuffer>>()
  private readonly inFlightSaves = new Map<string, InFlightSaveEntry>()
  private readonly autoSaveScheduler: BufferAutoSaveScheduler
  private readonly storage: SharedDocumentBufferStorage
  private readonly logError?: (message: string, details?: Record<string, unknown>) => void

  private tabCounts: Record<string, number> = {}
  private disposed = false

  constructor(options: SharedDocumentBufferHubOptions) {
    this.storage = options.storage
    this.autoSaveScheduler = new BufferAutoSaveScheduler({
      initialAutoSave: options.initialAutoSave,
      initialAutoSaveDelayMs: options.initialAutoSaveDelayMs
    })
    this.logError = options.logError
  }

  subscribe(listener: (event: SharedBufferHubEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): SharedBufferStateSnapshot {
    return {
      buffers: this.store.getSnapshot(),
      tabCounts: { ...this.tabCounts }
    }
  }

  private emit(event: SharedBufferHubEvent): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private reconcileAutoSaveTimers(): void {
    if (this.disposed) return
    this.autoSaveScheduler.reconcile({
      buffers: this.store.getSnapshot(),
      isSaveInFlight: (key) => this.inFlightSaves.has(key),
      getLatestBuffer: (key) => this.store.getBuffer(key),
      onTriggerSave: (buffer) => {
        void this.executeSave(buffer)
      }
    })
  }

  private cleanupTrackingForKeys(keys: Iterable<string>): void {
    const keyList = [...keys]
    this.autoSaveScheduler.clearForKeys(keyList)
    for (const key of keyList) {
      this.pendingOpenWindows.delete(key)
    }
  }

  private computeTabCounts(): Record<string, number> {
    const nextCounts: Record<string, number> = {}
    for (const perWindow of this.windowTabs.values()) {
      for (const [key, count] of perWindow.entries()) {
        if (count > 0) {
          nextCounts[key] = (nextCounts[key] ?? 0) + count
        }
      }
    }
    return nextCounts
  }

  private pruneAndRemoveTabReferences(removedKeys: ReadonlySet<string>): void {
    if (removedKeys.size === 0) return
    for (const perWindow of this.windowTabs.values()) {
      for (const key of removedKeys) {
        perWindow.delete(key)
      }
    }
    this.tabCounts = this.computeTabCounts()
  }

  private registerPendingOpenOwner(key: string, windowId?: number): void {
    if (windowId === undefined || this.windowTabs.get(windowId)?.has(key)) return
    let owners = this.pendingOpenWindows.get(key)
    if (!owners) {
      owners = new Set<number>()
      this.pendingOpenWindows.set(key, owners)
    }
    owners.add(windowId)
  }

  private removePendingOpenOwner(key: string, windowId: number): boolean {
    const owners = this.pendingOpenWindows.get(key)
    if (!owners || !owners.delete(windowId)) return false
    if (owners.size === 0) {
      this.pendingOpenWindows.delete(key)
      return true
    }
    return false
  }

  private hasActiveOrPendingOwner(key: string, counts: Readonly<Record<string, number>>): boolean {
    return (counts[key] ?? 0) > 0 || (this.pendingOpenWindows.get(key)?.size ?? 0) > 0
  }

  private removeOrphanedBuffers(
    prevCounts: Readonly<Record<string, number>>,
    nextCounts: Readonly<Record<string, number>>,
    extraCandidateKeys: Iterable<string> = []
  ): boolean {
    const orphanKeys = new Set<string>()
    for (const candidateKey of extraCandidateKeys) {
      if (!this.hasActiveOrPendingOwner(candidateKey, nextCounts)) {
        orphanKeys.add(candidateKey)
      }
    }
    for (const [key, prevCount] of Object.entries(prevCounts)) {
      if (prevCount > 0 && !this.hasActiveOrPendingOwner(key, nextCounts)) {
        orphanKeys.add(key)
      }
    }
    if (orphanKeys.size === 0) {
      return false
    }

    let removedAnyBuffer = false
    for (const key of orphanKeys) {
      if (this.store.removeBuffer(key)) {
        removedAnyBuffer = true
      }
    }
    this.cleanupTrackingForKeys(orphanKeys)
    return removedAnyBuffer
  }

  private reconcileTabCountChanges(
    prevCounts: Readonly<Record<string, number>>,
    extraCandidateKeys: Iterable<string> = [],
    options: { checkCountChange?: boolean; forceTimerReconcile?: boolean } = {}
  ): void {
    const nextCounts = this.computeTabCounts()
    const removedAnyBuffer = this.removeOrphanedBuffers(
      prevCounts,
      nextCounts,
      extraCandidateKeys
    )
    const countsChanged =
      (options.checkCountChange ?? true) && !areTabCountMapsEqual(prevCounts, nextCounts)
    this.tabCounts = nextCounts

    if (options.forceTimerReconcile || removedAnyBuffer || countsChanged) {
      this.reconcileAutoSaveTimers()
      if (removedAnyBuffer || countsChanged) {
        this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
      }
    }
  }

  syncWindowTabs(windowId: number, bufferKeys: readonly string[]): SharedBufferStateSnapshot {
    const perWindow = new Map<string, number>()
    for (const key of bufferKeys) {
      if (!key) continue
      perWindow.set(key, (perWindow.get(key) ?? 0) + 1)
      this.removePendingOpenOwner(key, windowId)
    }

    const prevCounts = this.tabCounts
    this.windowTabs.set(windowId, perWindow)
    this.reconcileTabCountChanges(prevCounts)

    return this.getSnapshot()
  }

  unregisterWindow(windowId: number): void {
    const wasPaused = this.autoSaveScheduler.removePausedWindow(windowId)
    const hadTabs = this.windowTabs.delete(windowId)
    const prevCounts = this.tabCounts

    const depletedPendingKeys: string[] = []
    for (const key of [...this.pendingOpenWindows.keys()]) {
      if (this.removePendingOpenOwner(key, windowId)) {
        depletedPendingKeys.push(key)
      }
    }

    this.reconcileTabCountChanges(prevCounts, depletedPendingKeys, {
      checkCountChange: hadTabs,
      forceTimerReconcile: wasPaused
    })
  }

  private openOrGetBuffer(
    kind: DocumentKind,
    filePath: string,
    name: string | undefined,
    content: string,
    windowId?: number
  ): DocumentBuffer {
    const key = getWorkspacePathKey(filePath)
    const existing = this.store.getBuffer(key)
    if (existing) {
      this.registerPendingOpenOwner(existing.key, windowId)
      return { ...existing }
    }

    const created = this.store.openBuffer({
      kind,
      path: filePath,
      name,
      content
    })
    this.registerPendingOpenOwner(created.key, windowId)
    this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    return { ...created }
  }

  private dedupeOpenBuffer(
    key: string,
    loader: () => Promise<DocumentBuffer>
  ): Promise<DocumentBuffer> {
    const inFlight = this.inFlightOpens.get(key)
    if (inFlight) {
      return inFlight
    }

    const openPromise = loader().finally(() => {
      if (this.inFlightOpens.get(key) === openPromise) {
        this.inFlightOpens.delete(key)
      }
    })
    this.inFlightOpens.set(key, openPromise)
    return openPromise
  }

  private async openDedupedBuffer(
    kind: DocumentKind,
    filePath: string,
    name: string | undefined,
    windowId: number | undefined,
    readContent: () => Promise<string>
  ): Promise<DocumentBuffer> {
    const key = getWorkspacePathKey(filePath)
    const existing = this.store.getBuffer(key)
    if (existing) {
      this.registerPendingOpenOwner(existing.key, windowId)
      return { ...existing }
    }

    this.registerPendingOpenOwner(key, windowId)
    try {
      return await this.dedupeOpenBuffer(key, async () => {
        const content = await readContent()
        const latest = this.store.getBuffer(key)
        if (latest) {
          return { ...latest }
        }
        // Skip persisting a newly loaded buffer if every tracked window closed mid-read.
        if (windowId !== undefined && !this.hasActiveOrPendingOwner(key, this.tabCounts)) {
          const tempStore = new DocumentBufferStore()
          return tempStore.openBuffer({ kind, path: filePath, name, content })
        }
        return this.openOrGetBuffer(kind, filePath, name, content)
      })
    } catch (error: unknown) {
      if (!this.store.hasBuffer(key) && windowId !== undefined) {
        this.removePendingOpenOwner(key, windowId)
      }
      throw error
    }
  }

  async openWorkspaceFile(
    filePath: string,
    name?: string,
    initialContent?: string,
    windowId?: number
  ): Promise<DocumentBuffer> {
    const key = getWorkspacePathKey(filePath)
    if (!key) {
      throw new Error('Buffer path must not be empty')
    }

    if (initialContent !== undefined) {
      return this.openOrGetBuffer('workspace', filePath, name, initialContent, windowId)
    }

    return this.openDedupedBuffer('workspace', filePath, name, windowId, () =>
      this.storage.readWorkspaceFile(filePath)
    )
  }

  async openConfigDocument(windowId?: number): Promise<DocumentBuffer> {
    const existingConfig = this.store.getAllBuffers().find((buffer) => buffer.kind === 'config')
    if (existingConfig) {
      this.registerPendingOpenOwner(existingConfig.key, windowId)
      return { ...existingConfig }
    }

    const configPath = await this.storage.getConfigPath()
    return this.openDedupedBuffer('config', configPath, 'config.json', windowId, () =>
      this.storage.readConfigRaw()
    )
  }

  async refreshCleanConfig(): Promise<DocumentBuffer | null> {
    const existing = this.store.getAllBuffers().find((buffer) => buffer.kind === 'config')
    if (!existing || existing.isDirty) {
      return existing ? { ...existing } : null
    }

    const freshRaw = await this.storage.readConfigRaw()
    const latest = this.store.getBuffer(existing.key)
    if (!latest || latest.isDirty) {
      return latest ? { ...latest } : null
    }

    if (this.store.refreshCleanContent(latest.key, freshRaw)) {
      this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    }
    const updated = this.store.getBuffer(latest.key)
    return updated ? { ...updated } : null
  }

  updateContent(pathOrKey: string, nextContent: string): DocumentBuffer | null {
    const resolved = this.store.getBuffer(pathOrKey)
    if (!resolved) return null

    const changed = this.store.updateContent(resolved.key, nextContent)
    const updated = this.store.getBuffer(resolved.key)
    if (!updated) return null

    if (changed) {
      if (!updated.isDirty) {
        this.autoSaveScheduler.clearAttempt(updated.key)
      }
      this.reconcileAutoSaveTimers()
      this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    }

    return { ...updated }
  }

  private executeSave(snapshot: DocumentBuffer): Promise<SaveBufferResult> {
    const existing = this.inFlightSaves.get(snapshot.key)
    if (existing) {
      return existing.promise
    }

    this.store.setSaving(snapshot.key, true)
    this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })

    const entry: InFlightSaveEntry = {
      currentKey: snapshot.key,
      promise: Promise.resolve({ ok: false, buffer: null })
    }

    const run = (async (): Promise<SaveBufferResult> => {
      try {
        if (snapshot.kind === 'config') {
          await this.storage.saveConfigRaw(snapshot.content)
        } else {
          await this.storage.writeWorkspaceFile(snapshot.path, snapshot.content)
        }

        if (this.disposed) {
          return { ok: false, buffer: null }
        }

        const currentBeforeMark = this.store.getBuffer(entry.currentKey)
        this.store.markSaved(entry.currentKey, snapshot.content)
        const savedPath = currentBeforeMark?.path ?? snapshot.path

        if (snapshot.kind === 'workspace') {
          this.emit({
            type: 'workspace-saved',
            key: entry.currentKey,
            path: savedPath
          })
        }
        const afterMark = this.store.getBuffer(entry.currentKey)
        return { ok: true, buffer: afterMark ? { ...afterMark } : null }
      } catch (error: unknown) {
        const message = toErrorMessage(error, '문서 저장에 실패했습니다.')
        this.logError?.('Failed to save shared document buffer', {
          key: entry.currentKey,
          kind: snapshot.kind,
          errorMessage: message
        })
        const current = this.store.getBuffer(entry.currentKey)
        if (!this.disposed) {
          this.emit({
            type: 'save-error',
            key: entry.currentKey,
            kind: snapshot.kind,
            path: current?.path ?? snapshot.path,
            message
          })
        }
        return {
          ok: false,
          buffer: current ? { ...current } : null,
          errorMessage: message
        }
      } finally {
        if (this.inFlightSaves.get(entry.currentKey) === entry) {
          this.inFlightSaves.delete(entry.currentKey)
        }
        this.store.setSaving(entry.currentKey, false)
        if (!this.disposed) {
          this.reconcileAutoSaveTimers()
          this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
        }
      }
    })()

    entry.promise = run
    this.inFlightSaves.set(snapshot.key, entry)
    return run
  }

  async saveBuffer(pathOrKey: string): Promise<SaveBufferResult> {
    let targetKey = this.store.getBuffer(pathOrKey)?.key ?? getWorkspacePathKey(pathOrKey)
    const inFlight = this.inFlightSaves.get(targetKey)
    if (inFlight) {
      const firstResult = await inFlight.promise
      if (!firstResult.ok) return firstResult
      targetKey = inFlight.currentKey
    }

    const latest = this.store.getBuffer(targetKey)
    if (!latest) {
      return { ok: false, buffer: null }
    }
    if (!latest.isDirty) {
      return { ok: true, buffer: { ...latest } }
    }

    return this.executeSave({ ...latest })
  }

  setAutoSaveConfig(config: { autoSave?: boolean; autoSaveDelayMs?: number }): void {
    this.autoSaveScheduler.setConfig(config)
    this.reconcileAutoSaveTimers()
  }

  setAutoSavePaused(windowId: number, paused: boolean): void {
    if (this.autoSaveScheduler.setPaused(windowId, paused)) {
      this.reconcileAutoSaveTimers()
    }
  }

  private remapWindowTabsAndTracking(remappings: readonly BufferKeyRemap[]): void {
    const remapLookup = new Map<string, string>()
    for (const { oldKey, newKey } of remappings) {
      if (oldKey !== newKey) {
        remapLookup.set(oldKey, newKey)
      }
    }
    if (remapLookup.size === 0) return

    for (const perWindow of this.windowTabs.values()) {
      for (const [oldKey, newKey] of remapLookup.entries()) {
        const count = perWindow.get(oldKey)
        if (count !== undefined) {
          perWindow.delete(oldKey)
          perWindow.set(newKey, (perWindow.get(newKey) ?? 0) + count)
        }
      }
    }
    this.tabCounts = this.computeTabCounts()
    this.autoSaveScheduler.remapKeys(remappings)

    for (const [oldKey, newKey] of remapLookup.entries()) {
      const pending = this.pendingOpenWindows.get(oldKey)
      if (pending) {
        this.pendingOpenWindows.delete(oldKey)
        const target = this.pendingOpenWindows.get(newKey) ?? new Set<number>()
        for (const ownerId of pending) {
          target.add(ownerId)
        }
        this.pendingOpenWindows.set(newKey, target)
      }

      const inFlight = this.inFlightSaves.get(oldKey)
      if (inFlight) {
        this.inFlightSaves.delete(oldKey)
        inFlight.currentKey = newKey
        this.inFlightSaves.set(newKey, inFlight)
      }
    }
  }

  syncRenamedPath(oldPath: string, newPath: string): BufferKeyRemap[] {
    const remappings = this.store.syncRenamedPath(oldPath, newPath)
    if (remappings.length === 0) return []

    this.remapWindowTabsAndTracking(remappings)
    this.reconcileAutoSaveTimers()
    this.emit({
      type: 'paths-remapped',
      snapshot: this.getSnapshot(),
      remappings
    })
    return remappings
  }

  private closeRemovedKeys(removedKeys: string[]): string[] {
    if (removedKeys.length === 0) return []
    const removedSet = new Set(removedKeys)
    this.cleanupTrackingForKeys(removedKeys)
    this.pruneAndRemoveTabReferences(removedSet)
    this.reconcileAutoSaveTimers()
    this.emit({
      type: 'buffers-closed',
      snapshot: this.getSnapshot(),
      closedKeys: removedKeys
    })
    return removedKeys
  }

  syncDeletedPath(targetPath: string): string[] {
    const removedKeys = this.store.removeBuffersUnderPath(targetPath)
    return this.closeRemovedKeys(removedKeys)
  }

  async reconcileWorkspaceBuffersWithDisk(): Promise<ReconcileBuffersResult> {
    const openWorkspaceBuffers = this.store
      .getAllBuffers()
      .filter((buffer) => buffer.kind === 'workspace')
    if (openWorkspaceBuffers.length === 0) {
      return { warnings: [], closedKeys: [] }
    }

    const conflictNames: string[] = []
    const missingDirtyNames: string[] = []
    const cleanMissingKeys: string[] = []
    let refreshedClean = false

    await Promise.all(
      openWorkspaceBuffers.map(async (buffer) => {
        const latest = this.store.getBuffer(buffer.key)
        if (!latest || latest.kind !== 'workspace') return
        if (latest.isSaving || this.inFlightSaves.has(latest.key)) return

        try {
          const diskContent = await this.storage.readWorkspaceFile(latest.path)
          if (this.disposed) return

          const current = this.store.getBuffer(latest.key)
          if (!current || current.kind !== 'workspace') return
          if (current.isSaving || this.inFlightSaves.has(current.key)) return

          if (!current.isDirty) {
            this.autoSaveScheduler.clearTimer(current.key)
            if (this.store.refreshCleanContent(current.key, diskContent)) {
              refreshedClean = true
            }
          } else if (diskContent !== current.savedContent) {
            conflictNames.push(current.name)
          }
        } catch (error: unknown) {
          if (this.disposed) return
          const current = this.store.getBuffer(latest.key)
          if (!current || current.kind !== 'workspace') return
          if (!isMissingWorkspaceFileError(error)) return

          if (!current.isDirty) {
            cleanMissingKeys.push(current.key)
          } else {
            missingDirtyNames.push(current.name)
          }
        }
      })
    )

    const closedKeys: string[] = []
    for (const missingKey of cleanMissingKeys) {
      if (this.store.removeBuffer(missingKey)) {
        closedKeys.push(missingKey)
      }
    }

    if (closedKeys.length > 0) {
      this.closeRemovedKeys(closedKeys)
    } else if (refreshedClean) {
      this.emit({
        type: 'state-changed',
        snapshot: this.getSnapshot()
      })
    }

    const warnings: string[] = []
    if (conflictNames.length > 0) {
      warnings.push(
        `외부 변경과 미저장 편집 내용이 충돌할 수 있습니다 (${conflictNames.join(', ')}).`
      )
    }
    if (missingDirtyNames.length > 0) {
      warnings.push(
        `외부 변경으로 삭제되었으나 미저장 편집 내용이 남아 있습니다 (${missingDirtyNames.join(', ')}).`
      )
    }

    return { warnings, closedKeys }
  }

  dispose(): void {
    this.disposed = true
    this.autoSaveScheduler.dispose()
    this.listeners.clear()
    this.windowTabs.clear()
    this.pendingOpenWindows.clear()
    this.inFlightOpens.clear()
    this.inFlightSaves.clear()
  }
}
