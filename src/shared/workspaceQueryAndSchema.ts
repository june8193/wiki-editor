import { isSupportedImageFile } from './assets'
import { createAsyncQueue } from './asyncQueue'
import {
  cloneFrontmatterSchema,
  collectAllowCustomMultiSelectFields,
  createDefaultFrontmatterSchema,
  extractFrontmatterSummary,
  FRONTMATTER_SCHEMA_RELATIVE_PATH,
  type FrontmatterFieldDefinition,
  type FrontmatterFieldValue,
  type FrontmatterFilterCondition,
  type FrontmatterSchemaLoadResult,
  isExcludedFrontmatterRelativePath,
  isFrontmatterDocumentFileName,
  matchesFrontmatterConditions,
  parseFrontmatterDocument,
  parseFrontmatterSchema,
  parseFrontmatterSchemaJson,
  serializeFrontmatterSchema,
  type WorkspaceFrontmatterFieldValuesResponse,
  type WorkspaceFrontmatterSchema
} from './frontmatter'
import { compareLocaleStrings } from './frontmatterFilter'
import {
  compileSearchMatcher,
  type CompiledSearchMatcher,
  createWorkspaceSearchSortPlan,
  splitSearchLines,
  extractLineSnippet,
  type TextMatchSpan,
  WORKSPACE_SEARCH_MAX_FILE_BYTES,
  type WorkspaceSearchFileResult,
  type WorkspaceSearchLineMatch,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
  type WorkspaceSearchSortPlan
} from './search'
import type { SharedDocumentBufferHub } from './sharedDocumentBufferHub'
import {
  getWorkspacePathKey,
  isSameWorkspacePath,
  joinWorkspacePath,
  type WorkspaceEntry
} from './workspace'

export const SCHEMA_DIR_NOT_DIRECTORY_ERROR = '`.wiki-editor` 경로가 폴더가 아닙니다.'
export const SCHEMA_TARGET_NOT_FILE_ERROR = '스키마 경로가 파일이 아닙니다.'

export type SchemaRawReadResult =
  | { kind: 'missing'; schemaPath: string }
  | { kind: 'invalid-target'; schemaPath: string; error: string }
  | { kind: 'present'; schemaPath: string; rawText: string }

export interface WorkspaceQueryStorageListOptions {
  filterFileName?: (fileName: string) => boolean
  signal?: AbortSignal
}

export interface WorkspaceQueryStorageReadTextOptions {
  signal?: AbortSignal
}

export interface WorkspaceQueryAndSchemaStorage {
  getWorkspaceRoot(): string | null
  onWorkspaceRootChanged(listener: (rootPath: string | null) => Promise<void> | void): () => void
  listWorkspaceFiles(options?: WorkspaceQueryStorageListOptions): Promise<WorkspaceEntry[]>
  readTextFileForSearch(
    filePath: string,
    options?: WorkspaceQueryStorageReadTextOptions
  ): Promise<string | null>
  resolveRealPath?(targetPath: string): Promise<string>
  readSchemaRaw(rootPath: string): Promise<SchemaRawReadResult>
  writeSchemaRaw(rootPath: string, serializedSchema: string): Promise<{ schemaPath: string }>
  watchSchema?(rootPath: string, onPossibleChange: () => void): () => void
}

export type FrontmatterSchemaChangedListener = (result: FrontmatterSchemaLoadResult) => void

export interface WorkspaceQueryAndSchemaHubOptions {
  storage: WorkspaceQueryAndSchemaStorage
  bufferHub?: SharedDocumentBufferHub
  concurrency?: number
  onWarn?: (message: string, details: { rootPath: string; error: unknown }) => void
}

const DEFAULT_SCAN_CONCURRENCY = 8
const DEFAULT_MAX_TOTAL_MATCHES = 1000
const DEFAULT_MAX_MATCHES_PER_FILE = 100
const utf8Encoder = new TextEncoder()

/**
 * Returns `text` when it is valid searchable UTF-8 text without null bytes and within the 2MB cap.
 */
