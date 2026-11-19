import { realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import { isSupportedImageFile } from '@shared/assets'
import type { DocumentBuffer } from '@shared/documentBuffer'
import {
  compareWorkspaceSearchFileResults,
  compileSearchMatcher,
  type CompiledSearchMatcher,
  DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE,
  DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES,
  extractLineSnippet,
  splitSearchLines,
  type TextMatchSpan,
  type WorkspaceSearchFileResult,
  type WorkspaceSearchLineMatch,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse
} from '@shared/search'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import type { WorkspaceFsService } from './WorkspaceFsService'

const DEFAULT_SEARCH_CONCURRENCY = 8

const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ico',
  '.icns',
  '.tif',
  '.tiff',
  '.psd',
  '.heic',
  '.heif',
  '.raw',
  '.mp3',
  '.wav',
  '.flac',
  '.aac',
  '.ogg',
  '.m4a',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.asar',
  '.jar',
  '.war',
  '.whl',
  '.nupkg',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.obj',
  '.o',
  '.a',
  '.lib',
  '.pdb',
  '.class',
  '.pyc',
  '.pyo',
  '.wasm',
  '.node',
  '.msi',
  '.dmg',
  '.iso',
  '.img',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.sqlite',
  '.sqlite3',
  '.db'
])

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
  | {
      kind: 'scanned'
      lineMatches: WorkspaceSearchLineMatch[]
      totalMatchCount: number
      keptMatchCount: number
      truncatedInFile: boolean
    }

