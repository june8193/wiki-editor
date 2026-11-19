import { compareWorkspaceEntriesByRelativePath } from './workspace'

export interface SearchMatchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export interface TextMatchSpan {
  start: number // UTF-16 code unit offset (inclusive)
  end: number // UTF-16 code unit offset (exclusive)
}

export interface WorkspaceSearchRequest {
  query: string
  options: SearchMatchOptions
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
}

export interface WorkspaceSearchResponse {
  query: string
  files: WorkspaceSearchFileResult[]
  totalFileCount: number
  totalMatchCount: number
  truncated: boolean
  error?: string // 잘못된 정규식 등 검색식 오류
}

export const DEFAULT_SEARCH_MATCH_OPTIONS: SearchMatchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false
}

export const DEFAULT_WORKSPACE_SEARCH_MAX_TOTAL_MATCHES = 1000
export const DEFAULT_WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE = 100

const SEARCH_SNIPPET_MAX_LENGTH = 240
const SEARCH_SNIPPET_LEAD_CONTEXT = 60

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
