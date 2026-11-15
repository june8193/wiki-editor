import { DEFAULT_APP_CONFIG } from './config'
import {
  type BufferKeyRemap,
  type DocumentBuffer,
  isMissingWorkspaceFileError,
  type ReconcileBuffersResult,
  type SaveBufferResult,
  type SharedBufferHubEvent,
  type SharedBufferStateSnapshot,
  toErrorMessage
} from './documentBuffer'
import { DocumentBufferStore } from './documentBufferStore'
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

interface AutoSaveTimerEntry {
  version: number
  timerId: ReturnType<typeof setTimeout>
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
 * Owns canonical DocumentBuffer state, per-window tab reference counting, unified debounced auto-save,
 * path rename/delete synchronization, and disk reconciliation.
 */
export class SharedDocumentBufferHub {
  private readonly store = new DocumentBufferStore()
  private readonly listeners = new Set<(event: SharedBufferHubEvent) => void>()
  private readonly windowTabs = new Map<number, Map<string, number>>()
  private readonly unregisteredOpenOwners = new Map<string, number>()
  private readonly inFlightOpens = new Map<string, Promise<DocumentBuffer>>()
  private readonly inFlightSaves = new Map<string, InFlightSaveEntry>()
  private readonly autoSaveTimers = new Map<string, AutoSaveTimerEntry>()
  private readonly lastAutoSaveAttemptVersion = new Map<string, number>()
  private readonly pausedWindows = new Set<number>()
  private readonly storage: SharedDocumentBufferStorage
  private readonly logError?: (message: string, details?: Record<string, unknown>) => void

  private tabCounts: Record<string, number> = {}
  private autoSave: boolean
  private autoSaveDelayMs: number
  private disposed = false

