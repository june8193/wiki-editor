import {
  escapeRegExp,
  findSymbolSpanInLine,
  normalizeSymbolQuery,
  SYMBOL_DECLARATION_KEYWORDS,
  type NormalizedSymbolQuery,
  type SymbolCandidateMatch,
  type SymbolQueryRequest
} from '@shared/symbol'
import { isExcludedWorkspaceRelativePath } from '@shared/workspaceQueryAndSchema'
import { decodeTextAuto } from '../encoding/textEncoding'
import { assertValidSnapshotRef } from './gitBlobSnapshot'
import { spawnGitStdoutStream, type GitDiffExecOptions } from './gitDiff'

const MAX_GREP_BUFFER_BYTES = 16 * 1024 * 1024

function buildDeclarationErePattern(term: string): string {
  const escaped = escapeRegExp(term)
  const keywords = SYMBOL_DECLARATION_KEYWORDS.join('|')
  return (
    `((^|[^[:alnum:]_$])(${keywords})[[:space:]].*${escaped})` +
    `|(^[[:space:]]*(export[[:space:]]+)?(async[[:space:]]+)?[[:alnum:]_$]*${escaped}[[:alnum:]_$]*[[:space:]]*[:=(<])`
  )
}

function isMissingRevisionError(stderr: string): boolean {
  return /bad revision|unknown revision|unable to resolve revision|ambiguous argument|Needed a single revision|Not a valid object name/i.test(
    stderr
  )
}

function stripGitRefPrefix(rawPath: string, refPrefix?: string): string {
  if (refPrefix && rawPath.startsWith(`${refPrefix}:`)) {
    return rawPath.slice(refPrefix.length + 1)
  }
  return rawPath
}

function parseGitGrepRecord(
  lineBytes: Buffer,
  query: NormalizedSymbolQuery,
  refPrefix?: string
): SymbolCandidateMatch | null {
  const firstNul = lineBytes.indexOf(0)
  if (firstNul <= 0) {
    return null
  }
  const secondNul = lineBytes.indexOf(0, firstNul + 1)
  if (secondNul <= firstNul) {
    return null
  }

  const rawPath = lineBytes.subarray(0, firstNul).toString('utf8')
  const relativePath = stripGitRefPrefix(rawPath, refPrefix).replace(/\\/g, '/')
  if (!relativePath || isExcludedWorkspaceRelativePath(relativePath)) {
    return null
  }

  const lineNumStr = lineBytes.subarray(firstNul + 1, secondNul).toString('utf8')
  const lineNumber = Number.parseInt(lineNumStr, 10)
  if (!Number.isFinite(lineNumber) || lineNumber < 1) {
    return null
  }

  let textBytes = lineBytes.subarray(secondNul + 1)
  if (textBytes.length > 0 && textBytes[textBytes.length - 1] === 0x0d) {
    textBytes = textBytes.subarray(0, textBytes.length - 1)
  }
  const { content: lineText } = decodeTextAuto(textBytes)
  const span = findSymbolSpanInLine(lineText, query)
  if (!span) {
    return null
  }

  return {
    path: relativePath,
    lineNumber,
    lineText,
    columnStart: span.columnStart,
    columnEnd: span.columnEnd
  }
}

