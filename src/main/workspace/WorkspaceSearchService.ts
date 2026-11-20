import { realpath } from 'node:fs/promises'
import type { DocumentBuffer } from '@shared/documentBuffer'
import {
  collectAllowCustomMultiSelectFields,
  createFrontmatterFieldComparator,
  createFrontmatterFieldValuesCollector,
  extractFrontmatterSummary,
  type FrontmatterFieldValue,
  type FrontmatterFilterCondition,
  type FrontmatterValueComparator,
  isExcludedFrontmatterRelativePath,
  isFrontmatterDocumentFileName,
  matchesFrontmatterConditions,
  parseFrontmatterDocument,
  type WorkspaceFrontmatterFieldValuesResponse,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import {
  buildWorkspaceSearchFileResult,
  commitSearchCandidateSlot,
  compareWorkspaceSearchEntriesBySort,
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
  WORKSPACE_SEARCH_MAX_FILE_BYTES,
  type WorkspaceSearchAccumulator,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
  type WorkspaceSearchSortSpec
} from '@shared/search'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import type { FrontmatterSchemaService } from './FrontmatterSchemaService'
import type { WorkspaceFsService } from './WorkspaceFsService'

const DEFAULT_SEARCH_CONCURRENCY = 8

export interface WorkspaceSearchServiceDependencies {
  workspaceService: WorkspaceFsService
  frontmatterSchemaService?: FrontmatterSchemaService
  getOpenBuffers?: () => readonly DocumentBuffer[]
  concurrency?: number
}

interface SearchCandidate {
  entry: WorkspaceEntry
  relativePath: string
  pathKey: string
  nameMatches: TextMatchSpan[]
  isFrontmatterEligible: boolean
}

interface MatchedCandidateData {
  scanResult: SearchCandidateScanResult
  values?: Record<string, FrontmatterFieldValue>
  frontmatterSummary?: Record<string, FrontmatterFieldValue>
}

type CandidateScanSlot =
  | { kind: 'skip' }
  | ({ kind: 'matched' } & MatchedCandidateData)

interface ScanContext {
  signal: AbortSignal
  isInvalidated: () => boolean
}

interface FrontmatterSearchPlan {
  schema: WorkspaceFrontmatterSchema | null
  conditions: readonly FrontmatterFilterCondition[]
  sort?: WorkspaceSearchSortSpec
  fieldComparator?: FrontmatterValueComparator
}

const EMPTY_SCAN_RESULT: SearchCandidateScanResult = {
  lineMatches: [],
  totalMatchCount: 0,
  keptMatchCount: 0,
  truncatedInFile: false
}

/**
 * Executes session-scoped workspace text search and frontmatter metadata operations combining the
 * workspace filesystem and live shared document buffers, enforcing security filters, limits, and
 * scan cancellation.
 */
export class WorkspaceSearchService {
  private readonly workspaceService: WorkspaceFsService
  private readonly frontmatterSchemaService?: FrontmatterSchemaService
  private readonly getOpenBuffers: () => readonly DocumentBuffer[]
  private readonly concurrency: number

  private activeSearchController: AbortController | null = null
  private activeFieldValuesController: AbortController | null = null
  private disposed = false

  constructor({
    workspaceService,
    frontmatterSchemaService,
    getOpenBuffers = () => [],
    concurrency = DEFAULT_SEARCH_CONCURRENCY
  }: WorkspaceSearchServiceDependencies) {
    this.workspaceService = workspaceService
    this.frontmatterSchemaService = frontmatterSchemaService
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
   * Aborts any currently running frontmatter custom field value collection scan for this session.
   */
  cancelActiveFieldValuesScan(): void {
    if (this.activeFieldValuesController) {
      this.activeFieldValuesController.abort()
      this.activeFieldValuesController = null
    }
  }

  /**
   * Aborts all currently running search and frontmatter scans for this session.
   */
  cancelAllScans(): void {
    this.cancelActiveSearch()
    this.cancelActiveFieldValuesScan()
  }

  /**
   * Searches workspace text filenames/paths and contents (preferring open workspace text buffers),
   * optionally filtering and sorting by workspace YAML frontmatter schema conditions.
   */
  async search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> {
    const capturedRoot = this.requireWorkspaceRoot()
    const query = typeof request?.query === 'string' ? request.query : ''
    const options = request?.options
    const frontmatterQuery = request?.frontmatter
    const conditions = Array.isArray(frontmatterQuery?.conditions)
      ? frontmatterQuery.conditions
      : []
    const sort = frontmatterQuery?.sort
    const hasConditions = conditions.length > 0
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
    const ctx = this.createScanContext(controller.signal, capturedRoot)

    try {
      if (query.length === 0 && !hasConditions) {
        return emptyWorkspaceSearchResponse(query)
      }

      let compiledMatcher: CompiledSearchMatcher | null = null
      if (query.length > 0) {
        const compiled = compileSearchMatcher(query, options)
        if (!compiled.ok) {
          return emptyWorkspaceSearchResponse(query, compiled.error)
        }
        compiledMatcher = compiled.matcher
      }

      const needsSchema = hasConditions || sort?.by === 'frontmatter'
      const schema = await this.loadWorkspaceFrontmatterSchema(needsSchema)
      if (ctx.isInvalidated() || (hasConditions && !schema)) {
        return emptyWorkspaceSearchResponse(query)
      }

      const openTextBuffersByKey = await this.collectOpenWorkspaceTextBuffers()
      if (ctx.isInvalidated()) {
        return emptyWorkspaceSearchResponse(query)
      }

      const entries = await this.listEligibleEntries(hasConditions, ctx)
      if (!entries || ctx.isInvalidated()) {
        return emptyWorkspaceSearchResponse(query)
      }

      const candidates: SearchCandidate[] = entries.map((entry) => ({
        entry,
        relativePath: entry.relativePath,
        pathKey: getWorkspacePathKey(entry.path),
        nameMatches: compiledMatcher ? compiledMatcher.findMatches(entry.relativePath) : [],
        isFrontmatterEligible:
          !isExcludedFrontmatterRelativePath(entry.relativePath) &&
          isFrontmatterDocumentFileName(entry.name)
      }))

      const sortField =
        sort?.by === 'frontmatter' && sort.fieldKey && schema
          ? schema.fields.find((field) => field.key === sort.fieldKey)
          : undefined
      const fieldComparator = sortField
        ? createFrontmatterFieldComparator(sortField, sort!.direction)
        : undefined

      if (!fieldComparator) {
        candidates.sort((a, b) =>
          compareWorkspaceSearchEntriesBySort(
            a,
            b,
            sort?.by === 'path' ? sort : undefined,
            schema
          )
        )
      }

      return await this.scanCandidates({
        query,
        candidates,
        matcher: compiledMatcher,
        frontmatter: { schema, conditions, sort, fieldComparator },
        openTextBuffersByKey,
        maxTotalMatches,
        maxMatchesPerFile,
        ctx
      })
    } finally {
      if (this.activeSearchController === controller) {
        this.activeSearchController = null
      }
    }
  }

  /**
   * Collects deduplicated, sorted schema options and live document custom values for `allowCustom`
   * `multi-select` fields (preferring open workspace text buffers over disk).
   */
  async collectFrontmatterFieldValues(
    fieldKeys?: readonly string[]
  ): Promise<WorkspaceFrontmatterFieldValuesResponse> {
    const capturedRoot = this.requireWorkspaceRoot()
    this.cancelActiveFieldValuesScan()
    if (this.disposed) {
      return { valuesByField: {} }
    }

    const controller = new AbortController()
    this.activeFieldValuesController = controller
    const ctx = this.createScanContext(controller.signal, capturedRoot)

    try {
      const schema = await this.loadWorkspaceFrontmatterSchema(true)
      if (ctx.isInvalidated() || !schema) {
        return { valuesByField: {} }
      }

      const targetFields = collectAllowCustomMultiSelectFields(schema, fieldKeys)
      if (targetFields.length === 0) {
        return { valuesByField: {} }
      }

      const openTextBuffersByKey = await this.collectOpenWorkspaceTextBuffers()
      if (ctx.isInvalidated()) {
        return { valuesByField: {} }
      }

      const entries = await this.listEligibleEntries(true, ctx)
      if (!entries || ctx.isInvalidated()) {
        return { valuesByField: {} }
      }

      const candidates = entries.map((entry) => ({
        entry,
        pathKey: getWorkspacePathKey(entry.path)
      }))
      const collector = createFrontmatterFieldValuesCollector(targetFields)
      const narrowSchema: WorkspaceFrontmatterSchema = { version: 1, fields: targetFields }

      await this.runCandidateWorkers(
        candidates,
        async (candidate) => {
          const text = await this.readCandidateTextSafe(candidate, openTextBuffersByKey, ctx)
          if (text === null || ctx.isInvalidated()) {
            return
          }
          const parsed = parseFrontmatterDocument(text, narrowSchema)
          collector.addDocumentValues(parsed.values)
        },
        ctx.isInvalidated
      )

      if (ctx.isInvalidated()) {
        return { valuesByField: {} }
      }

      return collector.finalize()
    } finally {
      if (this.activeFieldValuesController === controller) {
        this.activeFieldValuesController = null
      }
    }
  }

  private requireWorkspaceRoot(): string {
    const root = this.workspaceService.getWorkspaceRoot()
    if (!root) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return root
  }

  private createScanContext(signal: AbortSignal, capturedRoot: string): ScanContext {
    return {
      signal,
      isInvalidated: () =>
        this.disposed ||
        signal.aborted ||
        this.workspaceService.getWorkspaceRoot() !== capturedRoot
    }
  }

  private async loadWorkspaceFrontmatterSchema(
    strictForFrontmatter: boolean
  ): Promise<WorkspaceFrontmatterSchema | null> {
    if (!this.frontmatterSchemaService) {
      return null
    }
    try {
      const loaded = await this.frontmatterSchemaService.getSchema()
      return loaded.schema
    } catch (error) {
      if (strictForFrontmatter) {
        throw error
      }
      return null
    }
  }

  private async listEligibleEntries(
    onlyFrontmatterDocuments: boolean,
    ctx: ScanContext
  ): Promise<WorkspaceEntry[] | null> {
    let entries: WorkspaceEntry[]
    try {
      entries = await this.workspaceService.listWorkspaceFiles({
        filterFileName: (name) =>
          !isExcludedSearchFileName(name) &&
          (!onlyFrontmatterDocuments || isFrontmatterDocumentFileName(name)),
        signal: ctx.signal
      })
    } catch (error) {
      if (ctx.isInvalidated()) {
        return null
      }
      throw error
    }
    if (ctx.isInvalidated()) {
      return null
    }
    return onlyFrontmatterDocuments
      ? entries.filter((entry) => !isExcludedFrontmatterRelativePath(entry.relativePath))
      : entries
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

  private async readCandidateTextSafe(
    candidate: Pick<SearchCandidate, 'entry' | 'pathKey'>,
    openTextBuffersByKey: ReadonlyMap<string, string>,
    ctx: ScanContext
  ): Promise<string | null> {
    const openContent = openTextBuffersByKey.get(candidate.pathKey)
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
      return await this.workspaceService.readTextFileForSearch(candidate.entry.path, {
        signal: ctx.signal
      })
    } catch (error) {
      if (ctx.isInvalidated()) {
        return null
      }
      throw error
    }
  }

  private async runCandidateWorkers<TCandidate>(
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

  private evaluateCandidateFrontmatter(
    candidate: SearchCandidate,
    text: string,
    plan: FrontmatterSearchPlan
  ): {
    matched: boolean
    values?: Record<string, FrontmatterFieldValue>
    frontmatterSummary?: Record<string, FrontmatterFieldValue>
  } {
    const hasConditions = plan.conditions.length > 0
    if (!plan.schema || !candidate.isFrontmatterEligible) {
      return { matched: !hasConditions }
    }
    const parsed = parseFrontmatterDocument(text, plan.schema)
    if (hasConditions && !matchesFrontmatterConditions(parsed.values, plan.conditions, plan.schema)) {
      return { matched: false }
    }
    return {
      matched: true,
      values: parsed.values,
      frontmatterSummary: extractFrontmatterSummary(parsed.values, plan.schema)
    }
  }

  private commitMatchedCandidate(
    accumulator: WorkspaceSearchAccumulator,
    candidate: SearchCandidate,
    matched: MatchedCandidateData,
    hasTextMatcher: boolean
  ): void {
    if (!hasTextMatcher) {
      accumulator.files.push(
        buildWorkspaceSearchFileResult({
          path: candidate.entry.path,
          relativePath: candidate.entry.relativePath,
          name: candidate.entry.name,
          nameMatches: [],
          lineMatches: [],
          totalMatchCount: 0,
          truncatedInFile: false,
          frontmatterSummary: matched.frontmatterSummary
        })
      )
      return
    }

    commitSearchCandidateSlot(
      accumulator,
      {
        path: candidate.entry.path,
        relativePath: candidate.entry.relativePath,
        name: candidate.entry.name,
        nameMatches: candidate.nameMatches,
        frontmatterSummary: matched.frontmatterSummary
      },
      matched.scanResult
    )
  }

  private async scanCandidates(params: {
    query: string
    candidates: readonly SearchCandidate[]
    matcher: CompiledSearchMatcher | null
    frontmatter: FrontmatterSearchPlan
    openTextBuffersByKey: ReadonlyMap<string, string>
    maxTotalMatches: number
    maxMatchesPerFile: number
    ctx: ScanContext
  }): Promise<WorkspaceSearchResponse> {
    const {
      query,
      candidates,
      matcher,
      frontmatter,
      openTextBuffersByKey,
      maxTotalMatches,
      maxMatchesPerFile,
      ctx
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
    const needsPostScanSort = Boolean(frontmatter.fieldComparator)
    const shouldStreamCommit = !needsPostScanSort && matcher !== null
    let nextCommitIndex = 0

    const commitReadySlots = (): void => {
      while (nextCommitIndex < candidates.length && slotResults[nextCommitIndex] !== undefined) {
        const candidate = candidates[nextCommitIndex]
        const slot = slotResults[nextCommitIndex]!
        slotResults[nextCommitIndex] = undefined
        nextCommitIndex += 1
        if (slot.kind === 'matched') {
          this.commitMatchedCandidate(accumulator, candidate, slot, matcher !== null)
        }
      }
    }

    const markSkipped = (index: number): void => {
      slotResults[index] = { kind: 'skip' }
      if (shouldStreamCommit) {
        commitReadySlots()
      }
    }

    await this.runCandidateWorkers(
      candidates,
      async (candidate, index) => {
        if (shouldStreamCommit && accumulator.stopBodyScanning && candidate.nameMatches.length === 0) {
          markSkipped(index)
          return
        }

        const text = await this.readCandidateTextSafe(candidate, openTextBuffersByKey, ctx)
        if (ctx.isInvalidated()) {
          return
        }
        if (text === null) {
          markSkipped(index)
          return
        }

        const fmResult = this.evaluateCandidateFrontmatter(candidate, text, frontmatter)
        if (!fmResult.matched) {
          markSkipped(index)
          return
        }

        if (!matcher) {
          slotResults[index] = {
            kind: 'matched',
            scanResult: EMPTY_SCAN_RESULT,
            values: fmResult.values,
            frontmatterSummary: fmResult.frontmatterSummary
          }
          return
        }

        const scanned = scanSearchTextContent(
          text,
          matcher,
          shouldStreamCommit && accumulator.stopBodyScanning ? 0 : maxMatchesPerFile,
          () => ctx.signal.aborted
        )
        if (!scanned || ctx.isInvalidated()) {
          return
        }
        if (candidate.nameMatches.length === 0 && scanned.lineMatches.length === 0) {
          markSkipped(index)
          return
        }

        slotResults[index] = {
          kind: 'matched',
          scanResult: scanned,
          values: fmResult.values,
          frontmatterSummary: fmResult.frontmatterSummary
        }
        if (shouldStreamCommit) {
          commitReadySlots()
        }
      },
      ctx.isInvalidated
    )

    if (ctx.isInvalidated()) {
      return emptyWorkspaceSearchResponse(query)
    }

    if (shouldStreamCommit) {
      commitReadySlots()
    } else {
      const matchedItems: Array<{
        candidate: SearchCandidate
        slot: Extract<CandidateScanSlot, { kind: 'matched' }>
      }> = []
      for (let i = 0; i < candidates.length; i += 1) {
        const slot = slotResults[i]
        if (slot && slot.kind === 'matched') {
          matchedItems.push({ candidate: candidates[i], slot })
        }
      }

      if (needsPostScanSort) {
        matchedItems.sort((a, b) =>
          compareWorkspaceSearchEntriesBySort(
            {
              relativePath: a.candidate.relativePath,
              nameMatches: a.candidate.nameMatches,
              values: a.slot.values
            },
            {
              relativePath: b.candidate.relativePath,
              nameMatches: b.candidate.nameMatches,
              values: b.slot.values
            },
            frontmatter.sort,
            frontmatter.schema,
            frontmatter.fieldComparator
          )
        )
      }

      for (const item of matchedItems) {
        this.commitMatchedCandidate(accumulator, item.candidate, item.slot, matcher !== null)
      }
    }

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
    this.cancelAllScans()
  }
}