export function filterSearchableTextContent(text: string): string | null {
  if (text.includes('\0') || utf8Encoder.encode(text).byteLength > WORKSPACE_SEARCH_MAX_FILE_BYTES) {
    return null
  }
  return text
}

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

function isExcludedSearchFileName(fileName: string): boolean {
  if (isSupportedImageFile(fileName)) {
    return true
  }
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return KNOWN_BINARY_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase())
}

function normalizeSearchLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function emptyWorkspaceSearchResponse(query: string, error?: string): WorkspaceSearchResponse {
  return {
    query,
    files: [],
    totalFileCount: 0,
    totalMatchCount: 0,
    truncated: false,
    ...(error !== undefined ? { error } : {})
  }
}

function buildWorkspaceSearchFileResult(fields: {
  path: string
  relativePath: string
  name: string
  nameMatches: TextMatchSpan[]
  lineMatches: WorkspaceSearchLineMatch[]
  totalMatchCount: number
  truncatedInFile: boolean
  frontmatterSummary?: Record<string, FrontmatterFieldValue>
}): WorkspaceSearchFileResult {
  const { frontmatterSummary, ...rest } = fields
  return {
    ...rest,
    ...(frontmatterSummary !== undefined ? { frontmatterSummary } : {})
  }
}

interface SearchCandidateScanResult {
  lineMatches: WorkspaceSearchLineMatch[]
  totalMatchCount: number
  keptMatchCount: number
  truncatedInFile: boolean
}

interface WorkspaceSearchAccumulator {
  files: WorkspaceSearchFileResult[]
  committedMatchCount: number
  truncated: boolean
  stopBodyScanning: boolean
  maxTotalMatches: number
}

const EMPTY_SCAN_RESULT: SearchCandidateScanResult = {
  lineMatches: [],
  totalMatchCount: 0,
  keptMatchCount: 0,
  truncatedInFile: false
}

