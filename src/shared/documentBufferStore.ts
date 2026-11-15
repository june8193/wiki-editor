import {
  buildRemappedPath,
  type BufferKeyRemap,
  type DocumentBuffer,
  type DocumentBufferSnapshot,
  type DocumentKind,
  isKeyNestedOrSame,
  type OpenBufferInput
} from './documentBuffer'
import { getWorkspaceDisplayName, getWorkspacePathKey } from './workspace'

function areDocumentBuffersEqual(left: DocumentBuffer, right: DocumentBuffer): boolean {
  return (
    left.key === right.key &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.name === right.name &&
    left.content === right.content &&
    left.savedContent === right.savedContent &&
    left.isDirty === right.isDirty &&
    left.version === right.version &&
    left.isSaving === right.isSaving
  )
}

/** Creates an initialized DocumentBuffer from open input without requiring store mutation. */
export function createDocumentBuffer(input: OpenBufferInput): DocumentBuffer {
  const key = getWorkspacePathKey(input.path)
  if (!key) {
    throw new Error('Buffer path must not be empty')
  }

  return {
    key,
    kind: input.kind,
    path: input.path,
    name: input.name?.trim() || getWorkspaceDisplayName(input.path),
    content: input.content,
    savedContent: input.content,
    isDirty: false,
    version: 1,
    isSaving: false
  }
}

/** Merges unacknowledged local editor edits on top of a newer authoritative hub buffer. */
export function mergePendingLocalBuffer(
  hubBuffer: DocumentBuffer,
  localBuffer: DocumentBuffer
): DocumentBuffer {
  return {
    ...hubBuffer,
    content: localBuffer.content,
    isDirty: localBuffer.content !== hubBuffer.savedContent,
    version: Math.max(localBuffer.version, hubBuffer.version)
  }
}

/**
 * Centralized document buffer store keyed by normalized file path.
 * Multiple tabs across split panes and windows subscribe to the same buffer entry for real-time sync.
 */