async function execGitGrepSingleTarget(params: {
  repoRoot: string
  args: readonly string[]
  query: NormalizedSymbolQuery
  maxRemaining: number
  refPrefix?: string
  execOptions: GitDiffExecOptions
  signal?: AbortSignal
}): Promise<SymbolCandidateMatch[]> {
  const { repoRoot, args, query, maxRemaining, refPrefix, execOptions, signal } = params
  if (maxRemaining <= 0 || signal?.aborted) {
    return []
  }

  const matches: SymbolCandidateMatch[] = []
  let pendingChunk: Buffer = Buffer.alloc(0)
  let totalBytes = 0
  let reachedLimit = false

  const processLine = (lineBytes: Buffer, stopEarly: () => void): void => {
    if (reachedLimit || lineBytes.length === 0) {
      return
    }
    const parsed = parseGitGrepRecord(lineBytes, query, refPrefix)
    if (!parsed) {
      return
    }
    matches.push(parsed)
    if (matches.length >= maxRemaining) {
      reachedLimit = true
      stopEarly()
    }
  }

  const { aborted } = await spawnGitStdoutStream({
    cwd: repoRoot,
    args,
    execOptions,
    signal,
    onStdout: (chunk, stopEarly) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_GREP_BUFFER_BYTES) {
        reachedLimit = true
        stopEarly()
        return
      }

      const combined = pendingChunk.length > 0 ? Buffer.concat([pendingChunk, chunk]) : chunk
      let start = 0
      while (true) {
        const nl = combined.indexOf(0x0a, start)
        if (nl === -1) {
          break
        }
        processLine(combined.subarray(start, nl), stopEarly)
        if (reachedLimit) {
          pendingChunk = Buffer.alloc(0)
          return
        }
        start = nl + 1
      }
      pendingChunk = start < combined.length ? Buffer.from(combined.subarray(start)) : Buffer.alloc(0)
    },
    onClose: () => {
      if (!reachedLimit && pendingChunk.length > 0) {
        processLine(pendingChunk, () => undefined)
      }
    },
    acceptExitCode: (code, stderr) => code === 0 || code === 1 || isMissingRevisionError(stderr)
  })

  return aborted ? [] : matches
}

export interface GrepGitSymbolsOptions {
  repoRoot: string
  request: SymbolQueryRequest
  execOptions: GitDiffExecOptions
  signal?: AbortSignal
}

export function validateSymbolQueryScope(scope: SymbolQueryRequest['scope']): {
  ref?: string
  untrackedParentRef?: string
} {
  if (!scope || typeof scope !== 'object') {
    throw new Error('유효하지 않은 심볼 검색 범위입니다.')
  }
  if (scope.kind === 'working-tree' || scope.kind === 'git-index') {
    return {}
  }
  if (scope.kind === 'git-ref') {
    const ref = assertValidSnapshotRef(scope.ref, '심볼 검색 Ref')
    const untrackedParentRef =
      scope.untrackedParentRef !== undefined
        ? assertValidSnapshotRef(scope.untrackedParentRef, '미추적 부모 Ref')
        : undefined
    return { ref, untrackedParentRef }
  }
  throw new Error('유효하지 않은 심볼 검색 범위입니다.')
}

export async function grepGitSymbols({
  repoRoot,
  request,
  execOptions,
  signal
}: GrepGitSymbolsOptions): Promise<SymbolCandidateMatch[]> {
  const validatedScope = validateSymbolQueryScope(request.scope)
  const query = normalizeSymbolQuery(request)
  if (!query || signal?.aborted) {
    return []
  }

  const baseArgs =
    query.mode === 'symbol'
      ? ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '-w', '-F', '-z', '--full-name', '-e', query.term]
      : [
          '-c',
          'core.quotePath=false',
          'grep',
          '-n',
          '-I',
          '-i',
          '-E',
          '-z',
          '--full-name',
          '-e',
          buildDeclarationErePattern(query.term)
        ]

  const pathspec = ['--', '.', ':!.git', ':!.wiki-editor', ':!node_modules']

  if (request.scope.kind === 'working-tree') {
    return execGitGrepSingleTarget({
      repoRoot,
      args: [...baseArgs, '--untracked', ...pathspec],
      query,
      maxRemaining: query.maxResults,
      execOptions,
      signal
    })
  }

  if (request.scope.kind === 'git-index') {
    return execGitGrepSingleTarget({
      repoRoot,
      args: [...baseArgs, '--cached', ...pathspec],
      query,
      maxRemaining: query.maxResults,
      execOptions,
      signal
    })
  }

  const primaryMatches = await execGitGrepSingleTarget({
    repoRoot,
    args: [...baseArgs, validatedScope.ref!, ...pathspec],
    query,
    maxRemaining: query.maxResults,
    refPrefix: validatedScope.ref,
    execOptions,
    signal
  })

  if (
    !validatedScope.untrackedParentRef ||
    primaryMatches.length >= query.maxResults ||
    signal?.aborted
  ) {
    return primaryMatches
  }

  const untrackedMatches = await execGitGrepSingleTarget({
    repoRoot,
    args: [...baseArgs, validatedScope.untrackedParentRef, ...pathspec],
    query,
    maxRemaining: query.maxResults - primaryMatches.length,
    refPrefix: validatedScope.untrackedParentRef,
    execOptions,
    signal
  })

  return [...primaryMatches, ...untrackedMatches]
}
