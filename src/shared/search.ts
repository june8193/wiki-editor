import { isSupportedImageFile } from './assets'
import {
  createFrontmatterFieldComparator,
  type FrontmatterFieldValue,
  type FrontmatterFilterCondition
} from './frontmatterFilter'
import type { WorkspaceFrontmatterSchema } from './frontmatterSchema'
import type { PaneId } from './window'
import { compareWorkspaceEntriesByRelativePath } from './workspace'

export interface WorkspaceSearchSortSpec {
  by: 'path' | 'frontmatter'
  fieldKey?: string
  direction: 'asc' | 'desc'
}

export interface FrontmatterSortableSearchEntry {
  relativePath: string
  nameMatches: TextMatchSpan[]
  values?: Readonly<Record<string, FrontmatterFieldValue | undefined>>
}

export interface WorkspaceSearchSortPlan {
  requiresFrontmatterValues: boolean
  compare: (a: FrontmatterSortableSearchEntry, b: FrontmatterSortableSearchEntry) => number
}

export interface SearchMatchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export interface TextMatchSpan {
  start: number // UTF-16 code unit offset (inclusive)
  end: number // UTF-16 code unit offset (exclusive)
}

export interface WorkspaceSearchFrontmatterQuery {
  conditions: FrontmatterFilterCondition[]
  sort?: WorkspaceSearchSortSpec
}

export interface WorkspaceSearchRequest {
  query: string
  options: SearchMatchOptions
  frontmatter?: WorkspaceSearchFrontmatterQuery
  maxTotalMatches?: number // 기본 1000
  maxMatchesPerFile?: number // 기본 100
}

export interface WorkspaceSearchLineMatch {
  lineNumber: number // 1-based line number
  lineText: string // 표시용 스니펫 문자열
  lineOffset: number // 원본 줄 시작 대비 lineText 시작 오프셋 (원본 컬럼 = lineOffset + span.start)
  matches: TextMatchSpan[] // lineText 기준 일치 구간 목록
}

export interface WorkspaceSearchFileResult {
  path: string
  relativePath: string
  name: string
  nameMatches: TextMatchSpan[] // relativePath 기준 파일명·경로 일치 구간
  lineMatches: WorkspaceSearchLineMatch[]
  totalMatchCount: number // 해당 파일의 전체 본문 일치 수 (상한 절단 전)
  truncatedInFile: boolean
  frontmatterSummary?: Record<string, FrontmatterFieldValue>
}

export interface WorkspaceSearchResponse {
  query: string
  files: WorkspaceSearchFileResult[]
  totalFileCount: number
  totalMatchCount: number
  truncated: boolean
  error?: string // 잘못된 정규식 등 검색식 오류
}

export interface DocumentJumpLocation {
  query: string
  options: SearchMatchOptions
  lineNumber: number // 1-based
  columnStart: number // 0-based UTF-16 offset within line
  columnEnd: number // 0-based UTF-16 offset within line
}

export interface DocumentJumpHighlightTarget extends DocumentJumpLocation {
  nonce: number
}

export interface DocumentSearchJumpRequest extends DocumentJumpHighlightTarget {
  paneId: PaneId
  tabId: string
}

export const DEFAULT_SEARCH_MATCH_OPTIONS: SearchMatchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false
}

export const DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES = 1000
export const DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE = 100
export const WORKSPACE_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

const SEARCH_SNIPPET_MAX_LENGTH = 240
const SEARCH_SNIPPET_LEAD_CONTEXT = 60

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

export interface CompiledSearchMatcher {
  findMatches(text: string): TextMatchSpan[]
}

export type CompileSearchMatcherResult =
  | { ok: true; matcher: CompiledSearchMatcher }
  | { ok: false; error: string }

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g
const UNICODE_NON_WORD_CHAR_CLASS = '[^\\p{L}\\p{M}\\p{N}_]'
const WHOLE_WORD_START_BOUNDARY = `(?:(?<=^|${UNICODE_NON_WORD_CHAR_CLASS})|(?=${UNICODE_NON_WORD_CHAR_CLASS}))`
const WHOLE_WORD_END_BOUNDARY = `(?:(?=$|${UNICODE_NON_WORD_CHAR_CLASS})|(?<=${UNICODE_NON_WORD_CHAR_CLASS}))`