export class DocumentBufferStore {
  private buffers: Record<string, DocumentBuffer> = {}
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): DocumentBufferSnapshot => this.buffers

  private commit(nextBuffers: Record<string, DocumentBuffer>): void {
    this.buffers = nextBuffers
    for (const listener of this.listeners) {
      listener()
    }
  }

  replaceSnapshot(nextBuffers: DocumentBufferSnapshot): void {
    const currentKeys = Object.keys(this.buffers)
    const nextKeys = Object.keys(nextBuffers)
    if (
      currentKeys.length === nextKeys.length &&
      nextKeys.every((key) => {
        const existing = this.buffers[key]
        const next = nextBuffers[key]
        return existing !== undefined && next !== undefined && areDocumentBuffersEqual(existing, next)
      })
    ) {
      return
    }
    this.commit({ ...nextBuffers })
  }

  /** Inserts or updates a single buffer entry in place without exposing mutable internals. */
  upsertBuffer(buffer: DocumentBuffer): void {
    const existing = this.buffers[buffer.key]
    if (existing && areDocumentBuffersEqual(existing, buffer)) {
      return
    }
    this.commit({ ...this.buffers, [buffer.key]: { ...buffer } })
  }

  private resolveKey(pathOrKey: string): string {
    if (pathOrKey in this.buffers) {
      return pathOrKey
    }
    return getWorkspacePathKey(pathOrKey)
  }

  getBuffer(pathOrKey: string): DocumentBuffer | undefined {
    const key = this.resolveKey(pathOrKey)
    return this.buffers[key]
  }

  hasBuffer(pathOrKey: string): boolean {
    return this.getBuffer(pathOrKey) !== undefined
  }

  getAllBuffers(): readonly DocumentBuffer[] {
    return Object.values(this.buffers)
  }

  /** Returns the singleton config.json buffer if currently open in the store. */
  getConfigBuffer(): DocumentBuffer | undefined {
    for (const buffer of Object.values(this.buffers)) {
      if (buffer.kind === 'config') {
        return buffer
      }
    }
    return undefined
  }

  getDirtyBuffers(kind?: DocumentKind): readonly DocumentBuffer[] {
    return Object.values(this.buffers).filter(
      (buffer) => buffer.isDirty && (kind === undefined || buffer.kind === kind)
    )
  }

  openBuffer(input: OpenBufferInput): DocumentBuffer {
    const key = getWorkspacePathKey(input.path)
    if (!key) {
      throw new Error('Buffer path must not be empty')
    }

    const existing = this.buffers[key]
    if (existing) {
      return existing
    }

    const created = createDocumentBuffer(input)
    this.commit({ ...this.buffers, [key]: created })
    return created
  }

  updateContent(pathOrKey: string, nextContent: string): boolean {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.content === nextContent) return false

    const updated: DocumentBuffer = {
      ...current,
      content: nextContent,
      isDirty: nextContent !== current.savedContent,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
    return true
  }

  markSaved(pathOrKey: string, savedContent: string): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current) return

    const updated: DocumentBuffer = {
      ...current,
      savedContent,
      isDirty: current.content !== savedContent,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
  }

  setSaving(pathOrKey: string, isSaving: boolean): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.isSaving === isSaving) return

    const updated: DocumentBuffer = {
      ...current,
      isSaving
    }
    this.commit({ ...this.buffers, [key]: updated })
  }

  refreshCleanContent(pathOrKey: string, freshContent: string): boolean {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.isDirty) return false
    if (current.content === freshContent && current.savedContent === freshContent) return false

    const updated: DocumentBuffer = {
      ...current,
      content: freshContent,
      savedContent: freshContent,
      isDirty: false,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
    return true
  }

  syncRenamedPath(oldPath: string, newPath: string): BufferKeyRemap[] {
    const oldKey = getWorkspacePathKey(oldPath)
    if (!oldKey) return []

    const remappings: BufferKeyRemap[] = []
    const nextBuffers: Record<string, DocumentBuffer> = {}
    let changed = false

    for (const [key, buffer] of Object.entries(this.buffers)) {
      if (buffer.kind === 'workspace' && isKeyNestedOrSame(key, oldKey)) {
        const nextPath = buildRemappedPath(buffer.path, oldPath, newPath)
        const nextKey = getWorkspacePathKey(nextPath)
        nextBuffers[nextKey] = {
          ...buffer,
          key: nextKey,
          path: nextPath,
          name: getWorkspaceDisplayName(nextPath)
        }
        remappings.push({ oldKey: key, newKey: nextKey })
        changed = true
      } else {
        nextBuffers[key] = buffer
      }
    }

    if (changed) {
      this.commit(nextBuffers)
    }
    return remappings
  }

  removeBuffer(pathOrKey: string): boolean {
    const key = this.resolveKey(pathOrKey)
    if (!(key in this.buffers)) return false

    const nextBuffers = { ...this.buffers }
    delete nextBuffers[key]
    this.commit(nextBuffers)
    return true
  }

  private removeMatchingBuffers(
    predicate: (key: string, buffer: DocumentBuffer) => boolean
  ): string[] {
    const removedKeys: string[] = []
    const nextBuffers: Record<string, DocumentBuffer> = {}

    for (const [key, buffer] of Object.entries(this.buffers)) {
      if (predicate(key, buffer)) {
        removedKeys.push(key)
      } else {
        nextBuffers[key] = buffer
      }
    }

    if (removedKeys.length > 0) {
      this.commit(nextBuffers)
    }
    return removedKeys
  }

  removeBuffersUnderPath(targetPath: string): string[] {
    const targetKey = getWorkspacePathKey(targetPath)
    if (!targetKey) return []
    return this.removeMatchingBuffers(
      (key, buffer) => buffer.kind === 'workspace' && isKeyNestedOrSame(key, targetKey)
    )
  }

  clearWorkspaceBuffers(): string[] {
    return this.removeMatchingBuffers((_key, buffer) => buffer.kind === 'workspace')
  }
}
