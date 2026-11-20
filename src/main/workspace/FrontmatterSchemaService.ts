import { FSWatcher, watch as fsWatch } from 'node:fs'
import { lstat, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cloneFrontmatterSchema,
  createDefaultFrontmatterSchema,
  FRONTMATTER_SCHEMA_DIR,
  FRONTMATTER_SCHEMA_FILE,
  type FrontmatterSchemaLoadResult,
  parseFrontmatterSchema,
  parseFrontmatterSchemaJson,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { isSameWorkspacePath } from '@shared/workspace'
import { createAsyncQueue } from '../asyncQueue'
import { writeFileAtomic } from '../fs/atomicFile'
import { isErrnoCode, isPathInsideRoot, resolveRealPathWithAncestor } from '../fs/pathSecurity'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from './WorkspaceFsService'

const DEFAULT_WATCH_DEBOUNCE_MS = 60
const OUTSIDE_ERROR_MESSAGE = '워크스페이스 루트 밖의 경로에는 접근할 수 없습니다.'
const SYMLINK_ERROR_MESSAGE =
  '유효하지 않거나 워크스페이스 루트 밖을 가리키는 심볼릭 링크에는 접근할 수 없습니다.'

export type FrontmatterSchemaChangedListener = (result: FrontmatterSchemaLoadResult) => void

export interface FrontmatterSchemaServiceOptions {
  workspaceService: WorkspaceFsService
  watchDebounceMs?: number
  logService?: LogService
}

function isSchemaWatchTarget(filename: string | null): boolean {
  if (!filename) return true
  const normalized = filename.replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    normalized === FRONTMATTER_SCHEMA_DIR ||
    normalized === `${FRONTMATTER_SCHEMA_DIR}/${FRONTMATTER_SCHEMA_FILE}`
  )
}

function cloneSchemaLoadResult(result: FrontmatterSchemaLoadResult): FrontmatterSchemaLoadResult {
  return {
    exists: result.exists,
    path: result.path,
    schema: result.schema ? cloneFrontmatterSchema(result.schema) : null,
    ...(result.error !== undefined ? { error: result.error } : {})
  }
}

function computeSchemaFingerprint(
  result: FrontmatterSchemaLoadResult,
  rawErrorContent?: string
): string {
  if (!result.exists) {
    return `${result.path}|missing`
  }
  if (result.schema) {
    return `${result.path}|valid|${serializeFrontmatterSchema(result.schema)}`
  }
  return `${result.path}|error|${result.error ?? ''}|${rawErrorContent ?? ''}`
}

/**
 * Manages loading, strict validation, atomic creation/saving, path security,
 * and external change watching for workspace `.wiki-editor/frontmatter.json`.
 */
export class FrontmatterSchemaService {
  private readonly workspaceService: WorkspaceFsService
  private readonly watchDebounceMs: number
  private readonly logService?: LogService
  private readonly queue = createAsyncQueue()
  private readonly listeners = new Set<FrontmatterSchemaChangedListener>()
  private readonly unsubscribeRootChanged: () => void

  private watcher: FSWatcher | null = null
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private watchedRoot: string | null = null
  private lastKnownFingerprint: string | null = null
  private disposed = false

  constructor({
    workspaceService,
    watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
    logService
  }: FrontmatterSchemaServiceOptions) {
    this.workspaceService = workspaceService
    this.watchDebounceMs = Math.max(5, Math.floor(watchDebounceMs))
    this.logService = logService

    this.unsubscribeRootChanged = this.workspaceService.onWorkspaceRootChanged((rootPath) =>
      this.handleWorkspaceRootChanged(rootPath)
    )

    const initialRoot = this.workspaceService.getWorkspaceRoot()
    if (initialRoot) {
      void this.handleWorkspaceRootChanged(initialRoot)
    }
  }

  getSchemaPath(): string | null {
    const root = this.workspaceService.getWorkspaceRoot()
    return root ? join(root, FRONTMATTER_SCHEMA_DIR, FRONTMATTER_SCHEMA_FILE) : null
  }

  isSchemaFilePath(candidatePath: string): boolean {
    const schemaPath = this.getSchemaPath()
    return Boolean(schemaPath && isSameWorkspacePath(schemaPath, candidatePath))
  }

