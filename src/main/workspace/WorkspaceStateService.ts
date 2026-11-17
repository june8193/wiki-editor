import { readFile } from 'node:fs/promises'
import { getWorkspacePathKey, resolveNormalizedWorkspacePath } from '@shared/workspace'
import {
  applyWorkspaceStateUpdate,
  clonePersistedWorkspaceState,
  cloneWorkspaceStateDocument,
  createDefaultWorkspaceStateDocument,
  DEFAULT_MAX_PERSISTED_WORKSPACES,
  getCorruptWorkspaceStateRootReason,
  normalizeWorkspaceStateDocument,
  type PersistedWorkspaceState,
  validateWorkspaceStateUpdate,
  type WorkspaceStateDocument,
  type WorkspaceStateUpdate
} from '@shared/workspaceState'
import { createAsyncQueue } from '../asyncQueue'
import { isErrnoCode } from '../fs/pathSecurity'
import { nextUniqueSuffix, writeFileAtomic } from '../fs/atomicFile'
import type { LogService } from '../logging/LogService'

export interface WorkspaceStateServiceOptions {
  logService?: LogService
  maxWorkspaces?: number
  now?: () => string
}

function serializeWorkspaceState(doc: WorkspaceStateDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * Manages atomic persistence of per-workspace UI session state in workspace-state.json.
 */
export class WorkspaceStateService {
  private readonly statePath: string
  private readonly logService?: LogService
  private readonly maxWorkspaces: number
  private readonly now: () => string
  private readonly queue = createAsyncQueue()

  constructor(statePath: string, options: WorkspaceStateServiceOptions = {}) {
    this.statePath = statePath
    this.logService = options.logService
    this.maxWorkspaces = options.maxWorkspaces ?? DEFAULT_MAX_PERSISTED_WORKSPACES
    this.now = options.now ?? (() => new Date().toISOString())
  }

  getStatePath(): string {
    return this.statePath
  }

  getDocument(): Promise<WorkspaceStateDocument> {
    return this.queue.enqueue(() => this.loadOrInitialize())
  }

  async getWorkspaceState(rootPath: string): Promise<PersistedWorkspaceState | null> {
    const normalizedRoot = resolveNormalizedWorkspacePath(rootPath)
    if (!normalizedRoot) {
      return null
    }
    const key = getWorkspacePathKey(normalizedRoot)
    const doc = await this.getDocument()
    const found = doc.workspaces[key]
    return found ? clonePersistedWorkspaceState(found) : null
  }

  saveWorkspaceState(
    rootPath: string,
    update: WorkspaceStateUpdate
  ): Promise<PersistedWorkspaceState> {
    try {
      validateWorkspaceStateUpdate(update)
      if (!resolveNormalizedWorkspacePath(rootPath)) {
        throw new Error('유효하지 않은 워크스페이스 경로입니다.')
      }
    } catch (error) {
      return Promise.reject(error)
    }

    return this.queue.enqueue(async () => {
      const current = await this.loadOrInitialize()
      const { document: nextDoc, workspaceState } = applyWorkspaceStateUpdate(
        current,
        rootPath,
        update,
        this.now(),
        { maxWorkspaces: this.maxWorkspaces }
      )
      await writeFileAtomic(this.statePath, serializeWorkspaceState(nextDoc))
      return workspaceState
    })
  }

  flush(): Promise<void> {
    return this.queue.flush()
  }

  private async loadOrInitialize(): Promise<WorkspaceStateDocument> {
    let raw: string
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return this.writeDefaults()
      }
      throw error
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      const corruptReason = getCorruptWorkspaceStateRootReason(parsed)
      if (corruptReason) {
        return this.recoverCorrupted(raw, corruptReason)
      }
      return normalizeWorkspaceStateDocument(parsed, { maxWorkspaces: this.maxWorkspaces })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid-json'
      return this.recoverCorrupted(raw, reason)
    }
  }

  private async writeDefaults(): Promise<WorkspaceStateDocument> {
    const initial = createDefaultWorkspaceStateDocument()
    await writeFileAtomic(this.statePath, serializeWorkspaceState(initial))
    return cloneWorkspaceStateDocument(initial)
  }

  private async recoverCorrupted(corruptRaw: string, reason: string): Promise<WorkspaceStateDocument> {
    const backupPath = `${this.statePath}.corrupt.${nextUniqueSuffix()}.bak`
    await writeFileAtomic(backupPath, corruptRaw)
    await this.logService?.warn('workspace', 'Recovered corrupted workspace-state.json to defaults', {
      data: {
        statePath: this.statePath,
        backupPath,
        reason,
        contentLength: corruptRaw.length
      }
    })
    return this.writeDefaults()
  }
}
