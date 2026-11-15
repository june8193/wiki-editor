import { type AutoSaveConfig, BufferAutoSaveScheduler } from './bufferAutoSaveScheduler'
import {
  type BufferKeyRemap,
  type DocumentBuffer,
  isMissingWorkspaceFileError,
  type OpenBufferInput,
  type ReconcileBuffersResult,
  type SaveBufferResult,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot,
  type SyncWindowTabsOptions
} from './documentBuffer'
import { createDocumentBuffer, DocumentBufferStore } from './documentBufferStore'
import { toErrorMessage } from './errors'
import { WindowTabTracker } from './windowTabTracker'
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
  initialAutoSaveConfig?: AutoSaveConfig
  logError?: (message: string, details?: Record<string, unknown>) => void
}

interface InFlightSaveEntry {
  currentKey: string
  promise: Promise<SaveBufferResult>
}

/**
 * Single authoritative coordinator for document buffers shared across windows.
 * Owns canonical DocumentBuffer state, per-window tab reference counting delegation,
 * path rename/delete synchronization, and disk reconciliation.
 */
export class SharedDocumentBufferHub {
  private readonly store = new DocumentBufferStore()
  private readonly tabTracker = new WindowTabTracker()
  private readonly listeners = new Set<(event: SharedBufferHubEvent) => void>()
  private readonly inFlightOpens = new Map<string, Promise<DocumentBuffer>>()
  private readonly inFlightSaves = new Map<string, InFlightSaveEntry>()
  private readonly autoSaveScheduler: BufferAutoSaveScheduler
  private readonly storage: SharedDocumentBufferStorage
  private readonly logError?: (message: string, details?: Record<string, unknown>) => void

  private revision = 0
  private disposed = false

  constructor(options: SharedDocumentBufferHubOptions) {
    this.storage = options.storage
    this.autoSaveScheduler = new BufferAutoSaveScheduler({
      initialConfig: options.initialAutoSaveConfig
    })
    this.logError = options.logError
  }

