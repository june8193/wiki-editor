import { FSWatcher, watch as fsWatch } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FRONTMATTER_SCHEMA_DIR,
  FRONTMATTER_SCHEMA_FILE,
  FRONTMATTER_SCHEMA_RELATIVE_PATH
} from '@shared/frontmatter'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import {
  SCHEMA_DIR_NOT_DIRECTORY_ERROR,
  SCHEMA_TARGET_NOT_FILE_ERROR,
  type SchemaRawReadResult,
  WorkspaceQueryAndSchemaHub,
  type WorkspaceQueryAndSchemaStorage
} from '@shared/workspaceQueryAndSchema'
import { writeFileAtomic } from '../fs/atomicFile'
import {
  isErrnoCode,
  isPathInsideRoot,
  resolveRealPathWithAncestor,
  WORKSPACE_OUTSIDE_ERROR_MESSAGE,
  WORKSPACE_SYMLINK_ERROR_MESSAGE
} from '../fs/pathSecurity'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from './WorkspaceFsService'

const DEFAULT_WATCH_DEBOUNCE_MS = 60

export interface DiskWorkspaceQueryAndSchemaOptions {
  workspaceService: WorkspaceFsService
  bufferHub?: SharedDocumentBufferHub
  watchDebounceMs?: number
  concurrency?: number
  logService?: LogService
}

type InspectedDiskSchemaTarget =
  | { kind: 'non-file'; schemaPath: string; error: string }
  | { kind: 'target'; schemaPath: string; resolvedReal: string; exists: boolean }

function isSchemaWatchTarget(filename: string | null): boolean {
  if (!filename) return true
  const normalized = filename.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized === FRONTMATTER_SCHEMA_DIR || normalized === FRONTMATTER_SCHEMA_RELATIVE_PATH
}

async function inspectDiskSchemaTarget(root: string): Promise<InspectedDiskSchemaTarget> {
  const schemaDir = join(root, FRONTMATTER_SCHEMA_DIR)
  const schemaPath = join(schemaDir, FRONTMATTER_SCHEMA_FILE)

  const dirStats = await lstat(schemaDir).catch((error) => {
    if (isErrnoCode(error, 'ENOENT')) return null
    throw error
  })
  if (dirStats) {
    if (dirStats.isSymbolicLink()) {
      throw new Error(WORKSPACE_SYMLINK_ERROR_MESSAGE)
    }
    if (!dirStats.isDirectory()) {
      return { kind: 'non-file', schemaPath, error: SCHEMA_DIR_NOT_DIRECTORY_ERROR }
    }
  }

  const fileStats = await lstat(schemaPath).catch((error) => {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return null
    throw error
  })
  if (fileStats?.isSymbolicLink()) {
    throw new Error(WORKSPACE_SYMLINK_ERROR_MESSAGE)
  }

  const { resolvedReal, exists } = await resolveRealPathWithAncestor(schemaPath, {
    outsideMessage: WORKSPACE_OUTSIDE_ERROR_MESSAGE,
    danglingSymlinkMessage: WORKSPACE_SYMLINK_ERROR_MESSAGE,
    assertResolved: (candidateReal) => {
      if (!isPathInsideRoot(root, candidateReal)) {
        throw new Error(WORKSPACE_OUTSIDE_ERROR_MESSAGE)
      }
    }
  })

  if (exists) {
    const targetStats = await stat(resolvedReal)
    if (!targetStats.isFile()) {
      return { kind: 'non-file', schemaPath, error: SCHEMA_TARGET_NOT_FILE_ERROR }
    }
  }

  return { kind: 'target', schemaPath, resolvedReal, exists }
}

async function readDiskSchemaRaw(root: string): Promise<SchemaRawReadResult> {
  const resolved = await inspectDiskSchemaTarget(root)
  if (resolved.kind === 'non-file') {
    return { kind: 'invalid-target', schemaPath: resolved.schemaPath, error: resolved.error }
  }
  if (!resolved.exists) {
    return { kind: 'missing', schemaPath: resolved.schemaPath }
  }

  try {
    const rawText = await readFile(resolved.resolvedReal, 'utf8')
    return { kind: 'present', schemaPath: resolved.schemaPath, rawText }
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { kind: 'missing', schemaPath: resolved.schemaPath }
    }
    throw error
  }
}

async function writeDiskSchemaRaw(
  root: string,
  serializedSchema: string
): Promise<{ schemaPath: string }> {
  const resolved = await inspectDiskSchemaTarget(root)
  if (resolved.kind === 'non-file') {
    throw new Error(resolved.error)
  }
  await writeFileAtomic(resolved.resolvedReal, serializedSchema)
  return { schemaPath: resolved.schemaPath }
}

function watchDiskSchema(
  root: string,
  debounceMs: number,
  onPossibleChange: () => void
): () => void {
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const stop = (): void => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (watcher) {
      watcher.close()
      watcher = null
    }
  }

  try {
    watcher = fsWatch(root, { recursive: true }, (_eventType, filename) => {
      if (stopped || !isSchemaWatchTarget(filename)) {
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        if (!stopped) {
          onPossibleChange()
        }
      }, debounceMs)
    })
    watcher.on('error', () => {
      stop()
    })
  } catch {
    stop()
  }

  return stop
}

/**
 * Builds the main-process disk storage adapter for `WorkspaceQueryAndSchemaHub`, preserving
 * path security, atomic writes, `fsWatch` debounced schema monitoring, and bounded file reads.
 */
export function createDiskWorkspaceQueryAndSchemaStorage({
  workspaceService,
  watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS
}: Pick<DiskWorkspaceQueryAndSchemaOptions, 'workspaceService' | 'watchDebounceMs'>): WorkspaceQueryAndSchemaStorage {
  const resolvedDebounceMs = Math.max(5, Math.floor(watchDebounceMs))

  return {
    getWorkspaceRoot: () => workspaceService.getWorkspaceRoot(),
    onWorkspaceRootChanged: (listener) => workspaceService.onWorkspaceRootChanged(listener),
    listWorkspaceFiles: (options) => workspaceService.listWorkspaceFiles(options),
    readTextFileForSearch: (filePath, options) =>
      workspaceService.readTextFileForSearch(filePath, options),
    resolveRealPath: (targetPath) => realpath(targetPath),
    readSchemaRaw: readDiskSchemaRaw,
    writeSchemaRaw: writeDiskSchemaRaw,
    watchSchema: (rootPath, onPossibleChange) =>
      watchDiskSchema(rootPath, resolvedDebounceMs, onPossibleChange)
  }
}

/**
 * Creates a session-scoped `WorkspaceQueryAndSchemaHub` wired to the main-process disk storage
 * adapter and shared document buffer hub.
 */
export function createDiskWorkspaceQueryAndSchemaHub({
  workspaceService,
  bufferHub,
  watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS,
  concurrency,
  logService
}: DiskWorkspaceQueryAndSchemaOptions): WorkspaceQueryAndSchemaHub {
  return new WorkspaceQueryAndSchemaHub({
    storage: createDiskWorkspaceQueryAndSchemaStorage({
      workspaceService,
      watchDebounceMs
    }),
    bufferHub,
    concurrency,
    onWarn: (message, { rootPath, error }) => {
      void logService?.warn('workspace', message, {
        data: { rootPath },
        error
      })
    }
  })
}