function isExcludedNonTextFileName(fileName: string): boolean {
  if (isSupportedImageFile(fileName)) {
    return true
  }
  const ext = extname(fileName).toLowerCase()
  return ext.length > 0 && KNOWN_BINARY_EXTENSIONS.has(ext)
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function emptySearchResponse(query: string, error?: string): WorkspaceSearchResponse {
  return {
    query,
    files: [],
    totalFileCount: 0,
    totalMatchCount: 0,
    truncated: false,
    ...(error !== undefined ? { error } : {})
  }
}

function scanTextContent(
  text: string,
  matcher: CompiledSearchMatcher,
  maxMatchesPerFile: number,
  signal: AbortSignal
): Extract<CandidateScanSlot, { kind: 'scanned' }> | null {
  const lines = splitSearchLines(text)
  const lineMatches: WorkspaceSearchLineMatch[] = []
  let totalMatchCount = 0
  let keptMatchCount = 0
  let truncatedInFile = false

  for (let index = 0; index < lines.length; index += 1) {
    if ((index & 1023) === 0 && signal.aborted) {
      return null
    }
    const rawLine = lines[index]
    const rawMatches = matcher.findMatches(rawLine)
    if (rawMatches.length === 0) {
      continue
    }

    totalMatchCount += rawMatches.length
    if (totalMatchCount > maxMatchesPerFile) {
      truncatedInFile = true
    }

    if (keptMatchCount >= maxMatchesPerFile) {
      truncatedInFile = true
      continue
    }

    const snippet = extractLineSnippet(rawLine, rawMatches)
    if (snippet.matches.length === 0) {
      continue
    }

    const remainingInFile = maxMatchesPerFile - keptMatchCount
    const clipped = snippet.matches.length > remainingInFile
    const keptMatches = clipped ? snippet.matches.slice(0, remainingInFile) : snippet.matches
    if (clipped) {
      truncatedInFile = true
    }

    keptMatchCount += keptMatches.length
    lineMatches.push({
      lineNumber: index + 1,
      lineText: snippet.lineText,
      lineOffset: snippet.lineOffset,
      matches: keptMatches
    })
  }

  return {
    kind: 'scanned',
    lineMatches,
    totalMatchCount,
    keptMatchCount,
    truncatedInFile
  }
}

function trimLineMatchesToBudget(
  lineMatches: readonly WorkspaceSearchLineMatch[],
  budget: number
): { lineMatches: WorkspaceSearchLineMatch[]; keptCount: number } {
  const trimmedLines: WorkspaceSearchLineMatch[] = []
  let remaining = budget
  let keptCount = 0

  for (const line of lineMatches) {
    if (remaining <= 0) {
      break
    }
    if (line.matches.length <= remaining) {
      trimmedLines.push(line)
      keptCount += line.matches.length
      remaining -= line.matches.length
      continue
    }
    trimmedLines.push({
      ...line,
      matches: line.matches.slice(0, remaining)
    })
    keptCount += remaining
    remaining = 0
    break
  }

  return { lineMatches: trimmedLines, keptCount }
}

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
    const maxTotalMatches = normalizePositiveLimit(
      request?.maxTotalMatches,
      DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES
    )
    const maxMatchesPerFile = normalizePositiveLimit(
      request?.maxMatchesPerFile,
      DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE
    )

    this.cancelActiveSearch()

    if (this.disposed) {
      return emptySearchResponse(query)
    }

    const controller = new AbortController()
    this.activeSearchController = controller

    const isInvalidated = (): boolean =>
      this.disposed ||
      controller.signal.aborted ||
      this.workspaceService.getWorkspaceRoot() !== capturedRoot

    try {
      if (query.length === 0) {
        return emptySearchResponse(query)
      }

      const compiled = compileSearchMatcher(query, options)
      if (!compiled.ok) {
        return emptySearchResponse(query, compiled.error)
      }

      const openTextBuffersByKey = await this.collectOpenWorkspaceTextBuffers()
      if (isInvalidated()) {
        return emptySearchResponse(query)
      }

      let entries: WorkspaceEntry[]
      try {
        entries = await this.workspaceService.listWorkspaceFiles({
          filterFileName: (name) => !isExcludedNonTextFileName(name),
          signal: controller.signal
        })
      } catch (error) {
        if (isInvalidated()) {
          return emptySearchResponse(query)
        }
        throw error
      }
      if (isInvalidated()) {
        return emptySearchResponse(query)
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
      return emptySearchResponse(query)
    }

    const slotResults = new Array<CandidateScanSlot | undefined>(candidates.length)
    const files: WorkspaceSearchFileResult[] = []
    let nextDispatchIndex = 0
    let nextCommitIndex = 0
    let committedMatchCount = 0
    let responseTruncated = false
    let stopBodyScanning = false

    const pushFileResult = (
      candidate: SearchCandidate,
      lineMatches: WorkspaceSearchLineMatch[],
      totalMatchCount: number,
      truncatedInFile: boolean
    ): void => {
      files.push({
        path: candidate.entry.path,
        relativePath: candidate.entry.relativePath,
        name: candidate.entry.name,
        nameMatches: candidate.nameMatches,
        lineMatches,
        totalMatchCount,
        truncatedInFile
      })
    }

    const commitReadySlots = (): void => {
      while (nextCommitIndex < candidates.length && slotResults[nextCommitIndex] !== undefined) {
        const candidate = candidates[nextCommitIndex]
        const slot = slotResults[nextCommitIndex]!
        slotResults[nextCommitIndex] = undefined
        nextCommitIndex += 1

        if (slot.kind === 'skip') {
          continue
        }

        const remainingBudget = maxTotalMatches - committedMatchCount
        if (remainingBudget <= 0) {
          if (slot.totalMatchCount > 0) {
            responseTruncated = true
            stopBodyScanning = true
          }
          if (candidate.nameMatches.length > 0) {
            pushFileResult(candidate, [], slot.totalMatchCount, slot.totalMatchCount > 0)
          }
          continue
        }

        if (slot.keptMatchCount > remainingBudget) {
          const trimmed = trimLineMatchesToBudget(slot.lineMatches, remainingBudget)
          committedMatchCount += trimmed.keptCount
          responseTruncated = true
          stopBodyScanning = true
          pushFileResult(candidate, trimmed.lineMatches, slot.totalMatchCount, true)
          continue
        }

        committedMatchCount += slot.keptMatchCount
        if (candidate.nameMatches.length > 0 || slot.lineMatches.length > 0) {
          pushFileResult(candidate, slot.lineMatches, slot.totalMatchCount, slot.truncatedInFile)
        }
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
        if (stopBodyScanning && candidate.nameMatches.length === 0) {
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

        const scanned = scanTextContent(
          text,
          matcher,
          stopBodyScanning ? 0 : maxMatchesPerFile,
          signal
        )
        if (!scanned || isInvalidated()) {
          return
        }

        slotResults[index] = scanned
        commitReadySlots()
      }
    }

    const workerCount = Math.min(this.concurrency, candidates.length)
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

    if (isInvalidated()) {
      return emptySearchResponse(query)
    }

    commitReadySlots()

    return {
      query,
      files,
      totalFileCount: files.length,
      totalMatchCount: committedMatchCount,
      truncated: responseTruncated
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelActiveSearch()
  }
}
