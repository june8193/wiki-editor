import type { TextEncoding } from './encoding'

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'property'

export interface SymbolRange {
  /** 1-based line number */
  lineNumber: number
  /** 0-based column start */
  columnStart: number
  /** 0-based column end */
  columnEnd: number
}

export interface DocumentSymbolItem extends SymbolRange {
  name: string
  kind: SymbolKind
  containerName?: string
  diffChange?: 'added' | 'modified'
}

export interface SymbolIdentifierToken extends SymbolRange {
  name: string
  isDeclaration: boolean
}

export const GIT_BLOB_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
export const DEFAULT_SYMBOL_QUERY_MAX_RESULTS = 200

export type CodeSourceScope =
  | { kind: 'working-tree' }
  | { kind: 'git-ref'; ref: string; displayRef: string; untrackedParentRef?: string }
  | { kind: 'git-index'; displayRef: string }

export interface GitBlobSnapshotRequest {
  path: string
  scope: Exclude<CodeSourceScope, { kind: 'working-tree' }>
  stashHash?: string
}

export interface GitBlobSnapshot {
  path: string
  scope: Exclude<CodeSourceScope, { kind: 'working-tree' }>
  isBinary: boolean
  isTruncated: boolean
  existsInWorkspace: boolean
  encoding: TextEncoding
  content: string
}

export interface SymbolQueryRequest {
  symbolName?: string
  declarationQuery?: string
  scope: CodeSourceScope
  maxResults?: number
}

export interface SymbolCandidateMatch {
  path: string
  lineNumber: number
  lineText: string
  columnStart: number
  columnEnd: number
}

export interface SnapshotTabState {
  request: GitBlobSnapshotRequest
  isPreview?: boolean
  scrollTop: number
}

export const MAX_SYMBOL_QUERY_RESULTS = 1000

export interface NormalizedSymbolQuery {
  mode: 'symbol' | 'declaration'
  term: string
  maxResults: number
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const SYMBOL_DECLARATION_KEYWORDS = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'struct',
  'trait',
  'impl',
  'def',
  'fn',
  'func',
  'const',
  'let',
  'var',
  'val',
  'module',
  'namespace',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'override',
  'virtual',
  'pub'
] as const

const DECLARATION_LINE_RE = new RegExp(
  `(?:^|[^\\w$])(${SYMBOL_DECLARATION_KEYWORDS.join('|')})\\s+|^\\s*(?:export\\s+)?(?:async\\s+)?[A-Za-z_$][\\w$]*\\s*[:=(<]`
)

/**
 * Normalizes a `SymbolQueryRequest` into a validated mode, term, and bounded `maxResults`.
 */
export function normalizeSymbolQuery(request: SymbolQueryRequest): NormalizedSymbolQuery | null {
  const maxResults =
    typeof request?.maxResults === 'number' &&
    Number.isFinite(request.maxResults) &&
    request.maxResults >= 1
      ? Math.min(Math.floor(request.maxResults), MAX_SYMBOL_QUERY_RESULTS)
      : DEFAULT_SYMBOL_QUERY_MAX_RESULTS

  const symbolName = typeof request?.symbolName === 'string' ? request.symbolName.trim() : ''
  if (symbolName.length > 0) {
    return { mode: 'symbol', term: symbolName, maxResults }
  }

  const declarationQuery =
    typeof request?.declarationQuery === 'string' ? request.declarationQuery.trim() : ''
  if (declarationQuery.length > 0) {
    return { mode: 'declaration', term: declarationQuery, maxResults }
  }

  return null
}

/**
 * Finds the first matching symbol/declaration span on a single line, or `null` if not matched.
 */
export function findSymbolSpanInLine(
  lineText: string,
  query: NormalizedSymbolQuery
): { columnStart: number; columnEnd: number } | null {
  if (query.mode === 'symbol') {
    const escaped = escapeRegExp(query.term)
    const re = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`)
    const match = re.exec(lineText)
    if (!match) {
      return null
    }
    return { columnStart: match.index, columnEnd: match.index + match[0].length }
  }

  if (!DECLARATION_LINE_RE.test(lineText)) {
    return null
  }
  const lowerLine = lineText.toLowerCase()
  const lowerTerm = query.term.toLowerCase()
  const idx = lowerLine.indexOf(lowerTerm)
  if (idx < 0) {
    return null
  }
  return { columnStart: idx, columnEnd: idx + query.term.length }
}

/**
 * Scans in-memory file text for symbol or declaration candidate matches up to `maxRemaining`.
 */
export function scanTextForSymbolCandidates(
  relativePath: string,
  content: string,
  query: NormalizedSymbolQuery,
  maxRemaining: number,
  shouldAbort?: () => boolean
): SymbolCandidateMatch[] {
  if (maxRemaining <= 0 || content.includes('\0')) {
    return []
  }

  const normalizedContent = content.replace(/\r\n/g, '\n')
  const lines = normalizedContent.split('\n')
  const matches: SymbolCandidateMatch[] = []

  for (let i = 0; i < lines.length; i += 1) {
    if ((i & 1023) === 0 && shouldAbort?.()) {
      return matches
    }
    const lineText = lines[i]
    const span = findSymbolSpanInLine(lineText, query)
    if (!span) {
      continue
    }
    matches.push({
      path: relativePath,
      lineNumber: i + 1,
      lineText,
      columnStart: span.columnStart,
      columnEnd: span.columnEnd
    })
    if (matches.length >= maxRemaining) {
      break
    }
  }

  return matches
}