function normalizeOptions(options?: Partial<SearchMatchOptions>): SearchMatchOptions {
  return {
    caseSensitive: Boolean(options?.caseSensitive),
    wholeWord: Boolean(options?.wholeWord),
    useRegex: Boolean(options?.useRegex)
  }
}

function advanceCodePointIndex(text: string, index: number): number {
  if (index >= text.length) {
    return text.length + 1
  }
  const codePoint = text.codePointAt(index)
  return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function formatRegexSyntaxError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail ? `잘못된 정규식입니다: ${detail}` : '잘못된 정규식입니다.'
}

/**
 * Compiles a reusable text matcher supporting case sensitivity, Unicode whole-word boundaries,
 * regex validation, and empty-match infinite-loop protection.
 */
export function compileSearchMatcher(
  query: string,
  options?: Partial<SearchMatchOptions>
): CompileSearchMatcherResult {
  const resolved = normalizeOptions(options)
  if (query.length === 0) {
    return {
      ok: true,
      matcher: {
        findMatches: () => []
      }
    }
  }

  const flags = resolved.caseSensitive ? 'gmu' : 'gimu'
  const basePattern = resolved.useRegex ? query : query.replace(REGEX_META_RE, '\\$&')

  let compiledRegex: RegExp
  try {
    // Validate the user pattern before wrapping so unbalanced parens cannot pass via wrapper groups.
    const validated = new RegExp(basePattern, flags)
    compiledRegex = resolved.wholeWord
      ? new RegExp(`${WHOLE_WORD_START_BOUNDARY}(?:${basePattern})${WHOLE_WORD_END_BOUNDARY}`, flags)
      : validated
  } catch (error) {
    return {
      ok: false,
      error: formatRegexSyntaxError(error)
    }
  }

  return {
    ok: true,
    matcher: {
      findMatches(text: string): TextMatchSpan[] {
        compiledRegex.lastIndex = 0
        const spans: TextMatchSpan[] = []
        let lastNonEmptyEnd = -1
        let match: RegExpExecArray | null

        while ((match = compiledRegex.exec(text)) !== null) {
          const start = match.index
          const matchedText = match[0]
          const end = start + matchedText.length

          if (matchedText.length === 0) {
            if (!resolved.wholeWord && start !== lastNonEmptyEnd) {
              spans.push({ start, end })
            }
            if (start >= text.length) {
              break
            }
            compiledRegex.lastIndex = advanceCodePointIndex(text, start)
            continue
          }

          lastNonEmptyEnd = end
          spans.push({ start, end })
        }

        return spans
      }
    }
  }
}

/**
 * Splits text into lines across CRLF, CR, and LF line endings so 1-based line numbers align with CodeMirror.
 */
export function splitSearchLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * Extracts a bounded UTF-16-safe snippet around the first match on a long line,
 * preserving `originalColumn = lineOffset + span.start`.
 */
export function extractLineSnippet(
  line: string,
  rawMatches: readonly TextMatchSpan[]
): { lineText: string; lineOffset: number; matches: TextMatchSpan[] } {
  if (line.length <= SEARCH_SNIPPET_MAX_LENGTH) {
    return {
      lineText: line,
      lineOffset: 0,
      matches: rawMatches.map((span) => ({ start: span.start, end: span.end }))
    }
  }

  const anchorStart = rawMatches.length > 0 ? rawMatches[0].start : 0
  let sliceStart = Math.max(
    0,
    Math.min(anchorStart - SEARCH_SNIPPET_LEAD_CONTEXT, line.length - SEARCH_SNIPPET_MAX_LENGTH)
  )
  if (
    sliceStart > 0 &&
    isLowSurrogate(line.charCodeAt(sliceStart)) &&
    isHighSurrogate(line.charCodeAt(sliceStart - 1))
  ) {
    // Advance past the preceding surrogate pair when possible so tail-clamped snippets still cover the anchor.
    sliceStart = sliceStart < anchorStart ? sliceStart + 1 : sliceStart - 1
  }

  let sliceEnd = Math.min(line.length, sliceStart + SEARCH_SNIPPET_MAX_LENGTH)
  if (
    sliceEnd < line.length &&
    sliceEnd > sliceStart &&
    isHighSurrogate(line.charCodeAt(sliceEnd - 1)) &&
    isLowSurrogate(line.charCodeAt(sliceEnd))
  ) {
    sliceEnd -= 1
  }

  const lineText = line.slice(sliceStart, sliceEnd)
  const matches: TextMatchSpan[] = []
  for (const span of rawMatches) {
    if (span.start === span.end) {
      if (span.start >= sliceStart && span.start <= sliceEnd) {
        const pos = span.start - sliceStart
        matches.push({ start: pos, end: pos })
      }
      continue
    }
    if (span.end <= sliceStart || span.start >= sliceEnd) {
      continue
    }
    const start = Math.max(span.start, sliceStart) - sliceStart
    const end = Math.min(span.end, sliceEnd) - sliceStart
    if (start < end) {
      matches.push({ start, end })
    }
  }

  return {
    lineText,
    lineOffset: sliceStart,
    matches
  }
}

