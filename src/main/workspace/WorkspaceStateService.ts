import {
  applyWorkspaceStateUpdate,
  createDefaultWorkspaceStateDocument,
  DEFAULT_MAX_PERSISTED_WORKSPACES,
  findWorkspaceStateInDocument,
  getCorruptWorkspaceStateRootReason,
  normalizeWorkspaceStateDocument,
  type PersistedWorkspaceState,
  validateWorkspaceStateSaveInput,
  type WorkspaceStateDocument,
  type WorkspaceStateUpdate
} from '@shared/workspaceState'
import { createAsyncQueue } from '@shared/asyncQueue'
import { loadOrInitializeJsonFile, writeFileAtomic } from '../fs/atomicFile'
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
    const doc = await this.getDocument()
    return findWorkspaceStateInDocument(doc, rootPath)
  }

  saveWorkspaceState(
    rootPath: string,
    update: WorkspaceStateUpdate
  ): Promise<PersistedWorkspaceState> {
    try {
      validateWorkspaceStateSaveInput(rootPath, update)
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

  private loadOrInitialize(): Promise<WorkspaceStateDocument> {
    return loadOrInitializeJsonFile({
      filePath: this.statePath,
      createDefault: createDefaultWorkspaceStateDocument,
      serialize: serializeWorkspaceState,
      parseValid: (parsed) => {
        const corruptReason = getCorruptWorkspaceStateRootReason(parsed)
        if (corruptReason) {
          return { ok: false, reason: corruptReason }
        }
        return {
          ok: true,
          value: normalizeWorkspaceStateDocument(parsed, { maxWorkspaces: this.maxWorkspaces })
        }
      },
      onRecovered: ({ filePath, backupPath, reason, contentLength }) =>
        this.logService?.warn('workspace', 'Recovered corrupted workspace-state.json to defaults', {
          data: {
            statePath: filePath,
            backupPath,
            reason,
            contentLength
          }
        })
    })
  }
}
