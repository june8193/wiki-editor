import type { GitDiffRequest } from '@shared/git'
import type { CodeSourceScope, SymbolCandidateMatch } from '@shared/symbol'
import type { CodeParser } from './codeBlockHighlight'
import { extractDocumentSymbols, extractIdentifierAtPosition } from './codeSymbolExtractor'

/**
 * Returns true when the primary symbol-navigation modifier (`Ctrl` or `Cmd`) is held without `Alt`.
 */
export function isSymbolModifierPressed(
  event: Pick<MouseEvent | KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>
): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey
}

/**
 * Returns true when the Find References shortcut (`Shift+F12` without other modifiers) is pressed.
 */
export function isFindReferencesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>
): boolean {
  return event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'F12'
}

const MAX_CANDIDATE_FILES_TO_VERIFY = 30

export function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

function getDirName(filePath: string): string {
  const normalized = normalizeRepoPath(filePath)
  const idx = normalized.lastIndexOf('/')
  return idx > 0 ? normalized.slice(0, idx) : ''
}

function getSharedDirDepth(dirA: string, dirB: string): number {
  if (!dirA || !dirB) return 0
  const partsA = dirA.split('/')
  const partsB = dirB.split('/')
  const len = Math.min(partsA.length, partsB.length)
  let shared = 0
  for (let i = 0; i < len; i += 1) {
    if (partsA[i] !== partsB[i]) break
    shared += 1
  }
  return shared
}

/**
 * Resolves the Git or working-tree `CodeSourceScope` for a clicked line in `GitDiffViewer`.
 */