/**
 * Compares workspace search file results, placing filename/path matches first
 * and sorting ties ascending by `relativePath`.
 */
export function compareWorkspaceSearchFileResults(
  a: Pick<WorkspaceSearchFileResult, 'relativePath' | 'nameMatches'>,
  b: Pick<WorkspaceSearchFileResult, 'relativePath' | 'nameMatches'>
): number {
  const aHasNameMatch = a.nameMatches.length > 0
  const bHasNameMatch = b.nameMatches.length > 0
  if (aHasNameMatch !== bHasNameMatch) {
    return aHasNameMatch ? -1 : 1
  }
  return compareWorkspaceEntriesByRelativePath(a, b)
}

/**
 * Resolves a reusable sort plan for `WorkspaceSearchSortSpec`, caching any frontmatter field
 * comparator once up front and falling back to default path order when invalid or omitted.
 */
export function createWorkspaceSearchSortPlan(
  sort: WorkspaceSearchSortSpec | undefined,
  schema: WorkspaceFrontmatterSchema | null | undefined
): WorkspaceSearchSortPlan {
  if (!sort || (sort.by === 'path' && sort.direction === 'asc')) {
    return {
      requiresFrontmatterValues: false,
      compare: compareWorkspaceSearchFileResults
    }
  }
  if (sort.by === 'path') {
    return {
      requiresFrontmatterValues: false,
      compare: (a, b) => compareWorkspaceEntriesByRelativePath(b, a)
    }
  }

  const field = sort.fieldKey ? schema?.fields.find((item) => item.key === sort.fieldKey) : undefined
  if (!field) {
    return {
      requiresFrontmatterValues: false,
      compare: compareWorkspaceSearchFileResults
    }
  }

  const compareValues = createFrontmatterFieldComparator(field, sort.direction)
  return {
    requiresFrontmatterValues: true,
    compare: (a, b) => {
      const cmp = compareValues(a.values?.[field.key], b.values?.[field.key])
      return cmp !== 0 ? cmp : compareWorkspaceEntriesByRelativePath(a, b)
    }
  }
}

/** Builds a `WorkspaceSearchFileResult`, omitting `frontmatterSummary` when undefined. */
export function buildWorkspaceSearchFileResult(fields: {
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

export interface SearchCandidateScanResult {
  lineMatches: WorkspaceSearchLineMatch[]
  totalMatchCount: number
  keptMatchCount: number
  truncatedInFile: boolean
}

export interface WorkspaceSearchAccumulator {
  files: WorkspaceSearchFileResult[]
  committedMatchCount: number
  truncated: boolean
  stopBodyScanning: boolean
  maxTotalMatches: number
}

/**
 * Returns true when `fileName` is an image or known binary extension excluded from workspace search.
 */
export function isExcludedSearchFileName(fileName: string): boolean {
  if (isSupportedImageFile(fileName)) {
    return true
  }
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return KNOWN_BINARY_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase())
}

/**
 * Normalizes a requested search result limit to a positive integer, falling back when invalid.
 */
export function normalizeWorkspaceSearchLimit(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

/**
 * Creates an empty WorkspaceSearchResponse, optionally carrying a structured query error.
 */
export function emptyWorkspaceSearchResponse(
  query: string,
  error?: string
): WorkspaceSearchResponse {
  return {
    query,
    files: [],
    totalFileCount: 0,
    totalMatchCount: 0,
    truncated: false,
    ...(error !== undefined ? { error } : {})
  }
}

/**
 * Scans UTF-8 text line by line against `matcher`, respecting `maxMatchesPerFile` and optional abort checks.
 */
export function scanSearchTextContent(
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

/**
 * Commits a scanned candidate file into the ordered response accumulator, enforcing `maxTotalMatches`.
 */
export function commitSearchCandidateSlot(
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
