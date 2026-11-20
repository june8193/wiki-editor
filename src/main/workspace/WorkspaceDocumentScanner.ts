import { realpath } from 'node:fs/promises'
import type { DocumentBuffer } from '@shared/documentBuffer'
import {
  isExcludedFrontmatterRelativePath,
  isFrontmatterDocumentFileName,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import { isExcludedSearchFileName, WORKSPACE_SEARCH_MAX_FILE_BYTES } from '@shared/search'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import type { FrontmatterSchemaService } from './FrontmatterSchemaService'
import type { WorkspaceFsService } from './WorkspaceFsService'

export const DEFAULT_WORKSPACE_SCAN_CONCURRENCY = 8

export interface WorkspaceDocumentScannerDependencies {
  workspaceService: WorkspaceFsService
  frontmatterSchemaService?: FrontmatterSchemaService
  getOpenBuffers?: () => readonly DocumentBuffer[]
  concurrency?: number
}

export interface WorkspaceScanSession {
  readonly signal: AbortSignal
  isInvalidated: () => boolean
  loadSchema: (strict: boolean) => Promise<WorkspaceFrontmatterSchema | null>
  collectOpenTextBuffers: () => Promise<Map<string, string>>
  listEligibleEntries: (onlyFrontmatterDocuments: boolean) => Promise<WorkspaceEntry[] | null>
  readCandidateTextSafe: (
    entry: WorkspaceEntry,
    pathKey: string,
    openTextBuffersByKey: ReadonlyMap<string, string>
  ) => Promise<string | null>
  runWorkers: <TCandidate>(
    candidates: readonly TCandidate[],
    processCandidate: (candidate: TCandidate, index: number) => Promise<void>
  ) => Promise<void>
}

/**
 * Coordinates single-flight cancellable workspace file/buffer scans with bounded concurrency,
 * open-buffer priority, binary/size limits, and workspace-root invalidation checks.
 */
export class WorkspaceDocumentScanner {
  private readonly workspaceService: WorkspaceFsService
  private readonly frontmatterSchemaService?: FrontmatterSchemaService
  private readonly getOpenBuffers: () => readonly DocumentBuffer[]
  private readonly concurrency: number

  private activeController: AbortController | null = null
  private disposed = false

  constructor({
    workspaceService,
    frontmatterSchemaService,
    getOpenBuffers = () => [],
    concurrency = DEFAULT_WORKSPACE_SCAN_CONCURRENCY
  }: WorkspaceDocumentScannerDependencies) {
    this.workspaceService = workspaceService
    this.frontmatterSchemaService = frontmatterSchemaService
    this.getOpenBuffers = getOpenBuffers
    this.concurrency = Math.max(1, Math.floor(concurrency))
  }

  /** Aborts any currently running scan on this scanner instance. */
  cancelActiveScan(): void {
    if (this.activeController) {
      this.activeController.abort()
      this.activeController = null
    }
  }

  /** Cancels any active scan and prevents subsequent scans from starting. */
  dispose(): void {
    this.disposed = true
    this.cancelActiveScan()
  }

  /**
   * Executes a single-flight scan against the currently open workspace, aborting any prior
   * in-flight scan on this scanner and returning `emptyResult` if cancelled or invalidated.
   */
  async runSingleFlightScan<TResult>(
    emptyResult: TResult,
    execute: (session: WorkspaceScanSession) => Promise<TResult>
  ): Promise<TResult> {
    const capturedRoot = this.workspaceService.getWorkspaceRoot()
    if (!capturedRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }

    this.cancelActiveScan()
    if (this.disposed) {
      return emptyResult
    }

    const controller = new AbortController()
    this.activeController = controller

    const isInvalidated = (): boolean =>
      this.disposed ||
      controller.signal.aborted ||
      this.workspaceService.getWorkspaceRoot() !== capturedRoot

    const session: WorkspaceScanSession = {
      signal: controller.signal,
      isInvalidated,
      loadSchema: (strict) => this.loadSchema(strict),
      collectOpenTextBuffers: () => this.collectOpenTextBuffers(),
      listEligibleEntries: (onlyFrontmatterDocuments) =>
        this.listEligibleEntries(onlyFrontmatterDocuments, controller.signal, isInvalidated),
      readCandidateTextSafe: (entry, pathKey, openBuffers) =>
        this.readCandidateTextSafe(entry, pathKey, openBuffers, controller.signal, isInvalidated),
      runWorkers: (candidates, processCandidate) =>
        this.runWorkers(candidates, processCandidate, isInvalidated)
    }

    try {
      return await execute(session)
    } finally {
      if (this.activeController === controller) {
        this.activeController = null
      }
    }
  }

  private async loadSchema(strict: boolean): Promise<WorkspaceFrontmatterSchema | null> {
    if (!this.frontmatterSchemaService) {
      return null
    }
    try {
      const loaded = await this.frontmatterSchemaService.getSchema()
      return loaded.schema
    } catch (error) {
      if (strict) {
        throw error
      }
      return null
    }
  }

  private async collectOpenTextBuffers(): Promise<Map<string, string>> {
    const bufferMap = new Map<string, string>()
    for (const buffer of this.getOpenBuffers()) {
      if (buffer.kind !== 'workspace' || buffer.contentKind !== 'text') {
        continue
      }
      const key = getWorkspacePathKey(buffer.path)
      if (key) {
        bufferMap.set(key, buffer.content)
      }
      if (buffer.key && !bufferMap.has(buffer.key)) {
        bufferMap.set(buffer.key, buffer.content)
      }
      try {
        const realKey = getWorkspacePathKey(await realpath(buffer.path))
        if (realKey && !bufferMap.has(realKey)) {
          bufferMap.set(realKey, buffer.content)
        }
      } catch {
        // Ignore unresolvable paths; disk enumeration decides which workspace files exist.
      }
    }
    return bufferMap
  }

  private async listEligibleEntries(
    onlyFrontmatterDocuments: boolean,
    signal: AbortSignal,
    isInvalidated: () => boolean
  ): Promise<WorkspaceEntry[] | null> {
    let entries: WorkspaceEntry[]
    try {
      entries = await this.workspaceService.listWorkspaceFiles({
        filterFileName: (name) =>
          !isExcludedSearchFileName(name) &&
          (!onlyFrontmatterDocuments || isFrontmatterDocumentFileName(name)),
        signal
      })
    } catch (error) {
      if (isInvalidated()) {
        return null
      }
      throw error
    }
    if (isInvalidated()) {
      return null
    }
    return onlyFrontmatterDocuments
      ? entries.filter((entry) => !isExcludedFrontmatterRelativePath(entry.relativePath))
      : entries
  }

  private async readCandidateTextSafe(
    entry: WorkspaceEntry,
    pathKey: string,
    openTextBuffersByKey: ReadonlyMap<string, string>,
    signal: AbortSignal,
    isInvalidated: () => boolean
  ): Promise<string | null> {
    const openContent = openTextBuffersByKey.get(pathKey)
    if (openContent !== undefined) {
      if (
        openContent.includes('\0') ||
        Buffer.byteLength(openContent, 'utf8') > WORKSPACE_SEARCH_MAX_FILE_BYTES
      ) {
        return null
      }
      return openContent
    }
    try {
      return await this.workspaceService.readTextFileForSearch(entry.path, { signal })
    } catch (error) {
      if (isInvalidated()) {
        return null
      }
      throw error
    }
  }

  private async runWorkers<TCandidate>(
    candidates: readonly TCandidate[],
    processCandidate: (candidate: TCandidate, index: number) => Promise<void>,
    isInvalidated: () => boolean
  ): Promise<void> {
    let nextDispatchIndex = 0
    const runWorker = async (): Promise<void> => {
      while (!isInvalidated()) {
        const index = nextDispatchIndex
        if (index >= candidates.length) {
          return
        }
        nextDispatchIndex += 1
        await processCandidate(candidates[index], index)
      }
    }

    const workerCount = Math.min(this.concurrency, candidates.length)
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  }
}