export function resolveDiffLineScope(
  request: GitDiffRequest,
  side: 'old' | 'new'
): CodeSourceScope {
  switch (request.kind) {
    case 'unstaged':
      return side === 'old'
        ? { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        : { kind: 'working-tree' }
    case 'staged':
      return side === 'old'
        ? { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
        : { kind: 'git-index', displayRef: 'Staged' }
    case 'commit': {
      const shortHash = request.commitHash.slice(0, 7)
      return side === 'old'
        ? { kind: 'git-ref', ref: `${request.commitHash}^1`, displayRef: `${shortHash}^1` }
        : { kind: 'git-ref', ref: request.commitHash, displayRef: shortHash }
    }
    case 'stash':
      return side === 'old'
        ? {
            kind: 'git-ref',
            ref: `${request.stashHash}^1`,
            displayRef: `${request.stashRef}^1`
          }
        : {
            kind: 'git-ref',
            ref: request.stashHash,
            displayRef: request.stashRef,
            untrackedParentRef: `${request.stashHash}^3`
          }
    case 'branch-compare': {
      if (side === 'old') {
        const ref = request.mergeBaseHash ?? request.baseRef
        const displayRef = request.mergeBaseHash ? request.mergeBaseHash.slice(0, 7) : request.baseRef
        return { kind: 'git-ref', ref, displayRef }
      }
      return { kind: 'git-ref', ref: request.compareRef, displayRef: request.compareRef }
    }
  }
}

export interface CandidateRankingContext {
  currentFilePath: string
  changedFilePaths?: ReadonlySet<string>
  isInActiveDiffHunk?: (candidate: SymbolCandidateMatch) => boolean
}

/**
 * Ranks symbol declaration candidates by locality:
 * 1) current file -> 2) active diff/compare changed files (hunk internal first) ->
 * 3) same/adjacent directory -> 4) repo-relative path order.
 */
export function rankDeclarationCandidates(
  candidates: readonly SymbolCandidateMatch[],
  context: CandidateRankingContext
): SymbolCandidateMatch[] {
  const currentNorm = normalizeRepoPath(context.currentFilePath)
  const currentDir = getDirName(currentNorm)

  const getTier = (candidate: SymbolCandidateMatch): number => {
    const norm = normalizeRepoPath(candidate.path)
    if (norm === currentNorm) return 0
    if (context.changedFilePaths?.has(norm)) return 1
    const dir = getDirName(norm)
    if (dir === currentDir || getSharedDirDepth(dir, currentDir) > 0) return 2
    return 3
  }

  return [...candidates].sort((a, b) => {
    const tierA = getTier(a)
    const tierB = getTier(b)
    if (tierA !== tierB) return tierA - tierB

    if (tierA === 1 && context.isInActiveDiffHunk) {
      const hunkA = context.isInActiveDiffHunk(a) ? 0 : 1
      const hunkB = context.isInActiveDiffHunk(b) ? 0 : 1
      if (hunkA !== hunkB) return hunkA - hunkB
    }

    if (tierA === 2) {
      const dirA = getDirName(normalizeRepoPath(a.path))
      const dirB = getDirName(normalizeRepoPath(b.path))
      const exactA = dirA === currentDir ? 1 : 0
      const exactB = dirB === currentDir ? 1 : 0
      if (exactA !== exactB) return exactB - exactA
      const depthDiff = getSharedDirDepth(dirB, currentDir) - getSharedDirDepth(dirA, currentDir)
      if (depthDiff !== 0) return depthDiff
    }

    const pathCmp = normalizeRepoPath(a.path).localeCompare(normalizeRepoPath(b.path))
    if (pathCmp !== 0) return pathCmp
    return a.lineNumber - b.lineNumber
  })
}

export interface ResolveSymbolDefinitionsOptions {
  symbolName: string
  scope: CodeSourceScope
  currentFilePath: string
  currentFileContent: string | null
  workspaceRootPath: string
  changedFilePaths?: ReadonlySet<string>
  isInActiveDiffHunk?: (candidate: SymbolCandidateMatch) => boolean
  searchSymbols: (symbolName: string, scope: CodeSourceScope) => Promise<SymbolCandidateMatch[]>
  readFileContent: (repoRelativePath: string, scope: CodeSourceScope) => Promise<string | null>
  getParserForPath: (filePath: string) => Promise<CodeParser | null> | CodeParser | null
}

export type SymbolDefinitionResolution =
  | { status: 'single'; target: SymbolCandidateMatch }
  | { status: 'multiple'; candidates: SymbolCandidateMatch[] }
  | { status: 'not-found' }

async function collectVerifiedCandidates(
  options: Pick<
    ResolveSymbolDefinitionsOptions,
    'symbolName' | 'scope' | 'currentFilePath' | 'currentFileContent' | 'searchSymbols' | 'readFileContent' | 'getParserForPath'
  >,
  verifiedByKey: Map<string, SymbolCandidateMatch>,
  policy: {
    getKey: (normPath: string, candidate: SymbolCandidateMatch) => string
    acceptToken: (token: NonNullable<ReturnType<typeof extractIdentifierAtPosition>>) => boolean
  }
): Promise<void> {
  const {
    symbolName,
    scope,
    currentFilePath,
    currentFileContent,
    searchSymbols,
    readFileContent,
    getParserForPath
  } = options

  const rawCandidates = await searchSymbols(symbolName, scope)
  const contentCache = new Map<string, string | null>()
  if (currentFileContent !== null) {
    contentCache.set(normalizeRepoPath(currentFilePath), currentFileContent)
  }

  let filesRead = 0
  for (const candidate of rawCandidates) {
    const normPath = normalizeRepoPath(candidate.path)
    const key = policy.getKey(normPath, candidate)
    if (verifiedByKey.has(key)) continue

    let content = contentCache.get(normPath)
    if (content === undefined) {
      if (filesRead >= MAX_CANDIDATE_FILES_TO_VERIFY) continue
      filesRead += 1
      content = await readFileContent(normPath, scope)
      contentCache.set(normPath, content)
    }
    if (content === null) continue

    const parser = await getParserForPath(normPath)
    if (!parser) continue

    const token = extractIdentifierAtPosition(
      content,
      { lineNumber: candidate.lineNumber, column: candidate.columnStart },
      parser
    )
    if (token && token.name === symbolName && policy.acceptToken(token)) {
      verifiedByKey.set(key, {
        ...candidate,
        path: normPath
      })
    }
  }
}

/**
 * Resolves declaration targets for a symbol in the given `CodeSourceScope`,
 * verifying candidates against Lezer syntax trees to exclude comments, strings, and usages.
 */
export async function resolveSymbolDefinitions(
  options: ResolveSymbolDefinitionsOptions
): Promise<SymbolDefinitionResolution> {
  const {
    symbolName,
    currentFilePath,
    currentFileContent,
    changedFilePaths,
    isInActiveDiffHunk,
    getParserForPath
  } = options

  const verifiedByKey = new Map<string, SymbolCandidateMatch>()

  if (currentFileContent !== null) {
    const currentParser = await getParserForPath(currentFilePath)
    if (currentParser) {
      const lines = currentFileContent.replace(/\r\n/g, '\n').split('\n')
      const symbols = extractDocumentSymbols(currentFileContent, currentParser)
      for (const sym of symbols) {
        if (sym.name === symbolName) {
          const normPath = normalizeRepoPath(currentFilePath)
          const key = `${normPath}:${sym.lineNumber}`
          if (!verifiedByKey.has(key)) {
            verifiedByKey.set(key, {
              path: normPath,
              lineNumber: sym.lineNumber,
              lineText: lines[sym.lineNumber - 1] ?? '',
              columnStart: sym.columnStart,
              columnEnd: sym.columnEnd
            })
          }
        }
      }
    }
  }

  await collectVerifiedCandidates(options, verifiedByKey, {
    getKey: (normPath, candidate) => `${normPath}:${candidate.lineNumber}`,
    acceptToken: (token) => token.isDeclaration
  })

  const ranked = rankDeclarationCandidates(Array.from(verifiedByKey.values()), {
    currentFilePath,
    changedFilePaths,
    isInActiveDiffHunk
  })

  if (ranked.length === 0) {
    return { status: 'not-found' }
  }
  if (ranked.length === 1) {
    return { status: 'single', target: ranked[0] }
  }
  return { status: 'multiple', candidates: ranked }
}

/**
 * Resolves all Lezer-verified identifier references for a symbol in the given `CodeSourceScope`,
 * excluding comments and string literals, and ranked by locality and active diff/compare changes.
 */
export async function resolveSymbolReferences(
  options: ResolveSymbolDefinitionsOptions
): Promise<SymbolCandidateMatch[]> {
  const verifiedByKey = new Map<string, SymbolCandidateMatch>()

  await collectVerifiedCandidates(options, verifiedByKey, {
    getKey: (normPath, candidate) => `${normPath}:${candidate.lineNumber}:${candidate.columnStart}`,
    acceptToken: () => true
  })

  return rankDeclarationCandidates(Array.from(verifiedByKey.values()), {
    currentFilePath: options.currentFilePath,
    changedFilePaths: options.changedFilePaths,
    isInActiveDiffHunk: options.isInActiveDiffHunk
  })
}
