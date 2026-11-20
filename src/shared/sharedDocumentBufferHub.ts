import { isSupportedImageFile } from './assets'
import { type AutoSaveConfig, BufferAutoSaveScheduler } from './bufferAutoSaveScheduler'
import {
  buildRemappedPath,
  type BufferKeyRemap,
  type DocumentBuffer,
  isKeyNestedOrSame,
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
import type { WindowRole } from './window'
import { type TabCountChange, WindowTabTracker } from './windowTabTracker'
import {
  getParentDirectory,
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  isSameWorkspacePath,
  isWorkspaceChangeAffectingPath,
  type WorkspaceChangeEvent,
  type WorkspaceEntry
} from './workspace'

type TextOpenBufferInput = Extract<OpenBufferInput, { content: string }>

export interface SharedDocumentBufferStorage {
  readWorkspaceFile: (filePath: string) => Promise<string>
  writeWorkspaceFile: (filePath: string, content: string) => Promise<void>
  readWorkspaceDirectory?: (dirPath: string) => Promise<WorkspaceEntry[]>
  getConfigPath: () => Promise<string>
  readConfigRaw: () => Promise<string>
  saveConfigRaw: (raw: string) => Promise<unknown>
}

export interface SharedDocumentBufferHubOptions {
  storage: SharedDocumentBufferStorage
  initialAutoSaveConfig?: AutoSaveConfig
  logError?: (message: string, details?: Record<string, unknown>) => void
}

interface InFlightOpenEntry {
  currentInput: Omit<TextOpenBufferInput, 'content'>
  currentKey: string
  deleted?: boolean
  promise: Promise<DocumentBuffer>
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
  private readonly inFlightOpens = new Map<string, InFlightOpenEntry>()
  private readonly inFlightSaves = new Map<string, InFlightSaveEntry>()
  private readonly discardingRefCounts = new Map<string, number>()
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

  hasBuffer(pathOrKey: string): boolean {
    return this.store.getBuffer(pathOrKey) !== undefined
  }

  getBuffer(pathOrKey: string): DocumentBuffer | undefined {
    const buffer = this.store.getBuffer(pathOrKey)
    return buffer ? { ...buffer } : undefined
  }

  getBufferName(pathOrKey: string): string | undefined {
    return this.store.getBuffer(pathOrKey)?.name
  }

  getWindowTabCount(windowId: number): number {
    return this.tabTracker.getWindowTotalTabCount(windowId)
  }

  /** Returns whether any open workspace or config buffer currently has unsaved changes. */
  hasAnyDirtyBuffer(): boolean {
    return this.store.getDirtyBuffers().length > 0
  }

  /**
   * Returns dirty buffers whose last cross-window reference (tab or pending claim) would drop to 0
   * if `windowId` closed.
   */
  getDirtyBuffersLostOnWindowClose(windowId: number): DocumentBuffer[] {
    return this.store
      .getDirtyBuffers()
      .filter(
        (buffer) =>
          this.tabTracker.getWindowBufferTabCount(windowId, buffer.key) > 0 &&
          !this.tabTracker.hasOtherWindowReference(buffer.key, windowId)
      )
      .map((buffer) => ({ ...buffer }))
  }

  /** Returns whether closing a window of `role` requires an unsaved-changes close confirmation. */
  hasDirtyBuffersForWindowClose(role: WindowRole, windowId: number): boolean {
    return role === 'main'
      ? this.hasAnyDirtyBuffer()
      : this.getDirtyBuffersLostOnWindowClose(windowId).length > 0
  }

  registerPendingTransfer(windowId: number, pathOrKey: string): void {
    const resolvedKey = this.store.getBuffer(pathOrKey)?.key ?? pathOrKey
    this.tabTracker.registerPendingTransferOwner(resolvedKey, windowId)
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

  private isKeyDiscarding(key: string): boolean {
    return (this.discardingRefCounts.get(key) ?? 0) > 0
  }

  private normalizeTargetPathKeys(targetPaths: readonly string[]): string[] {
    const unique = new Set<string>()
    for (const targetPath of targetPaths) {
      const key = getWorkspacePathKey(targetPath)
      if (key) {
        unique.add(key)
      }
    }
    return [...unique]
  }

  private reconcileAutoSaveTimers(): void {
    if (this.disposed) return
    this.autoSaveScheduler.reconcile({
      buffers: this.store.getSnapshot(),
      isSaveInFlight: (key) => this.inFlightSaves.has(key),
      isSuppressed: (key) => this.isKeyDiscarding(key),
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
    change: TabCountChange,
    forceTimerReconcile = false
  ): void {
    const removedAnyBuffer = this.removeOrphanedBuffers(
      change.prevCounts,
      change.depletedPendingKeys
    )
    if (forceTimerReconcile || removedAnyBuffer) {
      this.reconcileAutoSaveTimers()
    }
    if (removedAnyBuffer || change.countsChanged) {
      this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    }
  }

  syncWindowTabs(
    windowId: number,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ): SharedBufferStateSnapshot {
    const change = this.tabTracker.syncWindowTabs(windowId, bufferKeys, options)
    this.revision += 1
    this.reconcileTabCountChanges(change)
    return this.getSnapshot(windowId)
  }

  unregisterWindow(windowId: number): void {
    const wasPaused = this.autoSaveScheduler.removePausedWindow(windowId)
    const change = this.tabTracker.unregisterWindow(windowId)
    this.revision += 1
    this.reconcileTabCountChanges(change, wasPaused)
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
    input: Omit<TextOpenBufferInput, 'content'>,
    windowId: number | undefined,
    readContent: () => Promise<string>
  ): Promise<DocumentBuffer> {
    const initialKey = getWorkspacePathKey(input.path)
    this.tabTracker.registerPendingOpenOwner(initialKey, windowId)
    let entry = this.inFlightOpens.get(initialKey)
    try {
      if (!entry) {
        const createdEntry: InFlightOpenEntry = {
          currentInput: input,
          currentKey: initialKey,
          promise: Promise.resolve({} as DocumentBuffer)
        }
        createdEntry.promise = (async () => {
          const content = await readContent()
          const latestKey = createdEntry.currentKey
          const latestInput = createdEntry.currentInput
          const latest = this.store.getBuffer(latestKey)
          if (latest) {
            return { ...latest }
          }
          // Skip persisting a newly loaded buffer if deleted or every window closed mid-read.
          if (
            createdEntry.deleted ||
            (windowId !== undefined && !this.tabTracker.hasActiveOrPendingOwner(latestKey))
          ) {
            return createDocumentBuffer({ ...latestInput, content })
          }
          return this.createBuffer({ ...latestInput, content })
        })().finally(() => {
          if (this.inFlightOpens.get(createdEntry.currentKey) === createdEntry) {
            this.inFlightOpens.delete(createdEntry.currentKey)
          }
        })
        entry = createdEntry
        this.inFlightOpens.set(initialKey, entry)
      }
      return await entry.promise
    } catch (error: unknown) {
      const targetKey = entry?.currentKey ?? initialKey
      if (!this.store.hasBuffer(targetKey) && windowId !== undefined) {
        this.tabTracker.removePendingOpenOwner(targetKey, windowId)
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

    if (isSupportedImageFile(filePath)) {
      return this.createBuffer(
        { kind: 'workspace', contentKind: 'image', path: filePath, name },
        windowId
      )
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

  private async refreshCleanBufferFromStorage(
    getBuffer: () => DocumentBuffer | undefined,
    readRaw: (buffer: DocumentBuffer) => Promise<string>
  ): Promise<DocumentBuffer | null> {
    const existing = getBuffer()
    if (!existing || existing.isDirty) {
      return existing ? { ...existing } : null
    }

    const freshRaw = await readRaw(existing)
    if (this.disposed) {
      return null
    }
    const latest = getBuffer()
    if (!latest || latest.isDirty || latest.key !== existing.key) {
      return latest ? { ...latest } : null
    }

    if (this.store.refreshCleanContent(latest.key, freshRaw)) {
      this.emitStateChanged()
    }
    const updated = this.store.getBuffer(latest.key)
    return updated ? { ...updated } : null
  }

  private getReconcilableWorkspaceTextBuffer(filePath: string): DocumentBuffer | undefined {
    const key = getWorkspacePathKey(filePath)
    if (!key) return undefined
    const buffer = this.getReconcilableWorkspaceBuffer(key)
    return buffer && buffer.contentKind !== 'image' ? buffer : undefined
  }

  async refreshCleanConfig(): Promise<DocumentBuffer | null> {
    return this.refreshCleanBufferFromStorage(
      () => this.store.getConfigBuffer(),
      () => this.storage.readConfigRaw()
    )
  }

  /**
   * Re-reads a single open, clean workspace text buffer from disk without touching unrelated text or image tabs.
   */
  async refreshCleanWorkspaceFile(filePath: string): Promise<DocumentBuffer | null> {
    return this.refreshCleanBufferFromStorage(
      () => this.getReconcilableWorkspaceTextBuffer(filePath),
      (buffer) => this.storage.readWorkspaceFile(buffer.path)
    )
  }

  updateContent(pathOrKey: string, nextContent: string): DocumentBuffer | null {
    const resolved = this.store.getBuffer(pathOrKey)
    if (!resolved) return null
    if (this.isKeyDiscarding(resolved.key)) {
      return { ...resolved }
    }

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
    if (latest.contentKind === 'image' || !latest.isDirty) {
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

  private remapInFlightOpens(
    oldPath: string,
    newPath: string,
    combinedRemappings: BufferKeyRemap[]
  ): void {
    const oldPrefixKey = getWorkspacePathKey(oldPath)
    const newPrefixKey = getWorkspacePathKey(newPath)
    if (!oldPrefixKey || !newPrefixKey || oldPrefixKey === newPrefixKey) return

    const seenOldKeys = new Set(combinedRemappings.map((r) => r.oldKey))
    for (const [entryKey, entry] of [...this.inFlightOpens.entries()]) {
      if (entry.currentInput.kind !== 'workspace' || !isKeyNestedOrSame(entryKey, oldPrefixKey)) {
        continue
      }

      const nextPath = buildRemappedPath(entry.currentInput.path, oldPath, newPath)
      const nextKey = getWorkspacePathKey(nextPath)
      if (!nextKey || nextKey === entryKey) continue

      this.inFlightOpens.delete(entryKey)
      entry.currentInput = {
        ...entry.currentInput,
        path: nextPath,
        name:
          entryKey === oldPrefixKey
            ? getWorkspaceDisplayName(nextPath)
            : entry.currentInput.name
      }
      entry.currentKey = nextKey
      if (!this.inFlightOpens.has(nextKey)) {
        this.inFlightOpens.set(nextKey, entry)
      }
      if (!seenOldKeys.has(entryKey)) {
        seenOldKeys.add(entryKey)
        combinedRemappings.push({ oldKey: entryKey, newKey: nextKey })
      }
    }
  }

  syncRenamedPath(oldPath: string, newPath: string): BufferKeyRemap[] {
    const remappings = this.store.syncRenamedPath(oldPath, newPath)
    this.remapInFlightOpens(oldPath, newPath, remappings)
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

  private cancelInFlightOpens(
    removedKeys: string[],
    predicate: (entryKey: string, entry: InFlightOpenEntry) => boolean
  ): void {
    for (const [entryKey, entry] of this.inFlightOpens.entries()) {
      if (predicate(entryKey, entry)) {
        entry.deleted = true
        if (!removedKeys.includes(entryKey)) {
          removedKeys.push(entryKey)
        }
      }
    }
  }

  syncDeletedPath(targetPath: string): string[] {
    const removedKeys = this.store.removeBuffersUnderPath(targetPath)
    const targetPrefixKey = getWorkspacePathKey(targetPath)
    if (targetPrefixKey) {
      this.cancelInFlightOpens(
        removedKeys,
        (entryKey, entry) =>
          entry.currentInput.kind === 'workspace' && isKeyNestedOrSame(entryKey, targetPrefixKey)
      )
    }
    return this.closeRemovedKeys(removedKeys)
  }

  /** Closes all open workspace buffers and cancels in-flight workspace loads while keeping config open. */
  clearWorkspaceBuffers(): string[] {
    const removedKeys = this.store.clearWorkspaceBuffers()
    this.cancelInFlightOpens(
      removedKeys,
      (_entryKey, entry) => entry.currentInput.kind === 'workspace'
    )
    return this.closeRemovedKeys(removedKeys)
  }

  private getReconcilableWorkspaceBuffer(key: string): DocumentBuffer | undefined {
    const current = this.store.getBuffer(key)
    if (!current || current.kind !== 'workspace') return undefined
    if (current.isSaving || this.inFlightSaves.has(current.key) || this.isKeyDiscarding(current.key)) {
      return undefined
    }
    return current
  }

  private async resolveImageBufferExistence(
    imageBuffers: readonly DocumentBuffer[]
  ): Promise<Map<string, 'exists' | 'missing' | 'error'>> {
    const existenceByKey = new Map<string, 'exists' | 'missing' | 'error'>()
    if (imageBuffers.length === 0) {
      return existenceByKey
    }
    if (!this.storage.readWorkspaceDirectory) {
      for (const buffer of imageBuffers) {
        existenceByKey.set(buffer.key, 'exists')
      }
      return existenceByKey
    }

    const readDir = this.storage.readWorkspaceDirectory
    const parentDirByKey = new Map<string, string>()
    for (const buffer of imageBuffers) {
      const parentDir = getParentDirectory(buffer.path)
      const parentKey = getWorkspacePathKey(parentDir)
      if (!parentDirByKey.has(parentKey)) {
        parentDirByKey.set(parentKey, parentDir)
      }
    }

    type ImageParentDirResult =
      | { status: 'ok'; entries: readonly WorkspaceEntry[] }
      | { status: 'missing' }
      | { status: 'error' }

    const dirResults = new Map<string, ImageParentDirResult>()
    await Promise.all(
      [...parentDirByKey.entries()].map(async ([parentKey, parentDir]) => {
        try {
          const entries = await readDir(parentDir)
          dirResults.set(parentKey, { status: 'ok', entries })
        } catch (error: unknown) {
          dirResults.set(
            parentKey,
            isMissingWorkspaceFileError(error) ? { status: 'missing' } : { status: 'error' }
          )
        }
      })
    )

    for (const buffer of imageBuffers) {
      const parentKey = getWorkspacePathKey(getParentDirectory(buffer.path))
      const dirResult = dirResults.get(parentKey)
      if (!dirResult || dirResult.status === 'error') {
        existenceByKey.set(buffer.key, 'error')
      } else if (dirResult.status === 'missing') {
        existenceByKey.set(buffer.key, 'missing')
      } else {
        const exists = dirResult.entries.some(
          (entry) => entry.kind === 'file' && isSameWorkspacePath(entry.path, buffer.path)
        )
        existenceByKey.set(buffer.key, exists ? 'exists' : 'missing')
      }
    }
    return existenceByKey
  }

  /**
   * Cancels pending auto-saves/opens and awaits in-flight saves for target workspace paths before Git discard.
   */
  async prepareWorkspacePathsForDiscard(targetPaths: readonly string[]): Promise<void> {
    const targetKeys = this.normalizeTargetPathKeys(targetPaths)
    if (targetKeys.length === 0) return

    for (const key of targetKeys) {
      this.discardingRefCounts.set(key, (this.discardingRefCounts.get(key) ?? 0) + 1)
    }
    const targetKeySet = new Set(targetKeys)
    this.autoSaveScheduler.clearForKeys(targetKeys)
    this.cancelInFlightOpens(
      [],
      (entryKey, entry) => entry.currentInput.kind === 'workspace' && targetKeySet.has(entryKey)
    )

    const inFlightSavePromises: Array<Promise<unknown>> = []
    for (const key of targetKeys) {
      const inFlight = this.inFlightSaves.get(key)
      if (inFlight) {
        inFlightSavePromises.push(inFlight.promise.catch(() => undefined))
      }
    }
    if (inFlightSavePromises.length > 0) {
      await Promise.all(inFlightSavePromises)
    }
  }

  /**
   * Releases the discard lock for target paths and, when `forceSync` is true, forcibly resets open
   * buffers to disk content (`isDirty: false`) or closes tabs for files removed on disk.
   */
  async finishWorkspacePathsDiscard(
    targetPaths: readonly string[],
    forceSync: boolean
  ): Promise<string[]> {
    const targetKeys = this.normalizeTargetPathKeys(targetPaths)
    if (targetKeys.length === 0) return []

    let released = false
    const ensureReleased = (): void => {
      if (released) return
      released = true
      for (const key of targetKeys) {
        const count = this.discardingRefCounts.get(key) ?? 0
        if (count <= 1) {
          this.discardingRefCounts.delete(key)
        } else {
          this.discardingRefCounts.set(key, count - 1)
        }
      }
    }

    try {
      if (!forceSync || this.disposed) {
        ensureReleased()
        return []
      }

      const targetKeySet = new Set(targetKeys)
      const matchingBuffers = this.store
        .getAllBuffers()
        .filter((buffer) => buffer.kind === 'workspace' && targetKeySet.has(buffer.key))

      const closedKeys: string[] = []
      const syncedKeys: string[] = []

      this.cancelInFlightOpens(
        [],
        (entryKey, entry) => entry.currentInput.kind === 'workspace' && targetKeySet.has(entryKey)
      )

      const textBuffers = matchingBuffers.filter((buffer) => buffer.contentKind !== 'image')
      const imageBuffers = matchingBuffers.filter((buffer) => buffer.contentKind === 'image')

      await Promise.all([
        Promise.all(
          textBuffers.map(async (buffer) => {
            try {
              const diskContent = await this.storage.readWorkspaceFile(buffer.path)
              if (this.disposed) return
              const current = this.store.getBuffer(buffer.key)
              if (!current || current.kind !== 'workspace' || current.contentKind === 'image') {
                return
              }
              this.store.forceSyncContent(current.key, diskContent)
              syncedKeys.push(current.key)
            } catch (error: unknown) {
              if (this.disposed || !isMissingWorkspaceFileError(error)) return
              if (this.store.removeBuffer(buffer.key)) {
                closedKeys.push(buffer.key)
              }
            }
          })
        ),
        (async () => {
          if (imageBuffers.length === 0) return
          const imageExistence = await this.resolveImageBufferExistence(imageBuffers)
          if (this.disposed) return
          for (const buffer of imageBuffers) {
            const status = imageExistence.get(buffer.key) ?? 'exists'
            if (status === 'missing') {
              if (this.store.removeBuffer(buffer.key)) {
                closedKeys.push(buffer.key)
              }
            } else if (status === 'exists') {
              this.store.refreshImageAsset(buffer.key)
              syncedKeys.push(buffer.key)
            }
          }
        })()
      ])

      if (this.disposed) {
        ensureReleased()
        return []
      }

      this.autoSaveScheduler.clearForKeys(targetKeys)
      ensureReleased()

      if (closedKeys.length > 0) {
        this.closeRemovedKeys(closedKeys)
      }
      if (syncedKeys.length > 0) {
        this.revision += 1
        this.emit({
          type: 'buffers-force-synced',
          snapshot: this.getSnapshot(),
          syncedKeys
        })
      }

      return closedKeys
    } finally {
      ensureReleased()
      if (!this.disposed) {
        this.reconcileAutoSaveTimers()
      }
    }
  }

  async reconcileWorkspaceBuffersWithDisk(
    changeEvent?: WorkspaceChangeEvent
  ): Promise<ReconcileBuffersResult> {
    const openWorkspaceBuffers = this.store
      .getAllBuffers()
      .filter((buffer) => buffer.kind === 'workspace')
    if (openWorkspaceBuffers.length === 0) {
      return { warnings: [], closedKeys: [] }
    }

    const textBuffers = openWorkspaceBuffers.filter((buffer) => buffer.contentKind !== 'image')
    const imageBuffers = openWorkspaceBuffers.filter((buffer) => buffer.contentKind === 'image')

    const conflictNames: string[] = []
    const missingDirtyNames: string[] = []
    const cleanMissingKeys: string[] = []
    let refreshedClean = false

    const reconcileTextTask = Promise.all(
      textBuffers.map(async (buffer) => {
        const latest = this.getReconcilableWorkspaceBuffer(buffer.key)
        if (!latest || latest.contentKind === 'image') return

        try {
          const diskContent = await this.storage.readWorkspaceFile(latest.path)
          if (this.disposed) return

          const current = this.getReconcilableWorkspaceBuffer(latest.key)
          if (!current || current.contentKind === 'image') return

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
          const current = this.getReconcilableWorkspaceBuffer(latest.key)
          if (!current || current.contentKind === 'image') return
          if (!isMissingWorkspaceFileError(error)) return

          if (!current.isDirty) {
            cleanMissingKeys.push(current.key)
          } else {
            missingDirtyNames.push(current.name)
          }
        }
      })
    )

    const reconcileImageTask =
      imageBuffers.length === 0 || !this.storage.readWorkspaceDirectory
        ? Promise.resolve()
        : (async () => {
            const imageExistence = await this.resolveImageBufferExistence(imageBuffers)
            if (this.disposed) return
            for (const buffer of imageBuffers) {
              const current = this.getReconcilableWorkspaceBuffer(buffer.key)
              if (!current || current.contentKind !== 'image') continue

              const status = imageExistence.get(current.key)
              if (!status || status === 'error') continue
              if (status === 'missing') {
                cleanMissingKeys.push(current.key)
              } else if (
                isWorkspaceChangeAffectingPath(current.path, changeEvent) &&
                this.store.refreshImageAsset(current.key)
              ) {
                refreshedClean = true
              }
            }
          })()

    await Promise.all([reconcileTextTask, reconcileImageTask])

    const closedKeys: string[] = []
    for (const missingKey of cleanMissingKeys) {
      const current = this.getReconcilableWorkspaceBuffer(missingKey)
      if (!current) continue
      if (current.isDirty) {
        if (!missingDirtyNames.includes(current.name)) {
          missingDirtyNames.push(current.name)
        }
        continue
      }
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
    this.discardingRefCounts.clear()
  }
}
