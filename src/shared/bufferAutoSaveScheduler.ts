import { DEFAULT_APP_CONFIG } from './config'
import type { BufferKeyRemap, DocumentBuffer, DocumentBufferSnapshot } from './documentBuffer'

interface AutoSaveTimerEntry {
  version: number
  timerId: ReturnType<typeof setTimeout>
}

export interface BufferAutoSaveSchedulerOptions {
  initialAutoSave?: boolean
  initialAutoSaveDelayMs?: number
}

export interface ReconcileAutoSaveInput {
  buffers: DocumentBufferSnapshot
  isSaveInFlight: (key: string) => boolean
  getLatestBuffer: (key: string) => DocumentBuffer | undefined
  onTriggerSave: (buffer: DocumentBuffer) => void
}

/**
 * Coordinates debounced workspace buffer auto-save timers, modal/dialog pauses,
 * and per-version failure suppression until the buffer is edited again.
 */
export class BufferAutoSaveScheduler {
  private readonly timers = new Map<string, AutoSaveTimerEntry>()
  private readonly lastAttemptVersion = new Map<string, number>()
  private readonly pausedWindows = new Set<number>()
  private autoSave: boolean
  private autoSaveDelayMs: number
  private disposed = false

  constructor(options: BufferAutoSaveSchedulerOptions = {}) {
    this.autoSave = options.initialAutoSave ?? DEFAULT_APP_CONFIG.autoSave
    this.autoSaveDelayMs = options.initialAutoSaveDelayMs ?? DEFAULT_APP_CONFIG.autoSaveDelayMs
  }

  setConfig(config: { autoSave?: boolean; autoSaveDelayMs?: number }): void {
    if (typeof config.autoSave === 'boolean') {
      this.autoSave = config.autoSave
    }
    if (typeof config.autoSaveDelayMs === 'number' && Number.isFinite(config.autoSaveDelayMs)) {
      this.autoSaveDelayMs = Math.max(0, config.autoSaveDelayMs)
    }
  }

  setPaused(windowId: number, paused: boolean): boolean {
    const changed = paused ? !this.pausedWindows.has(windowId) : this.pausedWindows.has(windowId)
    if (!changed) return false
    if (paused) {
      this.pausedWindows.add(windowId)
    } else {
      this.pausedWindows.delete(windowId)
    }
    return true
  }

  removePausedWindow(windowId: number): boolean {
    return this.pausedWindows.delete(windowId)
  }

  clearTimer(key: string): void {
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing.timerId)
      this.timers.delete(key)
    }
  }

  clearAttempt(key: string): void {
    this.lastAttemptVersion.delete(key)
  }

  clearForKeys(keys: Iterable<string>): void {
    for (const key of keys) {
      this.clearTimer(key)
      this.lastAttemptVersion.delete(key)
    }
  }

  remapKeys(remappings: Iterable<BufferKeyRemap>): void {
    for (const { oldKey, newKey } of remappings) {
      if (oldKey === newKey) continue
      this.clearTimer(oldKey)
      const attemptedVersion = this.lastAttemptVersion.get(oldKey)
      if (attemptedVersion !== undefined) {
        this.lastAttemptVersion.delete(oldKey)
        this.lastAttemptVersion.set(newKey, attemptedVersion)
      }
    }
  }

  private clearAllTimers(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.timerId)
    }
    this.timers.clear()
  }

  reconcile({
    buffers,
    isSaveInFlight,
    getLatestBuffer,
    onTriggerSave
  }: ReconcileAutoSaveInput): void {
    if (this.disposed || !this.autoSave || this.pausedWindows.size > 0) {
      this.clearAllTimers()
      return
    }

    for (const [key, entry] of this.timers.entries()) {
      const buf = buffers[key]
      if (
        !buf ||
        buf.kind !== 'workspace' ||
        !buf.isDirty ||
        buf.isSaving ||
        buf.version !== entry.version
      ) {
        clearTimeout(entry.timerId)
        this.timers.delete(key)
      }
    }

    for (const attemptedKey of this.lastAttemptVersion.keys()) {
      const buf = buffers[attemptedKey]
      if (!buf || !buf.isDirty) {
        this.lastAttemptVersion.delete(attemptedKey)
      }
    }

    for (const buf of Object.values(buffers)) {
      if (buf.kind !== 'workspace' || !buf.isDirty || buf.isSaving) continue
      if (this.lastAttemptVersion.get(buf.key) === buf.version) continue
      if (this.timers.has(buf.key)) continue

      const scheduledVersion = buf.version
      const timerId = setTimeout(() => {
        this.timers.delete(buf.key)
        if (this.disposed || !this.autoSave || this.pausedWindows.size > 0) return

        const latest = getLatestBuffer(buf.key)
        if (
          !latest ||
          latest.kind !== 'workspace' ||
          !latest.isDirty ||
          latest.isSaving ||
          latest.version !== scheduledVersion ||
          isSaveInFlight(latest.key)
        ) {
          return
        }

        this.lastAttemptVersion.set(latest.key, scheduledVersion)
        onTriggerSave({ ...latest })
      }, this.autoSaveDelayMs)

      this.timers.set(buf.key, { version: scheduledVersion, timerId })
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearAllTimers()
    this.pausedWindows.clear()
    this.lastAttemptVersion.clear()
  }
}