  constructor(options: SharedDocumentBufferHubOptions) {
    this.storage = options.storage
    this.autoSave = options.initialAutoSave ?? DEFAULT_APP_CONFIG.autoSave
    this.autoSaveDelayMs = options.initialAutoSaveDelayMs ?? DEFAULT_APP_CONFIG.autoSaveDelayMs
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

  private clearTimerForKey(key: string): void {
    const existing = this.autoSaveTimers.get(key)
    if (existing) {
      clearTimeout(existing.timerId)
      this.autoSaveTimers.delete(key)
    }
  }

  private clearAllTimers(): void {
    for (const entry of this.autoSaveTimers.values()) {
      clearTimeout(entry.timerId)
    }
    this.autoSaveTimers.clear()
  }

  private cleanupTrackingForKeys(keys: Iterable<string>): void {
    for (const key of keys) {
      this.clearTimerForKey(key)
      this.lastAutoSaveAttemptVersion.delete(key)
      this.unregisteredOpenOwners.delete(key)
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

  syncWindowTabs(windowId: number, bufferKeys: readonly string[]): SharedBufferStateSnapshot {
    const perWindow = new Map<string, number>()
    for (const key of bufferKeys) {
      if (!key) continue
      perWindow.set(key, (perWindow.get(key) ?? 0) + 1)
      this.unregisteredOpenOwners.delete(key)
    }

    const prevCounts = this.tabCounts
    this.windowTabs.set(windowId, perWindow)
    const nextCounts = this.computeTabCounts()

    let removedAnyBuffer = false
    for (const [key, prevCount] of Object.entries(prevCounts)) {
      if (prevCount > 0 && (nextCounts[key] ?? 0) === 0) {
        if (this.store.removeBuffer(key)) {
          removedAnyBuffer = true
        }
        this.cleanupTrackingForKeys([key])
      }
    }

    const countsChanged = !areTabCountMapsEqual(prevCounts, nextCounts)
    this.tabCounts = nextCounts

    if (removedAnyBuffer || countsChanged) {
      this.reconcileAutoSaveTimers()
      this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
    }

    return this.getSnapshot()
  }

  unregisterWindow(windowId: number): void {
    const wasPaused = this.pausedWindows.delete(windowId)
    const hadTabs = this.windowTabs.delete(windowId)
    const prevCounts = this.tabCounts
    const nextCounts = this.computeTabCounts()

    const orphanKeys = new Set<string>()
    for (const [key, ownerId] of this.unregisteredOpenOwners.entries()) {
      if (ownerId === windowId && (nextCounts[key] ?? 0) === 0) {
        orphanKeys.add(key)
      }
    }
    for (const [key, prevCount] of Object.entries(prevCounts)) {
      if (prevCount > 0 && (nextCounts[key] ?? 0) === 0) {
        orphanKeys.add(key)
      }
    }

    let removedAnyBuffer = false
    for (const key of orphanKeys) {
      if (this.store.removeBuffer(key)) {
        removedAnyBuffer = true
      }
    }
    this.cleanupTrackingForKeys(orphanKeys)

    const countsChanged = hadTabs && !areTabCountMapsEqual(prevCounts, nextCounts)
    this.tabCounts = nextCounts

    if (wasPaused || removedAnyBuffer || countsChanged) {
      this.reconcileAutoSaveTimers()
      if (removedAnyBuffer || countsChanged) {
        this.emit({ type: 'state-changed', snapshot: this.getSnapshot() })
      }
    }
  }

  private openOrGetBuffer(
    kind: 'workspace' | 'config',
    filePath: string,
    name: string | undefined,
    content: string,
    windowId?: number
  ): DocumentBuffer {
    const key = getWorkspacePathKey(filePath)
    const existing = this.store.getBuffer(key)
    if (existing) {
      return { ...existing }
    }

    const created = this.store.openBuffer({
      kind,
      path: filePath,
      name,
      content
    })
    if ((this.tabCounts[created.key] ?? 0) === 0 && windowId !== undefined) {
      this.unregisteredOpenOwners.set(created.key, windowId)
    }
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
      return { ...existing }
    }

    if (initialContent !== undefined) {
      return this.openOrGetBuffer('workspace', filePath, name, initialContent, windowId)
    }

    return this.dedupeOpenBuffer(key, async () => {
      const content = await this.storage.readWorkspaceFile(filePath)
      const latest = this.store.getBuffer(key)
      if (latest) {
        return { ...latest }
      }
      return this.openOrGetBuffer('workspace', filePath, name, content, windowId)
    })
  }

  async openConfigDocument(windowId?: number): Promise<DocumentBuffer> {
    const existingConfig = this.store.getAllBuffers().find((buffer) => buffer.kind === 'config')
    if (existingConfig) {
      return { ...existingConfig }
    }

    const configPath = await this.storage.getConfigPath()
    const key = getWorkspacePathKey(configPath)
    const byKey = this.store.getBuffer(key)
    if (byKey) {
      return { ...byKey }
    }

    return this.dedupeOpenBuffer(key, async () => {
      const raw = await this.storage.readConfigRaw()
      const latest = this.store.getBuffer(key)
      if (latest) {
        return { ...latest }
      }
      return this.openOrGetBuffer('config', configPath, 'config.json', raw, windowId)
    })
  }

  async refreshCleanConfig(rawContent?: string): Promise<DocumentBuffer | null> {
    const existing = this.store.getAllBuffers().find((buffer) => buffer.kind === 'config')
    if (!existing || existing.isDirty) {
      return existing ? { ...existing } : null
    }

    const freshRaw = rawContent !== undefined ? rawContent : await this.storage.readConfigRaw()
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
        this.lastAutoSaveAttemptVersion.delete(updated.key)
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
    if (typeof config.autoSave === 'boolean') {
      this.autoSave = config.autoSave
    }
    if (typeof config.autoSaveDelayMs === 'number' && Number.isFinite(config.autoSaveDelayMs)) {
      this.autoSaveDelayMs = Math.max(0, config.autoSaveDelayMs)
    }
    this.reconcileAutoSaveTimers()
  }

  setAutoSavePaused(windowId: number, paused: boolean): void {
    const changed = paused ? !this.pausedWindows.has(windowId) : this.pausedWindows.has(windowId)
    if (!changed) return
    if (paused) {
      this.pausedWindows.add(windowId)
    } else {
      this.pausedWindows.delete(windowId)
    }
    this.reconcileAutoSaveTimers()
  }

  private reconcileAutoSaveTimers(): void {
    if (this.disposed || !this.autoSave || this.pausedWindows.size > 0) {
      this.clearAllTimers()
      return
    }

    const currentBuffers = this.store.getSnapshot()

    for (const [key, entry] of this.autoSaveTimers.entries()) {
      const buf = currentBuffers[key]
      if (
        !buf ||
        buf.kind !== 'workspace' ||
        !buf.isDirty ||
        buf.isSaving ||
        buf.version !== entry.version
      ) {
        clearTimeout(entry.timerId)
        this.autoSaveTimers.delete(key)
      }
    }

    for (const attemptedKey of this.lastAutoSaveAttemptVersion.keys()) {
      const buf = currentBuffers[attemptedKey]
      if (!buf || !buf.isDirty) {
        this.lastAutoSaveAttemptVersion.delete(attemptedKey)
      }
    }

    for (const buf of Object.values(currentBuffers)) {
      if (buf.kind !== 'workspace' || !buf.isDirty || buf.isSaving) continue
      if (this.lastAutoSaveAttemptVersion.get(buf.key) === buf.version) continue
      if (this.autoSaveTimers.has(buf.key)) continue

      const scheduledVersion = buf.version
      const timerId = setTimeout(() => {
        this.autoSaveTimers.delete(buf.key)
        if (this.disposed || !this.autoSave || this.pausedWindows.size > 0) return

        const latest = this.store.getBuffer(buf.key)
        if (
          !latest ||
          latest.kind !== 'workspace' ||
          !latest.isDirty ||
          latest.isSaving ||
          latest.version !== scheduledVersion ||
          this.inFlightSaves.has(latest.key)
        ) {
          return
        }

        this.lastAutoSaveAttemptVersion.set(latest.key, scheduledVersion)
        void this.executeSave({ ...latest })
      }, this.autoSaveDelayMs)

      this.autoSaveTimers.set(buf.key, { version: scheduledVersion, timerId })
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

    for (const [oldKey, newKey] of remapLookup.entries()) {
      this.clearTimerForKey(oldKey)

      const attemptedVersion = this.lastAutoSaveAttemptVersion.get(oldKey)
      if (attemptedVersion !== undefined) {
        this.lastAutoSaveAttemptVersion.delete(oldKey)
        this.lastAutoSaveAttemptVersion.set(newKey, attemptedVersion)
      }

      const ownerId = this.unregisteredOpenOwners.get(oldKey)
      if (ownerId !== undefined) {
        this.unregisteredOpenOwners.delete(oldKey)
        this.unregisteredOpenOwners.set(newKey, ownerId)
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

  clearWorkspaceBuffers(): string[] {
    const removedKeys = this.store.clearWorkspaceBuffers()
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
            this.clearTimerForKey(current.key)
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
      this.cleanupTrackingForKeys(closedKeys)
      this.pruneAndRemoveTabReferences(new Set(closedKeys))
      this.reconcileAutoSaveTimers()
      this.emit({
        type: 'buffers-closed',
        snapshot: this.getSnapshot(),
        closedKeys
      })
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
    this.clearAllTimers()
    this.listeners.clear()
    this.windowTabs.clear()
    this.unregisteredOpenOwners.clear()
    this.pausedWindows.clear()
    this.lastAutoSaveAttemptVersion.clear()
    this.inFlightOpens.clear()
    this.inFlightSaves.clear()
  }
}
