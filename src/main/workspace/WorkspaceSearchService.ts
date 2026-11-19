import { realpath } from 'node:fs/promises'
import type { DocumentBuffer } from '@shared/documentBuffer'
import {
  commitSearchCandidateSlot,
  compareWorkspaceSearchFileResults,
  compileSearchMatcher,
  type CompiledSearchMatcher,
  DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE,
  DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES,
  emptyWorkspaceSearchResponse,
  isExcludedSearchFileName,
  normalizeWorkspaceSearchLimit,
  scanSearchTextContent,
  type SearchCandidateScanResult,
  type TextMatchSpan,
  type WorkspaceSearchAccumulator,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse
} from '@shared/search'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import type { WorkspaceFsService } from './WorkspaceFsService'

const DEFAULT_SEARCH_CONCURRENCY = 8

export interface WorkspaceSearchServiceDependencies {
  workspaceService: WorkspaceFsService
  getOpenBuffers?: () => readonly DocumentBuffer[]
  concurrency?: number
}

interface SearchCandidate {
  entry: WorkspaceEntry
  relativePath: string
  pathKey: string
  nameMatches: TextMatchSpan[]
}

type CandidateScanSlot =
  | { kind: 'skip' }
  | ({ kind: 'scanned' } & SearchCandidateScanResult)

/**
 * Executes session-scoped workspace text search combining the workspace filesystem and live
 * shared document buffers, enforcing security filters, limits, snippet offsets, and scan cancellation.
 */
export class WorkspaceSearchService {
  private readonly workspaceService: WorkspaceFsService
  private readonly getOpenBuffers: () => readonly DocumentBuffer[]
  private readonly concurrency: number

  private activeSearchController: AbortController | null = null
  private disposed = false

  constructor({
    workspaceService,
    getOpenBuffers = () => [],
    concurrency = DEFAULT_SEARCH_CONCURRENCY
  }: WorkspaceSearchServiceDependencies) {
    this.workspaceService = workspaceService
    this.getOpenBuffers = getOpenBuffers
    this.concurrency = Math.max(1, Math.floor(concurrency))
  }

  /**
   * Aborts any currently running workspace search scan for this session.
   */
  cancelActiveSearch(): void {
    if (this.activeSearchController) {
      this.activeSearchController.abort()
      this.activeSearchController = null
    }
  }

  /**
   * Searches workspace text filenames/paths and contents (preferring open workspace text buffers).
   */
  async search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> {
    const capturedRoot = this.workspaceService.getWorkspaceRoot()
    if (!capturedRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }

    const query = typeof request?.query === 'string' ? request.query : ''
    const options = request?.options
    const maxTotalMatches = normalizeWorkspaceSearchLimit(
      request?.maxTotalMatches,
      DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES
    )
    const maxMatchesPerFile = normalizeWorkspaceSearchLimit(
      request?.maxMatchesPerFile,
      DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE
    )

    this.cancelActiveSearch()

    if (this.disposed) {
      return emptyWorkspaceSearchResponse(query)
    }

    const controller = new AbortController()
    this.activeSearchController = controller

    const isInvalidated = (): boolean =>
      this.disposed ||
      controller.signal.aborted ||
      this.workspaceService.getWorkspaceRoot() !== capturedRoot

    try {
      if (query.length === 0) {
        return emptyWorkspaceSearchResponse(query)
      }

      const compiled = compileSearchMatcher(query, options)
      if (!compiled.ok) {
        return emptyWorkspaceSearchResponse(query, compiled.error)
      }

      const openTextBuffersByKey = await this.collectOpenWorkspaceTextBuffers()
      if (isInvalidated()) {
        return emptyWorkspaceSearchResponse(query)
      }

      let entries: WorkspaceEntry[]
      try {
        entries = await this.workspaceService.listWorkspaceFiles({
          filterFileName: (name) => !isExcludedSearchFileName(name),
          signal: controller.signal
        })
      } catch (error) {
        if (isInvalidated()) {
          return emptyWorkspaceSearchResponse(query)
        }
        throw error
      }
      if (isInvalidated()) {
        return emptyWorkspaceSearchResponse(query)
      }

      const candidates: SearchCandidate[] = entries
        .map((entry) => ({
          entry,
          relativePath: entry.relativePath,
          pathKey: getWorkspacePathKey(entry.path),
          nameMatches: compiled.matcher.findMatches(entry.relativePath)
        }))
        .sort(compareWorkspaceSearchFileResults)

      return await this.scanCandidates({
        query,
        candidates,
        matcher: compiled.matcher,
        openTextBuffersByKey,
        maxTotalMatches,
        maxMatchesPerFile,
        signal: controller.signal,
        isInvalidated
      })
    } finally {
      if (this.activeSearchController === controller) {
        this.activeSearchController = null
      }
    }
  }