  getSchema(): Promise<FrontmatterSchemaLoadResult> {
    return this.queue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      const { result, fingerprint } = await this.readSchemaFromDisk(root)
      this.lastKnownFingerprint = fingerprint
      return cloneSchemaLoadResult(result)
    })
  }

  createDefaultSchema(): Promise<FrontmatterSchemaLoadResult> {
    return this.queue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      const resolved = await this.resolveSchemaTarget(root, { writable: true })
      if (resolved.exists) {
        const { result, fingerprint } = await this.readSchemaFromDisk(root)
        this.lastKnownFingerprint = fingerprint
        return cloneSchemaLoadResult(result)
      }

      const starter = createDefaultFrontmatterSchema()
      const serialized = serializeFrontmatterSchema(starter)
      await writeFileAtomic(resolved.resolvedReal, serialized)

      const result: FrontmatterSchemaLoadResult = {
        exists: true,
        path: resolved.schemaPath,
        schema: starter
      }
      this.lastKnownFingerprint = computeSchemaFingerprint(result)
      this.notifyListeners(result)
      return cloneSchemaLoadResult(result)
    })
  }

  saveSchema(rawSchema: unknown): Promise<FrontmatterSchemaLoadResult> {
    const validation = parseFrontmatterSchema(rawSchema)
    if (!validation.ok) {
      return Promise.reject(new Error(validation.error))
    }

    return this.queue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      const resolved = await this.resolveSchemaTarget(root, { writable: true })
      const serialized = serializeFrontmatterSchema(validation.schema)
      await writeFileAtomic(resolved.resolvedReal, serialized)

      const result: FrontmatterSchemaLoadResult = {
        exists: true,
        path: resolved.schemaPath,
        schema: validation.schema
      }
      this.lastKnownFingerprint = computeSchemaFingerprint(result)
      this.notifyListeners(result)
      return cloneSchemaLoadResult(result)
    })
  }

  reloadIfChanged(): Promise<FrontmatterSchemaLoadResult | null> {
    return this.queue.enqueue(async () => {
      if (this.disposed) return null
      const root = this.workspaceService.getWorkspaceRoot()
      if (!root) return null

      try {
        const { result, fingerprint } = await this.readSchemaFromDisk(root)
        if (this.disposed || this.workspaceService.getWorkspaceRoot() !== root) {
          return null
        }
        if (this.lastKnownFingerprint === fingerprint) {
          return null
        }
        this.lastKnownFingerprint = fingerprint
        this.notifyListeners(result)
        return cloneSchemaLoadResult(result)
      } catch (error) {
        void this.logService?.warn('workspace', 'Failed to reload frontmatter schema', {
          data: { rootPath: root },
          error
        })
        return null
      }
    })
  }

  onSchemaChanged(listener: FrontmatterSchemaChangedListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopWatching()
    this.unsubscribeRootChanged()
    this.listeners.clear()
    this.lastKnownFingerprint = null
  }

  private requireWorkspaceRoot(): string {
    const root = this.workspaceService.getWorkspaceRoot()
    if (!root) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return root
  }

  private async handleWorkspaceRootChanged(rootPath: string | null): Promise<void> {
    this.stopWatching()
    this.lastKnownFingerprint = null
    if (this.disposed || !rootPath) {
      return
    }
    this.startWatching(rootPath)
    await this.queue.enqueue(async () => {
      if (this.disposed || this.workspaceService.getWorkspaceRoot() !== rootPath) {
        return
      }
      try {
        const { fingerprint } = await this.readSchemaFromDisk(rootPath)
        this.lastKnownFingerprint = fingerprint
      } catch {
        this.lastKnownFingerprint = null
      }
    })
  }

  private startWatching(root: string): void {
    this.watchedRoot = root
    try {
      this.watcher = fsWatch(root, { recursive: true }, (_eventType, filename) => {
        if (this.disposed || this.watchedRoot !== root) return
        if (!isSchemaWatchTarget(filename)) return
        this.scheduleWatcherReload(root)
      })
      this.watcher.on('error', () => {
        if (this.watchedRoot === root) {
          this.stopWatching()
        }
      })
    } catch {
      this.stopWatching()
    }
  }

  private scheduleWatcherReload(expectedRoot: string): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer)
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      if (!this.disposed && this.workspaceService.getWorkspaceRoot() === expectedRoot) {
        void this.reloadIfChanged()
      }
    }, this.watchDebounceMs)
  }

  private stopWatching(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer)
      this.watchTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.watchedRoot = null
  }

  private async resolveSchemaTarget(
    root: string,
    options: { writable: boolean }
  ): Promise<{
    schemaPath: string
    resolvedReal: string
    exists: boolean
    nonFileError?: string
  }> {
    const schemaDir = join(root, FRONTMATTER_SCHEMA_DIR)
    const schemaPath = join(schemaDir, FRONTMATTER_SCHEMA_FILE)

    const dirStats = await lstat(schemaDir).catch((error) => {
      if (isErrnoCode(error, 'ENOENT')) return null
      throw error
    })
    if (dirStats) {
      if (dirStats.isSymbolicLink()) {
        throw new Error(SYMLINK_ERROR_MESSAGE)
      }
      if (!dirStats.isDirectory()) {
        if (options.writable) {
          throw new Error('`.wiki-editor` 경로가 폴더가 아닙니다.')
        }
        return {
          schemaPath,
          resolvedReal: schemaPath,
          exists: true,
          nonFileError: '`.wiki-editor` 경로가 폴더가 아닙니다.'
        }
      }
    }

    const fileStats = await lstat(schemaPath).catch((error) => {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return null
      throw error
    })
    if (fileStats?.isSymbolicLink()) {
      throw new Error(SYMLINK_ERROR_MESSAGE)
    }

    const { resolvedReal, exists } = await resolveRealPathWithAncestor(schemaPath, {
      outsideMessage: OUTSIDE_ERROR_MESSAGE,
      danglingSymlinkMessage: SYMLINK_ERROR_MESSAGE,
      assertResolved: (candidateReal) => {
        if (!isPathInsideRoot(root, candidateReal)) {
          throw new Error(OUTSIDE_ERROR_MESSAGE)
        }
      }
    })

    if (exists) {
      const targetStats = await stat(resolvedReal)
      if (!targetStats.isFile()) {
        if (options.writable) {
          throw new Error('스키마 경로가 파일이 아닙니다.')
        }
        return {
          schemaPath,
          resolvedReal,
          exists: true,
          nonFileError: '스키마 경로가 파일이 아닙니다.'
        }
      }
    }

    return { schemaPath, resolvedReal, exists }
  }

  private async readSchemaFromDisk(root: string): Promise<{
    result: FrontmatterSchemaLoadResult
    fingerprint: string
  }> {
    const resolved = await this.resolveSchemaTarget(root, { writable: false })
    if (resolved.nonFileError) {
      const result: FrontmatterSchemaLoadResult = {
        exists: true,
        path: resolved.schemaPath,
        schema: null,
        error: resolved.nonFileError
      }
      return { result, fingerprint: computeSchemaFingerprint(result) }
    }

    if (!resolved.exists) {
      const result: FrontmatterSchemaLoadResult = {
        exists: false,
        path: resolved.schemaPath,
        schema: null
      }
      return { result, fingerprint: computeSchemaFingerprint(result) }
    }

    let raw: string
    try {
      raw = await readFile(resolved.resolvedReal, 'utf8')
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        const result: FrontmatterSchemaLoadResult = {
          exists: false,
          path: resolved.schemaPath,
          schema: null
        }
        return { result, fingerprint: computeSchemaFingerprint(result) }
      }
      throw error
    }

    const parsed = parseFrontmatterSchemaJson(raw)
    if (!parsed.ok) {
      const result: FrontmatterSchemaLoadResult = {
        exists: true,
        path: resolved.schemaPath,
        schema: null,
        error: parsed.error
      }
      return { result, fingerprint: computeSchemaFingerprint(result, raw) }
    }

    const result: FrontmatterSchemaLoadResult = {
      exists: true,
      path: resolved.schemaPath,
      schema: parsed.schema
    }
    return { result, fingerprint: computeSchemaFingerprint(result) }
  }

  private notifyListeners(result: FrontmatterSchemaLoadResult): void {
    for (const listener of [...this.listeners]) {
      listener(cloneSchemaLoadResult(result))
    }
  }
}
