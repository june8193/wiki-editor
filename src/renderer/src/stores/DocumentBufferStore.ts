import {
  getWorkspaceDisplayName,
  getWorkspacePathKey,
  normalizeWorkspacePath
} from '@shared/workspace'

export type DocumentKind = 'workspace' | 'config'
export type DocumentContentKind = 'text' | 'image'

export interface DocumentBuffer {
  key: string
  kind: DocumentKind
  contentKind: DocumentContentKind
  path: string
  name: string
  content: string
  savedContent: string
  isDirty: boolean
  version: number
  isSaving: boolean
}

export type OpenBufferInput =
  | {
      kind: DocumentKind
      contentKind?: 'text'
      path: string
      name?: string
      content: string
    }
  | {
      kind: 'workspace'
      contentKind: 'image'
      path: string
      name?: string
    }

export interface BufferKeyRemap {
  oldKey: string
  newKey: string
}

export type DocumentBufferSnapshot = Readonly<Record<string, DocumentBuffer>>

function isKeyNestedOrSame(candidateKey: string, parentKey: string): boolean {
  if (!candidateKey || !parentKey) return false
  if (candidateKey === parentKey) return true
  return parentKey.endsWith('/')
    ? candidateKey.startsWith(parentKey)
    : candidateKey.startsWith(`${parentKey}/`)
}

function buildRemappedPath(currentPath: string, oldPrefix: string, newPrefix: string): string {
  const normOld = normalizeWorkspacePath(oldPrefix)
  const normCurrent = normalizeWorkspacePath(currentPath)
  const suffix = normCurrent.slice(normOld.length)
  if (!suffix) {
    return newPrefix
  }
  const usePosixSep = newPrefix.includes('/') && !newPrefix.includes('\\')
  const normalizedSuffix = usePosixSep ? suffix.replace(/\\/g, '/') : suffix.replace(/\//g, '\\')
  return `${newPrefix.replace(/[\\/]+$/, '')}${normalizedSuffix}`
}

/**
 * Centralized document buffer store keyed by normalized file path.
 * Multiple tabs across split panes subscribe to the same buffer entry for real-time sync.
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

    const contentKind: DocumentContentKind = input.contentKind === 'image' ? 'image' : 'text'
    const initialContent = input.contentKind === 'image' ? '' : input.content

    const created: DocumentBuffer = {
      key,
      kind: input.kind,
      contentKind,
      path: input.path,
      name: input.name?.trim() || getWorkspaceDisplayName(input.path),
      content: initialContent,
      savedContent: initialContent,
      isDirty: false,
      version: 1,
      isSaving: false
    }
    this.commit({ ...this.buffers, [key]: created })
    return created
  }

  updateContent(pathOrKey: string, nextContent: string): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.contentKind === 'image' || current.content === nextContent) return

    const updated: DocumentBuffer = {
      ...current,
      content: nextContent,
      isDirty: nextContent !== current.savedContent,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
  }

  markSaved(pathOrKey: string, savedContent: string): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.contentKind === 'image') return

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
    if (!current || current.contentKind === 'image' || current.isSaving === isSaving) return

    const updated: DocumentBuffer = {
      ...current,
      isSaving
    }
    this.commit({ ...this.buffers, [key]: updated })
  }

  refreshCleanContent(pathOrKey: string, freshContent: string): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.contentKind === 'image' || current.isDirty) return
    if (current.content === freshContent && current.savedContent === freshContent) return

    const updated: DocumentBuffer = {
      ...current,
      content: freshContent,
      savedContent: freshContent,
      isDirty: false,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
  }

  /**
   * Increments the buffer revision of a read-only image buffer so its wiki-asset preview URL
   * busts Chromium's image cache after external disk updates.
   */
  refreshImageAsset(pathOrKey: string): void {
    const key = this.resolveKey(pathOrKey)
    const current = this.buffers[key]
    if (!current || current.contentKind !== 'image') return

    const updated: DocumentBuffer = {
      ...current,
      version: current.version + 1
    }
    this.commit({ ...this.buffers, [key]: updated })
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