  private async collectOpenWorkspaceTextBuffers(): Promise<Map<string, string>> {
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

  private async readCandidateText(
    candidate: SearchCandidate,
    openTextBuffersByKey: ReadonlyMap<string, string>,
    signal: AbortSignal
  ): Promise<string | null> {
    const openContent = openTextBuffersByKey.get(candidate.pathKey)
    if (openContent !== undefined) {
      return openContent
    }
    return this.workspaceService.readTextFileForSearch(candidate.entry.path, { signal })
  }

  private async scanCandidates(params: {
    query: string
    candidates: readonly SearchCandidate[]
    matcher: CompiledSearchMatcher
    openTextBuffersByKey: ReadonlyMap<string, string>
    maxTotalMatches: number
    maxMatchesPerFile: number
    signal: AbortSignal
    isInvalidated: () => boolean
  }): Promise<WorkspaceSearchResponse> {
    const {
      query,
      candidates,
      matcher,
      openTextBuffersByKey,
      maxTotalMatches,
      maxMatchesPerFile,
      signal,
      isInvalidated
    } = params

    if (candidates.length === 0) {
      return emptyWorkspaceSearchResponse(query)
    }

    const slotResults = new Array<CandidateScanSlot | undefined>(candidates.length)
    const accumulator: WorkspaceSearchAccumulator = {
      files: [],
      committedMatchCount: 0,
      truncated: false,
      stopBodyScanning: false,
      maxTotalMatches
    }
    let nextDispatchIndex = 0
    let nextCommitIndex = 0

    const commitReadySlots = (): void => {
      while (nextCommitIndex < candidates.length && slotResults[nextCommitIndex] !== undefined) {
        const candidate = candidates[nextCommitIndex]
        const slot = slotResults[nextCommitIndex]!
        slotResults[nextCommitIndex] = undefined
        nextCommitIndex += 1

        if (slot.kind === 'skip') {
          continue
        }

        commitSearchCandidateSlot(
          accumulator,
          {
            path: candidate.entry.path,
            relativePath: candidate.entry.relativePath,
            name: candidate.entry.name,
            nameMatches: candidate.nameMatches
          },
          slot
        )
      }
    }

    const runWorker = async (): Promise<void> => {
      while (!isInvalidated()) {
        const index = nextDispatchIndex
        if (index >= candidates.length) {
          return
        }
        nextDispatchIndex += 1

        const candidate = candidates[index]
        if (accumulator.stopBodyScanning && candidate.nameMatches.length === 0) {
          slotResults[index] = { kind: 'skip' }
          commitReadySlots()
          return
        }

        let text: string | null
        try {
          text = await this.readCandidateText(candidate, openTextBuffersByKey, signal)
        } catch (error) {
          if (isInvalidated()) {
            return
          }
          throw error
        }

        if (isInvalidated()) {
          return
        }

        if (text === null) {
          slotResults[index] = { kind: 'skip' }
          commitReadySlots()
          continue
        }

        const scanned = scanSearchTextContent(
          text,
          matcher,
          accumulator.stopBodyScanning ? 0 : maxMatchesPerFile,
          () => signal.aborted
        )
        if (!scanned || isInvalidated()) {
          return
        }

        slotResults[index] = { kind: 'scanned', ...scanned }
        commitReadySlots()
      }
    }

    const workerCount = Math.min(this.concurrency, candidates.length)
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

    if (isInvalidated()) {
      return emptyWorkspaceSearchResponse(query)
    }

    commitReadySlots()

    return {
      query,
      files: accumulator.files,
      totalFileCount: accumulator.files.length,
      totalMatchCount: accumulator.committedMatchCount,
      truncated: accumulator.truncated
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelActiveSearch()
  }
}
