import {
  extractFrontmatterSummary,
  type FrontmatterFieldValue,
  type FrontmatterFilterCondition,
  matchesFrontmatterConditions,
  parseFrontmatterDocument,
  type WorkspaceFrontmatterSchema
} from '@shared/frontmatter'
import {
  buildWorkspaceSearchFileResult,
  commitSearchCandidateSlot,
  compileSearchMatcher,
  type CompiledSearchMatcher,
  createWorkspaceSearchSortPlan,
  DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE,
  DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES,
  emptyWorkspaceSearchResponse,
  normalizeWorkspaceSearchLimit,
  scanSearchTextContent,
  type SearchCandidateScanResult,
  type TextMatchSpan,
  type WorkspaceSearchAccumulator,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
  type WorkspaceSearchSortPlan
} from '@shared/search'
import type { WorkspaceEntry } from '@shared/workspace'
import {
  WorkspaceDocumentScanner,
  type WorkspaceDocumentScannerDependencies,
  type WorkspaceScanSession
} from './WorkspaceDocumentScanner'

export type WorkspaceSearchServiceDependencies = WorkspaceDocumentScannerDependencies

interface SearchCandidate {
  entry: WorkspaceEntry
  relativePath: string
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

interface FrontmatterSearchPlan {
  schema: WorkspaceFrontmatterSchema | null
  conditions: readonly FrontmatterFilterCondition[]
  sortPlan: WorkspaceSearchSortPlan
}

const EMPTY_SCAN_RESULT: SearchCandidateScanResult = {
  lineMatches: [],
  totalMatchCount: 0,
  keptMatchCount: 0,
  truncatedInFile: false
}

/**
 * Executes session-scoped workspace text search combining the workspace filesystem and live
 * shared document buffers, enforcing security filters, frontmatter conditions/sorting, limits, and
 * scan cancellation.
 */
export class WorkspaceSearchService {
  private readonly scanner: WorkspaceDocumentScanner

  constructor(deps: WorkspaceSearchServiceDependencies) {
    this.scanner = new WorkspaceDocumentScanner(deps)
  }

  /**
   * Aborts any currently running workspace search scan for this session.
   */
  cancelActiveSearch(): void {
    this.scanner.cancelActiveScan()
  }

  /**
   * Searches workspace text filenames/paths and contents (preferring open workspace text buffers),
   * optionally filtering and sorting by workspace YAML frontmatter schema conditions.
   */
  search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> {
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

    return this.scanner.runSingleFlightScan(emptyWorkspaceSearchResponse(query), async (session) => {
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
      const schema = await session.loadSchema({ throwOnError: needsSchema })
      if (session.isInvalidated() || (hasConditions && !schema)) {
        return emptyWorkspaceSearchResponse(query)
      }

      const scanEntries = await session.listEligibleEntries({ onlyFrontmatterDocuments: hasConditions })
      if (!scanEntries || session.isInvalidated()) {
        return emptyWorkspaceSearchResponse(query)
      }

      const candidates: SearchCandidate[] = scanEntries.map((scanEntry) => ({
        entry: scanEntry.entry,
        relativePath: scanEntry.entry.relativePath,
        nameMatches: compiledMatcher ? compiledMatcher.findMatches(scanEntry.entry.relativePath) : [],
        isFrontmatterEligible: scanEntry.isFrontmatterEligible
      }))

      const sortPlan = createWorkspaceSearchSortPlan(sort, schema)
      if (!sortPlan.requiresFrontmatterValues) {
        candidates.sort(sortPlan.compare)
      }

      return this.scanCandidates({
        query,
        candidates,
        matcher: compiledMatcher,
        frontmatter: { schema, conditions, sortPlan },
        maxTotalMatches,
        maxMatchesPerFile,
        session
      })
    })
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
    maxTotalMatches: number
    maxMatchesPerFile: number
    session: WorkspaceScanSession
  }): Promise<WorkspaceSearchResponse> {
    const {
      query,
      candidates,
      matcher,
      frontmatter,
      maxTotalMatches,
      maxMatchesPerFile,
      session
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
    const needsPostScanSort = frontmatter.sortPlan.requiresFrontmatterValues
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

    await session.runWorkers(candidates, async (candidate, index) => {
      if (shouldStreamCommit && accumulator.stopBodyScanning && candidate.nameMatches.length === 0) {
        markSkipped(index)
        return
      }

      const text = await session.readCandidateTextSafe(candidate.entry)
      if (session.isInvalidated()) {
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
        () => session.signal.aborted
      )
      if (!scanned || session.isInvalidated()) {
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
    })

    if (session.isInvalidated()) {
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
          frontmatter.sortPlan.compare(
            {
              relativePath: a.candidate.relativePath,
              nameMatches: a.candidate.nameMatches,
              values: a.slot.values
            },
            {
              relativePath: b.candidate.relativePath,
              nameMatches: b.candidate.nameMatches,
              values: b.slot.values
            }
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
    this.scanner.dispose()
  }
}