function scanSearchTextContent(
  text: string,
  matcher: CompiledSearchMatcher,
  maxMatchesPerFile: number,
  shouldAbort?: () => boolean
): SearchCandidateScanResult | null {
  const lines = splitSearchLines(text)
  const lineMatches: WorkspaceSearchLineMatch[] = []
  let totalMatchCount = 0
  let keptMatchCount = 0
  let truncatedInFile = false

  for (let index = 0; index < lines.length; index += 1) {
    if ((index & 1023) === 0 && shouldAbort?.()) {
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

function commitSearchCandidateSlot(
  accumulator: WorkspaceSearchAccumulator,
  candidate: {
    path: string
    relativePath: string
    name: string
    nameMatches: TextMatchSpan[]
    frontmatterSummary?: Record<string, FrontmatterFieldValue>
  },
  slot: SearchCandidateScanResult
): void {
  const remainingBudget = accumulator.maxTotalMatches - accumulator.committedMatchCount
  if (remainingBudget <= 0) {
    if (slot.totalMatchCount > 0) {
      accumulator.truncated = true
      accumulator.stopBodyScanning = true
    }
    if (candidate.nameMatches.length > 0) {
      accumulator.files.push(
        buildWorkspaceSearchFileResult({
          path: candidate.path,
          relativePath: candidate.relativePath,
          name: candidate.name,
          nameMatches: candidate.nameMatches,
          lineMatches: [],
          totalMatchCount: slot.totalMatchCount,
          truncatedInFile: slot.totalMatchCount > 0,
          frontmatterSummary: candidate.frontmatterSummary
        })
      )
    }
    return
  }

  if (slot.keptMatchCount > remainingBudget) {
    const trimmed = trimLineMatchesToBudget(slot.lineMatches, remainingBudget)
    accumulator.committedMatchCount += trimmed.keptCount
    accumulator.truncated = true
    accumulator.stopBodyScanning = true
    accumulator.files.push(
      buildWorkspaceSearchFileResult({
        path: candidate.path,
        relativePath: candidate.relativePath,
        name: candidate.name,
        nameMatches: candidate.nameMatches,
        lineMatches: trimmed.lineMatches,
        totalMatchCount: slot.totalMatchCount,
        truncatedInFile: true,
        frontmatterSummary: candidate.frontmatterSummary
      })
    )
    return
  }

  accumulator.committedMatchCount += slot.keptMatchCount
  if (candidate.nameMatches.length > 0 || slot.lineMatches.length > 0) {
    accumulator.files.push(
      buildWorkspaceSearchFileResult({
        path: candidate.path,
        relativePath: candidate.relativePath,
        name: candidate.name,
        nameMatches: candidate.nameMatches,
        lineMatches: slot.lineMatches,
        totalMatchCount: slot.totalMatchCount,
        truncatedInFile: slot.truncatedInFile,
        frontmatterSummary: candidate.frontmatterSummary
      })
    )
  }
}

interface ScanEntryCandidate {
  entry: WorkspaceEntry
  isFrontmatterEligible: boolean
}

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

interface ActiveScanSession {
  readonly signal: AbortSignal
  isInvalidated: () => boolean
  listEligibleEntries: (options?: {
    onlyFrontmatterDocuments?: boolean
  }) => Promise<ScanEntryCandidate[] | null>
  readCandidateTextSafe: (entry: WorkspaceEntry) => Promise<string | null>
  runWorkers: <TCandidate>(
    candidates: readonly TCandidate[],
    processCandidate: (candidate: TCandidate, index: number) => Promise<void>
  ) => Promise<void>
}

class SingleFlightScanLane {
  private activeController: AbortController | null = null

  cancel(): void {
    if (this.activeController) {
      this.activeController.abort()
      this.activeController = null
    }
  }

  begin(): { controller: AbortController; release: () => void } {
    this.cancel()
    const controller = new AbortController()
    this.activeController = controller
    return {
      controller,
      release: () => {
        if (this.activeController === controller) {
          this.activeController = null
        }
      }
    }
  }
}

interface FrontmatterFieldValuesCollector {
  addDocumentValues(docValues: Readonly<Record<string, FrontmatterFieldValue | undefined>>): void
  finalize(): WorkspaceFrontmatterFieldValuesResponse
}

function createFrontmatterFieldValuesCollector(
  targetFields: readonly FrontmatterFieldDefinition[]
): FrontmatterFieldValuesCollector {
  const byField = new Map<string, Set<string>>()
  for (const field of targetFields) {
    const set = new Set<string>()
    for (const opt of field.options ?? []) {
      if (opt.value.trim().length > 0) {
        set.add(opt.value)
      }
    }
    byField.set(field.key, set)
  }

  return {
    addDocumentValues(docValues) {
      for (const [fieldKey, valueSet] of byField.entries()) {
        const raw = docValues[fieldKey]
        if (!Array.isArray(raw)) continue
        for (const item of raw) {
          if (typeof item === 'string' && item.trim().length > 0) {
            valueSet.add(item)
          }
        }
      }
    },
    finalize() {
      const valuesByField: Record<string, string[]> = {}
      for (const [fieldKey, valueSet] of byField.entries()) {
        valuesByField[fieldKey] = [...valueSet].sort(compareLocaleStrings)
      }
      return { valuesByField }
    }
  }
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

function parseRawSchemaState(rawRead: SchemaRawReadResult): {
  result: FrontmatterSchemaLoadResult
  fingerprint: string
} {
  if (rawRead.kind === 'missing') {
    const result: FrontmatterSchemaLoadResult = {
      exists: false,
      path: rawRead.schemaPath,
      schema: null
    }
    return { result, fingerprint: computeSchemaFingerprint(result) }
  }

  if (rawRead.kind === 'invalid-target') {
    const result: FrontmatterSchemaLoadResult = {
      exists: true,
      path: rawRead.schemaPath,
      schema: null,
      error: rawRead.error
    }
    return { result, fingerprint: computeSchemaFingerprint(result) }
  }

  const parsed = parseFrontmatterSchemaJson(rawRead.rawText)
  if (!parsed.ok) {
    const result: FrontmatterSchemaLoadResult = {
      exists: true,
      path: rawRead.schemaPath,
      schema: null,
      error: parsed.error
    }
    return { result, fingerprint: computeSchemaFingerprint(result, rawRead.rawText) }
  }

  const result: FrontmatterSchemaLoadResult = {
    exists: true,
    path: rawRead.schemaPath,
    schema: parsed.schema
  }
  return { result, fingerprint: computeSchemaFingerprint(result) }
}

/**
 * Coordinates frontmatter schema lifecycle, workspace text/frontmatter search, and `allowCustom`
 * field value collection over a narrow storage seam and shared document buffer hub.
 */
export class WorkspaceQueryAndSchemaHub {
  private readonly storage: WorkspaceQueryAndSchemaStorage
  private readonly bufferHub?: SharedDocumentBufferHub
  private readonly concurrency: number
  private readonly onWarn?: (message: string, details: { rootPath: string; error: unknown }) => void
  private readonly schemaQueue = createAsyncQueue()
  private readonly schemaListeners = new Set<FrontmatterSchemaChangedListener>()
  private readonly searchLane = new SingleFlightScanLane()
  private readonly fieldValuesLane = new SingleFlightScanLane()
  private readonly unsubscribeRootChanged: () => void
  private readonly unsubscribeBufferHub?: () => void

  private stopSchemaWatcher: (() => void) | null = null
  private watchedRoot: string | null = null
  private lastKnownFingerprint: string | null = null
  private disposed = false

  constructor({
    storage,
    bufferHub,
    concurrency = DEFAULT_SCAN_CONCURRENCY,
    onWarn
  }: WorkspaceQueryAndSchemaHubOptions) {
    this.storage = storage
    this.bufferHub = bufferHub
    this.concurrency = Math.max(1, Math.floor(concurrency))
    this.onWarn = onWarn

    this.unsubscribeRootChanged = this.storage.onWorkspaceRootChanged((rootPath) =>
      this.handleWorkspaceRootChanged(rootPath)
    )
    this.unsubscribeBufferHub = this.bufferHub?.subscribe((event) => {
      if (
        !this.disposed &&
        event.type === 'workspace-saved' &&
        this.isSchemaFilePath(event.path)
      ) {
        void this.reloadSchemaIfChanged()
      }
    })

    const initialRoot = this.storage.getWorkspaceRoot()
    if (initialRoot) {
      void this.handleWorkspaceRootChanged(initialRoot)
    }
  }

  getSchemaPath(): string | null {
    const root = this.storage.getWorkspaceRoot()
    return root ? joinWorkspacePath(root, FRONTMATTER_SCHEMA_RELATIVE_PATH) : null
  }

  isSchemaFilePath(candidatePath: string): boolean {
    const schemaPath = this.getSchemaPath()
    return Boolean(schemaPath && isSameWorkspacePath(schemaPath, candidatePath))
  }

  getSchema(): Promise<FrontmatterSchemaLoadResult> {
    return this.schemaQueue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      const { result, fingerprint } = await this.readSchemaState(root)
      return this.seedBaselineAndClone(result, fingerprint)
    })
  }

  createDefaultSchema(): Promise<FrontmatterSchemaLoadResult> {
    return this.schemaQueue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      const rawRead = await this.storage.readSchemaRaw(root)
      if (rawRead.kind === 'invalid-target') {
        throw new Error(rawRead.error)
      }
      if (rawRead.kind === 'present') {
        const { result, fingerprint } = parseRawSchemaState(rawRead)
        return this.seedBaselineAndClone(result, fingerprint)
      }
      return this.persistSchema(root, createDefaultFrontmatterSchema())
    })
  }

  saveSchema(rawSchema: unknown): Promise<FrontmatterSchemaLoadResult> {
    const validation = parseFrontmatterSchema(rawSchema)
    if (!validation.ok) {
      return Promise.reject(new Error(validation.error))
    }
    return this.schemaQueue.enqueue(async () => {
      const root = this.requireWorkspaceRoot()
      return this.persistSchema(root, validation.schema)
    })
  }

  reloadSchemaIfChanged(): Promise<FrontmatterSchemaLoadResult | null> {
    return this.schemaQueue.enqueue(async () => {
      if (this.disposed) return null
      const root = this.storage.getWorkspaceRoot()
      if (!root) return null

      try {
        const { result, fingerprint } = await this.readSchemaState(root)
        if (this.disposed || this.storage.getWorkspaceRoot() !== root) {
          return null
        }
        if (this.lastKnownFingerprint === fingerprint) {
          return null
        }
        this.lastKnownFingerprint = fingerprint
        this.commitSchemaChange(result)
        return cloneSchemaLoadResult(result)
      } catch (error) {
        this.onWarn?.('Failed to reload frontmatter schema', { rootPath: root, error })
        return null
      }
    })
  }

  onSchemaChanged(listener: FrontmatterSchemaChangedListener): () => void {
    this.schemaListeners.add(listener)
    return () => {
      this.schemaListeners.delete(listener)
    }
  }

  cancelActiveScans(): void {
    this.searchLane.cancel()
    this.fieldValuesLane.cancel()
  }

  collectFieldValues(
    fieldKeys?: readonly string[]
  ): Promise<WorkspaceFrontmatterFieldValuesResponse> {
    return this.runSingleFlightScan(
      this.fieldValuesLane,
      { valuesByField: {} },
      async (session) => {
        const schema = await this.loadSchemaForScan(session.isInvalidated, true)
        if (session.isInvalidated() || !schema) {
          return { valuesByField: {} }
        }

        const targetFields = collectAllowCustomMultiSelectFields(schema, fieldKeys)
        if (targetFields.length === 0) {
          return { valuesByField: {} }
        }

        const scanEntries = await session.listEligibleEntries({ onlyFrontmatterDocuments: true })
        if (!scanEntries || session.isInvalidated()) {
          return { valuesByField: {} }
        }

        const collector = createFrontmatterFieldValuesCollector(targetFields)
        const narrowSchema: WorkspaceFrontmatterSchema = { version: 1, fields: targetFields }

        await session.runWorkers(scanEntries, async (scanEntry) => {
          const text = await session.readCandidateTextSafe(scanEntry.entry)
          if (text === null || session.isInvalidated()) {
            return
          }
          const parsed = parseFrontmatterDocument(text, narrowSchema)
          collector.addDocumentValues(parsed.values)
        })

        if (session.isInvalidated()) {
          return { valuesByField: {} }
        }

        return collector.finalize()
      }
    )
  }

  search(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse> {
    const query = typeof request?.query === 'string' ? request.query : ''
    const options = request?.options
    const frontmatterQuery = request?.frontmatter
    const conditions = Array.isArray(frontmatterQuery?.conditions)
      ? frontmatterQuery.conditions
      : []
    const sort = frontmatterQuery?.sort
    const hasConditions = conditions.length > 0
    const maxTotalMatches = normalizeSearchLimit(
      request?.maxTotalMatches,
      DEFAULT_MAX_TOTAL_MATCHES
    )
    const maxMatchesPerFile = normalizeSearchLimit(
      request?.maxMatchesPerFile,
      DEFAULT_MAX_MATCHES_PER_FILE
    )

    return this.runSingleFlightScan(
      this.searchLane,
      emptyWorkspaceSearchResponse(query),
      async (session) => {
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
        const schema = await this.loadSchemaForScan(session.isInvalidated, needsSchema)
        if (session.isInvalidated() || (hasConditions && !schema)) {
          return emptyWorkspaceSearchResponse(query)
        }

        const scanEntries = await session.listEligibleEntries({
          onlyFrontmatterDocuments: hasConditions
        })
        if (!scanEntries || session.isInvalidated()) {
          return emptyWorkspaceSearchResponse(query)
        }

        const candidates: SearchCandidate[] = scanEntries.map((scanEntry) => ({
          entry: scanEntry.entry,
          relativePath: scanEntry.entry.relativePath,
          nameMatches: compiledMatcher
            ? compiledMatcher.findMatches(scanEntry.entry.relativePath)
            : [],
          isFrontmatterEligible: scanEntry.isFrontmatterEligible
        }))

        const sortPlan = createWorkspaceSearchSortPlan(sort, schema)
        if (!sortPlan.requiresFrontmatterValues) {
          candidates.sort(sortPlan.compare)
        }

        return this.scanSearchCandidates({
          query,
          candidates,
          matcher: compiledMatcher,
          frontmatter: { schema, conditions, sortPlan },
          maxTotalMatches,
          maxMatchesPerFile,
          session
        })
      }
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelActiveScans()
    this.stopSchemaWatch()
    this.unsubscribeRootChanged()
    this.unsubscribeBufferHub?.()
    this.schemaListeners.clear()
    this.lastKnownFingerprint = null
  }

  private requireWorkspaceRoot(): string {
    const root = this.storage.getWorkspaceRoot()
    if (!root) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return root
  }

  private seedBaselineAndClone(
    result: FrontmatterSchemaLoadResult,
    fingerprint: string
  ): FrontmatterSchemaLoadResult {
    // Preserve unbroadcasted fingerprint deltas until reloadSchemaIfChanged/persistSchema commits them.
    if (this.lastKnownFingerprint === null) {
      this.lastKnownFingerprint = fingerprint
    }
    return cloneSchemaLoadResult(result)
  }

  private async readSchemaState(rootPath: string): Promise<{
    result: FrontmatterSchemaLoadResult
    fingerprint: string
  }> {
    const rawRead = await this.storage.readSchemaRaw(rootPath)
    return parseRawSchemaState(rawRead)
  }

  private async persistSchema(
    rootPath: string,
    schema: WorkspaceFrontmatterSchema
  ): Promise<FrontmatterSchemaLoadResult> {
    const { schemaPath } = await this.storage.writeSchemaRaw(
      rootPath,
      serializeFrontmatterSchema(schema)
    )
    const result: FrontmatterSchemaLoadResult = {
      exists: true,
      path: schemaPath,
      schema
    }
    this.lastKnownFingerprint = computeSchemaFingerprint(result)
    this.commitSchemaChange(result)
    return cloneSchemaLoadResult(result)
  }

  private async handleWorkspaceRootChanged(rootPath: string | null): Promise<void> {
    this.cancelActiveScans()
    this.stopSchemaWatch()
    this.lastKnownFingerprint = null
    if (this.disposed || !rootPath) {
      return
    }
    this.startSchemaWatch(rootPath)
    await this.schemaQueue.enqueue(async () => {
      if (this.disposed || this.storage.getWorkspaceRoot() !== rootPath) {
        return
      }
      try {
        const { fingerprint } = await this.readSchemaState(rootPath)
        this.lastKnownFingerprint = fingerprint
      } catch {
        this.lastKnownFingerprint = null
      }
    })
  }

  private async runSingleFlightScan<TResult>(
    lane: SingleFlightScanLane,
    emptyResult: TResult,
    execute: (session: ActiveScanSession) => Promise<TResult>
  ): Promise<TResult> {
    if (this.disposed) {
      return emptyResult
    }
    const capturedRoot = this.storage.getWorkspaceRoot()
    if (!capturedRoot) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }

    const { controller, release } = lane.begin()
    if (this.disposed) {
      release()
      return emptyResult
    }

    const isInvalidated = (): boolean =>
      this.disposed ||
      controller.signal.aborted ||
      this.storage.getWorkspaceRoot() !== capturedRoot

    let openBuffersPromise: Promise<Map<string, string>> | null = null
    const getOpenTextBuffersByKey = (): Promise<Map<string, string>> => {
      openBuffersPromise ??= this.collectOpenTextBuffers()
      return openBuffersPromise
    }

    const session: ActiveScanSession = {
      signal: controller.signal,
      isInvalidated,
      listEligibleEntries: (opts) =>
        this.listEligibleEntries(opts, controller.signal, isInvalidated),
      readCandidateTextSafe: (entry) =>
        this.readCandidateTextSafe(
          entry,
          getOpenTextBuffersByKey,
          controller.signal,
          isInvalidated
        ),
      runWorkers: (candidates, processCandidate) =>
        this.runWorkers(candidates, processCandidate, isInvalidated)
    }

    try {
      return await execute(session)
    } finally {
      release()
    }
  }

  private async loadSchemaForScan(
    isInvalidated: () => boolean,
    throwOnError: boolean
  ): Promise<WorkspaceFrontmatterSchema | null> {
    try {
      const loaded = await this.getSchema()
      return loaded.schema
    } catch (error) {
      if (isInvalidated()) {
        return null
      }
      if (throwOnError) {
        throw error
      }
      return null
    }
  }

  private async collectOpenTextBuffers(): Promise<Map<string, string>> {
    const bufferMap = new Map<string, string>()
    if (!this.bufferHub) {
      return bufferMap
    }
    for (const buffer of Object.values(this.bufferHub.getSnapshot().buffers)) {
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
      if (this.storage.resolveRealPath) {
        try {
          const realKey = getWorkspacePathKey(await this.storage.resolveRealPath(buffer.path))
          if (realKey && !bufferMap.has(realKey)) {
            bufferMap.set(realKey, buffer.content)
          }
        } catch {
          // Ignore unresolvable paths; storage enumeration decides which workspace files exist.
        }
      }
    }
    return bufferMap
  }

  private async listEligibleEntries(
    options: { onlyFrontmatterDocuments?: boolean } = {},
    signal: AbortSignal,
    isInvalidated: () => boolean
  ): Promise<ScanEntryCandidate[] | null> {
    const onlyFrontmatterDocuments = options.onlyFrontmatterDocuments ?? false
    let entries: WorkspaceEntry[]
    try {
      entries = await this.storage.listWorkspaceFiles({
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

    const scanEntries: ScanEntryCandidate[] = []
    for (const entry of entries) {
      const isFrontmatterEligible =
        !isExcludedFrontmatterRelativePath(entry.relativePath) &&
        (onlyFrontmatterDocuments || isFrontmatterDocumentFileName(entry.name))
      if (!onlyFrontmatterDocuments || isFrontmatterEligible) {
        scanEntries.push({ entry, isFrontmatterEligible })
      }
    }
    return scanEntries
  }

  private async readCandidateTextSafe(
    entry: WorkspaceEntry,
    getOpenTextBuffersByKey: () => Promise<Map<string, string>>,
    signal: AbortSignal,
    isInvalidated: () => boolean
  ): Promise<string | null> {
    const openTextBuffersByKey = await getOpenTextBuffersByKey()
    if (isInvalidated()) {
      return null
    }
    const openContent = openTextBuffersByKey.get(getWorkspacePathKey(entry.path))
    if (openContent !== undefined) {
      return filterSearchableTextContent(openContent)
    }
    try {
      return await this.storage.readTextFileForSearch(entry.path, { signal })
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

  private async scanSearchCandidates(params: {
    query: string
    candidates: readonly SearchCandidate[]
    matcher: CompiledSearchMatcher | null
    frontmatter: FrontmatterSearchPlan
    maxTotalMatches: number
    maxMatchesPerFile: number
    session: ActiveScanSession
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

  private startSchemaWatch(rootPath: string): void {
    if (!this.storage.watchSchema) {
      return
    }
    this.watchedRoot = rootPath
    this.stopSchemaWatcher = this.storage.watchSchema(rootPath, () => {
      if (this.disposed || this.watchedRoot !== rootPath) {
        return
      }
      void this.reloadSchemaIfChanged()
    })
  }

  private stopSchemaWatch(): void {
    this.watchedRoot = null
    if (this.stopSchemaWatcher) {
      this.stopSchemaWatcher()
      this.stopSchemaWatcher = null
    }
  }

  private commitSchemaChange(result: FrontmatterSchemaLoadResult): void {
    if (this.bufferHub && result.exists && result.path && this.bufferHub.hasBuffer(result.path)) {
      void this.bufferHub.refreshCleanWorkspaceFile(result.path).catch(() => undefined)
    }
    for (const listener of [...this.schemaListeners]) {
      listener(cloneSchemaLoadResult(result))
    }
  }
}