  subscribe(listener: (event: SharedBufferHubEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(windowId?: number): SharedBufferStateSnapshot {
    return {
      buffers: this.store.getSnapshot(),
      tabCounts: this.tabTracker.getTabCountsSnapshot(),
      windowTabCounts: this.tabTracker.getWindowTabCountsSnapshot(),
      revision: this.revision,
      ...(windowId !== undefined ? { windowId } : {})
    }
  }

  private emit(event: SharedBufferHubEvent): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private emitStateChanged(): void {
    this.revision += 1
    this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
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
    this.tabTracker.clearPendingForKeys(keyList)
  }

  private removeOrphanedBuffers(
    prevCounts: Readonly<Record<string, number>>,
    extraCandidateKeys: Iterable<string> = []
  ): boolean {
    const orphanKeys = this.tabTracker.collectOrphanKeys(prevCounts, extraCandidateKeys)
    if (orphanKeys.length === 0) {
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
    countsChanged: boolean,
    extraCandidateKeys: Iterable<string> = [],
    forceTimerReconcile = false
  ): void {
    const removedAnyBuffer = this.removeOrphanedBuffers(prevCounts, extraCandidateKeys)
    if (forceTimerReconcile || removedAnyBuffer) {
      this.reconcileAutoSaveTimers()
    }
    if (removedAnyBuffer || countsChanged) {
      this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    }
  }

  syncWindowTabs(
    windowId: number,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ): SharedBufferStateSnapshot {
    const { prevCounts, depletedPendingKeys, countsChanged } = this.tabTracker.syncWindowTabs(
      windowId,
      bufferKeys,
      options
    )
    this.revision += 1
    this.reconcileTabCountChanges(prevCounts, countsChanged, depletedPendingKeys)
    return this.getSnapshot(windowId)
  }

  unregisterWindow(windowId: number): void {
    const wasPaused = this.autoSaveScheduler.removePausedWindow(windowId)
    const { prevCounts, depletedPendingKeys, countsChanged } =
      this.tabTracker.unregisterWindow(windowId)
    this.revision += 1
    this.reconcileTabCountChanges(prevCounts, countsChanged, depletedPendingKeys, wasPaused)
  }

  private claimExistingBuffer(existing: DocumentBuffer, windowId?: number): DocumentBuffer {
    this.tabTracker.registerPendingOpenOwner(existing.key, windowId)
    return { ...existing }
  }

  private createBuffer(input: OpenBufferInput, windowId?: number): DocumentBuffer {
    const existing = this.store.getBuffer(getWorkspacePathKey(input.path))
    if (existing) {
      return this.claimExistingBuffer(existing, windowId)
    }

    const created = this.store.openBuffer(input)
    this.tabTracker.registerPendingOpenOwner(created.key, windowId)
    this.emitStateChanged()
    return { ...created }
  }

  private async loadAndOpenBuffer(
    input: Omit<OpenBufferInput, 'content'>,
    windowId: number | undefined,
    readContent: () => Promise<string>
  ): Promise<DocumentBuffer> {
    const key = getWorkspacePathKey(input.path)
    this.tabTracker.registerPendingOpenOwner(key, windowId)
    try {
      let openPromise = this.inFlightOpens.get(key)
      if (!openPromise) {
        openPromise = (async () => {
          const content = await readContent()
          const latest = this.store.getBuffer(key)
          if (latest) {
            return { ...latest }
          }
          // Skip persisting a newly loaded buffer if every tracked window closed mid-read.
          if (windowId !== undefined && !this.tabTracker.hasActiveOrPendingOwner(key)) {
            return createDocumentBuffer({ ...input, content })
          }
          return this.createBuffer({ ...input, content })
        })().finally(() => {
          if (this.inFlightOpens.get(key) === openPromise) {
            this.inFlightOpens.delete(key)
          }
        })
        this.inFlightOpens.set(key, openPromise)
      }
      return await openPromise
    } catch (error: unknown) {
      if (!this.store.hasBuffer(key) && windowId !== undefined) {
        this.tabTracker.removePendingOpenOwner(key, windowId)
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

    const existing = this.store.getBuffer(key)
    if (existing) {
      return this.claimExistingBuffer(existing, windowId)
    }

    if (initialContent !== undefined) {
      return this.createBuffer(
        { kind: 'workspace', path: filePath, name, content: initialContent },
        windowId
      )
    }

    return this.loadAndOpenBuffer({ kind: 'workspace', path: filePath, name }, windowId, () =>
      this.storage.readWorkspaceFile(filePath)
    )
  }

  async openConfigDocument(windowId?: number): Promise<DocumentBuffer> {
    const existingConfig = this.store.getConfigBuffer()
    if (existingConfig) {
      return this.claimExistingBuffer(existingConfig, windowId)
    }

    const configPath = await this.storage.getConfigPath()
    const existingByPath = this.store.getBuffer(getWorkspacePathKey(configPath))
    if (existingByPath) {
      return this.claimExistingBuffer(existingByPath, windowId)
    }

    return this.loadAndOpenBuffer(
      { kind: 'config', path: configPath, name: 'config.json' },
      windowId,
      () => this.storage.readConfigRaw()
    )
  }

  async refreshCleanConfig(): Promise<DocumentBuffer | null> {
    const existing = this.store.getConfigBuffer()
    if (!existing || existing.isDirty) {
      return existing ? { ...existing } : null
    }

    const freshRaw = await this.storage.readConfigRaw()
    const latest = this.store.getBuffer(existing.key)
    if (!latest || latest.isDirty) {
      return latest ? { ...latest } : null
    }

    if (this.store.refreshCleanContent(latest.key, freshRaw)) {
      this.emitStateChanged()
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
      this.emitStateChanged()
    }

    return { ...updated }
  }

  private executeSave(snapshot: DocumentBuffer): Promise<SaveBufferResult> {
    const existing = this.inFlightSaves.get(snapshot.key)
    if (existing) {
      return existing.promise
    }

    this.store.setSaving(snapshot.key, true)
    this.emitStateChanged()

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
          this.emitStateChanged()
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

  setAutoSaveConfig(config: AutoSaveConfig): void {
    this.autoSaveScheduler.setConfig(config)
    this.reconcileAutoSaveTimers()
  }

  setAutoSavePaused(windowId: number, paused: boolean): void {
    if (this.autoSaveScheduler.setPaused(windowId, paused)) {
      this.reconcileAutoSaveTimers()
    }
  }

  private remapWindowTabsAndTracking(remappings: readonly BufferKeyRemap[]): void {
    this.tabTracker.remapKeys(remappings)
    this.autoSaveScheduler.remapKeys(remappings)

    for (const { oldKey, newKey } of remappings) {
      if (oldKey === newKey) continue
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
    this.revision += 1
    this.emit({
      type: 'paths-remapped',
      snapshot: this.getSnapshot(),
      remappings
    })
    return remappings
  }

  private closeRemovedKeys(removedKeys: string[]): string[] {
    if (removedKeys.length === 0) return []
    this.cleanupTrackingForKeys(removedKeys)
    this.tabTracker.pruneKeys(new Set(removedKeys))
    this.reconcileAutoSaveTimers()
    this.revision += 1
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
      this.emitStateChanged()
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
    this.tabTracker.clear()
    this.inFlightOpens.clear()
    this.inFlightSaves.clear()
  }
}
