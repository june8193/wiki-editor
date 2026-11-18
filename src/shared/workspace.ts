import type { FavoriteWorkspace } from './config'

export type WorkspaceEntryKind = 'directory' | 'file'

export interface WorkspaceEntry {
  name: string
  path: string
  relativePath: string
  kind: WorkspaceEntryKind
}

export interface WorkspaceMovedEntry {
  oldPath: string
  entry: WorkspaceEntry
}

export interface WorkspaceSummary {
  rootPath: string
  name: string
}

export interface WorkspaceInfo extends WorkspaceSummary {
  entries: WorkspaceEntry[]
}

export interface WorkspaceChangeEvent {
  rootPath: string
  eventType: string
  relativePath: string | null
}

const DEFAULT_MAX_RECENT_WORKSPACES = 10
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:(?:[\\/]|$)/
const WINDOWS_DRIVE_PREFIX_RE = /^[a-zA-Z]:/

function isWindowsPathStyle(path: string): boolean {
  return WINDOWS_DRIVE_RE.test(path) || path.startsWith('\\\\') || path.startsWith('//')
}

/** Returns true when a path starts with a POSIX/UNC slash or Windows drive prefix. */
export function isAbsoluteOrDrivePrefix(value: string): boolean {
  return WINDOWS_DRIVE_PREFIX_RE.test(value) || value.startsWith('/') || value.startsWith('\\')
}

function stripTrailingSeparators(path: string, separator: string): string {
  const driveRoot = WINDOWS_DRIVE_RE.test(path) ? `${path.slice(0, 2)}${separator}` : null
  if (path === separator || (driveRoot !== null && path === driveRoot)) {
    return path
  }
  let end = path.length
  while (end > 1 && path[end - 1] === separator) {
    if (driveRoot !== null && end === 3) {
      break
    }
    end -= 1
  }
  return path.slice(0, end)
}

/**
 * Normalizes workspace path separators and trailing slashes without Node path dependencies.
 */
export function normalizeWorkspacePath(inputPath: string): string {
  const trimmed = inputPath.trim()
  if (!trimmed) return ''

  if (isWindowsPathStyle(trimmed)) {
    const isUnc = trimmed.startsWith('\\\\') || trimmed.startsWith('//')
    const replaced = trimmed.replace(/\//g, '\\')
    const collapsed = isUnc
      ? `\\\\${replaced.slice(2).replace(/\\+/g, '\\')}`
      : replaced.replace(/\\+/g, '\\')
    if (WINDOWS_DRIVE_RE.test(collapsed) && collapsed.length === 2) {
      return `${collapsed}\\`
    }
    return stripTrailingSeparators(collapsed, '\\')
  }

  const collapsed = trimmed.replace(/\/+/g, '/')
  return stripTrailingSeparators(collapsed, '/')
}

/**
 * Produces a canonical comparison key for deduplicating workspace paths.
 */
export function getWorkspacePathKey(inputPath: string): string {
  const normalized = normalizeWorkspacePath(inputPath)
  if (!normalized) return ''
  const slashUnified = normalized.replace(/\\/g, '/')
  return isWindowsPathStyle(normalized) ? slashUnified.toLowerCase() : slashUnified
}

export function isSameWorkspacePath(a: string, b: string): boolean {
  const keyA = getWorkspacePathKey(a)
  const keyB = getWorkspacePathKey(b)
  return keyA.length > 0 && keyA === keyB
}

export function getWorkspaceDisplayName(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath)
  if (!normalized) return ''
  if (normalized === '/' || /^[a-zA-Z]:\\$/.test(normalized)) {
    return normalized
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? normalized
}

export function getParentPath(targetPath: string, rootPath: string): string {
  const idx = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
  if (idx <= 0) return rootPath
  const parent = targetPath.slice(0, idx)
  return parent.length < rootPath.length ? rootPath : parent
}

/**
 * Resolves the immediate normalized parent directory of a file path without requiring a workspace root.
 */
export function getParentDirectory(filePath: string): string {
  const normalized = normalizeWorkspacePath(filePath)
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (lastSlash < 0) return normalized
  if (lastSlash === 0) return '/'
  if (lastSlash === 2 && normalized[1] === ':') return normalized.slice(0, 3)
  return normalized.slice(0, lastSlash)
}

export function isNestedOrSamePath(candidatePath: string, parentPath: string): boolean {
  return (
    candidatePath === parentPath ||
    candidatePath.startsWith(`${parentPath}/`) ||
    candidatePath.startsWith(`${parentPath}\\`)
  )
}

function isPathKeyNestedOrSame(candidateKey: string, parentKey: string): boolean {
  if (!candidateKey || !parentKey) return false
  if (candidateKey === parentKey) return true
  return parentKey.endsWith('/')
    ? candidateKey.startsWith(parentKey)
    : candidateKey.startsWith(`${parentKey}/`)
}

/**
 * Returns true when `candidatePath` is identical to or nested inside `parentPath` using
 * canonical workspace path key comparison.
 */
export function isNestedOrSameWorkspacePath(candidatePath: string, parentPath: string): boolean {
  return isPathKeyNestedOrSame(
    getWorkspacePathKey(candidatePath),
    getWorkspacePathKey(parentPath)
  )
}

/**
 * Deduplicates workspace items by canonical path key and drops items strictly nested inside a
 * selected directory item, preserving original order.
 */
export function filterTopLevelWorkspaceItems<T>(
  items: readonly T[],
  getPath: (item: T) => string,
  isDirectory: (item: T) => boolean
): T[] {
  const deduped: Array<{ item: T; key: string; isDir: boolean }> = []
  const seenKeys = new Set<string>()

  for (const item of items) {
    const key = getWorkspacePathKey(getPath(item))
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    deduped.push({
      item,
      key,
      isDir: isDirectory(item)
    })
  }

  return deduped
    .filter(
      (candidate) =>
        !deduped.some(
          (other) =>
            other.isDir &&
            other.key !== candidate.key &&
            isPathKeyNestedOrSame(candidate.key, other.key)
        )
    )
    .map((entry) => entry.item)
}

/**
 * Deduplicates WorkspaceEntry items and drops entries nested inside a selected directory entry.
 */
export function filterTopLevelWorkspaceEntries(
  entries: readonly WorkspaceEntry[]
): WorkspaceEntry[] {
  return filterTopLevelWorkspaceItems(
    entries,
    (entry) => entry.path,
    (entry) => entry.kind === 'directory'
  )
}

/**
 * Returns true when a workspace watcher event (or an omitted mutation signal) may affect `targetPath`.
 */
export function isWorkspaceChangeAffectingPath(
  targetPath: string,
  changeEvent?: WorkspaceChangeEvent
): boolean {
  if (!changeEvent || !changeEvent.relativePath || changeEvent.relativePath === '.') {
    return true
  }
  const rootNormalized = normalizeWorkspacePath(changeEvent.rootPath).replace(/[\\/]+$/, '')
  const relNormalized = changeEvent.relativePath.replace(/^[\\/]+/, '')
  const changedKey = getWorkspacePathKey(`${rootNormalized}/${relNormalized}`)
  const targetKey = getWorkspacePathKey(targetPath)
  if (!changedKey || !targetKey) {
    return true
  }
  return isNestedOrSamePath(targetKey, changedKey)
}

export function remapPathPrefix(targetPath: string, oldPrefix: string, newPrefix: string): string {
  if (targetPath === oldPrefix) return newPrefix
  if (isNestedOrSamePath(targetPath, oldPrefix)) {
    return `${newPrefix}${targetPath.slice(oldPrefix.length)}`
  }
  return targetPath
}

export function toWorkspaceRelativePath(rootPath: string, targetPath: string): string {
  const normRoot = normalizeWorkspacePath(rootPath)
  const normTarget = normalizeWorkspacePath(targetPath)
  if (!normRoot || !normTarget || isSameWorkspacePath(normRoot, normTarget)) {
    return ''
  }

  const rootSlash = normRoot.replace(/\\/g, '/')
  const targetSlash = normTarget.replace(/\\/g, '/')
  const rootPrefix = rootSlash.endsWith('/') ? rootSlash : `${rootSlash}/`
  const matchesRoot = isWindowsPathStyle(normRoot)
    ? targetSlash.toLowerCase().startsWith(rootPrefix.toLowerCase())
    : targetSlash.startsWith(rootPrefix)

  return matchesRoot ? targetSlash.slice(rootPrefix.length) : ''
}

export function formatRelativeEntryPath(
  entry: Pick<WorkspaceEntry, 'path' | 'relativePath'>,
  workspaceRootPath?: string | null
): string {
  if (workspaceRootPath) {
    const computed = toWorkspaceRelativePath(workspaceRootPath, entry.path)
    if (computed) {
      return computed
    }
  }
  return entry.relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function formatAbsoluteEntryPath(entry: Pick<WorkspaceEntry, 'path'>): string {
  return normalizeWorkspacePath(entry.path) || entry.path
}

export function isFavoriteWorkspacePath(
  favorites: readonly FavoriteWorkspace[],
  workspacePath: string
): boolean {
  return favorites.some((item) => isSameWorkspacePath(item.path, workspacePath))
}

export function addFavoriteWorkspace(
  favorites: readonly FavoriteWorkspace[],
  workspacePath: string,
  name?: string,
  pinnedAt = new Date().toISOString()
): FavoriteWorkspace[] {
  const normalized = normalizeWorkspacePath(workspacePath)
  if (!normalized) {
    throw new Error('Workspace path must not be empty')
  }
  if (isFavoriteWorkspacePath(favorites, normalized)) {
    return favorites.map((item) => ({ ...item }))
  }
  const resolvedName = name?.trim() || getWorkspaceDisplayName(normalized)
  return [
    ...favorites.map((item) => ({ ...item })),
    {
      path: normalized,
      name: resolvedName,
      pinnedAt
    }
  ]
}

export function removeFavoriteWorkspace(
  favorites: readonly FavoriteWorkspace[],
  workspacePath: string
): FavoriteWorkspace[] {
  return favorites
    .filter((item) => !isSameWorkspacePath(item.path, workspacePath))
    .map((item) => ({ ...item }))
}

export function toggleFavoriteWorkspace(
  favorites: readonly FavoriteWorkspace[],
  workspacePath: string,
  name?: string,
  pinnedAt = new Date().toISOString()
): FavoriteWorkspace[] {
  if (isFavoriteWorkspacePath(favorites, workspacePath)) {
    return removeFavoriteWorkspace(favorites, workspacePath)
  }
  return addFavoriteWorkspace(favorites, workspacePath, name, pinnedAt)
}

export function recordRecentWorkspace(
  recents: readonly string[],
  workspacePath: string,
  maxItems = DEFAULT_MAX_RECENT_WORKSPACES
): string[] {
  const normalized = normalizeWorkspacePath(workspacePath)
  if (!normalized) {
    throw new Error('Workspace path must not be empty')
  }
  const limit = Math.max(1, Math.floor(maxItems))
  const filtered = recents.filter((item) => !isSameWorkspacePath(item, normalized))
  return [normalized, ...filtered].slice(0, limit)
}

export function removeRecentWorkspace(
  recents: readonly string[],
  workspacePath: string
): string[] {
  return recents.filter((item) => !isSameWorkspacePath(item, workspacePath))
}

const MARKDOWN_EXTENSION_RE = /\.(?:md|markdown)$/i

/**
 * Returns true when the file name ends with `.md` or `.markdown` (case-insensitive).
 */
export function isMarkdownFileName(fileName: string): boolean {
  return MARKDOWN_EXTENSION_RE.test(fileName)
}

/**
 * Removes a trailing `.md` or `.markdown` extension for display labels, keeping dotfiles intact.
 */
export function stripMarkdownExtension(fileName: string): string {
  const stripped = fileName.replace(MARKDOWN_EXTENSION_RE, '')
  return stripped || fileName
}

/**
 * Compares workspace entries alphabetically by workspace-root `relativePath`.
 */
export function compareWorkspaceEntriesByRelativePath(
  a: Pick<WorkspaceEntry, 'relativePath'>,
  b: Pick<WorkspaceEntry, 'relativePath'>
): number {
  const baseOrder = a.relativePath.localeCompare(b.relativePath, undefined, {
    sensitivity: 'base'
  })
  return baseOrder !== 0 ? baseOrder : a.relativePath.localeCompare(b.relativePath)
}

export type RelativeWorkspacePathResult =
  | { ok: true; targetPath: string }
  | { ok: false; reason: 'outside-workspace' | 'invalid' }

interface NormalizedPathParts {
  rootPrefix: string
  sep: '/' | '\\'
  caseInsensitive: boolean
  segments: string[]
}

function splitNormalizedRootAndSegments(normalizedPath: string): NormalizedPathParts | null {
  if (!normalizedPath) return null

  if (normalizedPath.startsWith('\\\\')) {
    const uncMatch = /^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/.exec(normalizedPath)
    if (!uncMatch) return null
    return {
      rootPrefix: uncMatch[1],
      sep: '\\',
      caseInsensitive: true,
      segments: uncMatch[2] ? uncMatch[2].split('\\').filter(Boolean) : []
    }
  }

  if (WINDOWS_DRIVE_PREFIX_RE.test(normalizedPath)) {
    const driveMatch = /^([a-zA-Z]:)(?:\\(.*))?$/.exec(normalizedPath)
    if (!driveMatch) return null
    return {
      rootPrefix: driveMatch[1],
      sep: '\\',
      caseInsensitive: true,
      segments: driveMatch[2] ? driveMatch[2].split('\\').filter(Boolean) : []
    }
  }

  if (normalizedPath.startsWith('/')) {
    return {
      rootPrefix: '/',
      sep: '/',
      caseInsensitive: false,
      segments: normalizedPath.slice(1).split('/').filter(Boolean)
    }
  }

  return null
}

function isStrictDescendantSegments(
  target: readonly string[],
  root: readonly string[],
  caseInsensitive: boolean
): boolean {
  if (target.length <= root.length) return false
  for (let i = 0; i < root.length; i += 1) {
    const left = caseInsensitive ? target[i].toLowerCase() : target[i]
    const right = caseInsensitive ? root[i].toLowerCase() : root[i]
    if (left !== right) return false
  }
  return true
}

function parseResolvedAbsolutePath(
  rawPath: string
): (NormalizedPathParts & { formattedPath: string }) | null {
  if (typeof rawPath !== 'string' || rawPath.includes('\0')) return null
  const normalized = normalizeWorkspacePath(rawPath)
  const parsed = splitNormalizedRootAndSegments(normalized)
  if (!parsed) return null

  const resolvedSegments: string[] = []
  for (const seg of parsed.segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (resolvedSegments.length === 0) {
        return null
      }
      resolvedSegments.pop()
      continue
    }
    resolvedSegments.push(seg)
  }

  let formattedPath: string
  if (parsed.rootPrefix === '/') {
    formattedPath = `/${resolvedSegments.join('/')}`
  } else if (resolvedSegments.length > 0) {
    formattedPath = `${parsed.rootPrefix}${parsed.sep}${resolvedSegments.join(parsed.sep)}`
  } else if (parsed.rootPrefix.startsWith('\\\\')) {
    formattedPath = parsed.rootPrefix
  } else {
    formattedPath = `${parsed.rootPrefix}${parsed.sep}`
  }

  return {
    ...parsed,
    segments: resolvedSegments,
    formattedPath
  }
}

/**
 * Resolves and normalizes an absolute workspace root path (rejecting relative paths, null bytes,
 * and `..` traversal past the filesystem root).
 */
export function resolveNormalizedWorkspacePath(rawPath: string): string | null {
  return parseResolvedAbsolutePath(rawPath)?.formattedPath ?? null
}

function hasMatchingPathRoot(
  left: NormalizedPathParts,
  right: NormalizedPathParts
): { matched: boolean; caseInsensitive: boolean } {
  const caseInsensitive = left.caseInsensitive || right.caseInsensitive
  const matched = caseInsensitive
    ? left.rootPrefix.toLowerCase() === right.rootPrefix.toLowerCase()
    : left.rootPrefix === right.rootPrefix
  return { matched, caseInsensitive }
}

/**
 * Resolves `candidatePath` and verifies it is a strict lexical descendant of `rootPath`.
 * Returns `null` for relative paths, root-escaping `..` traversal, mismatched roots, or `rootPath` itself.
 */
export function resolveWorkspaceChildPath(rootPath: string, candidatePath: string): string | null {
  const parsedRoot = parseResolvedAbsolutePath(rootPath)
  const parsedCandidate = parseResolvedAbsolutePath(candidatePath)
  if (!parsedRoot || !parsedCandidate) return null

  const { matched, caseInsensitive } = hasMatchingPathRoot(parsedRoot, parsedCandidate)
  if (!matched) {
    return null
  }

  if (!isStrictDescendantSegments(parsedCandidate.segments, parsedRoot.segments, caseInsensitive)) {
    return null
  }
  return parsedCandidate.formattedPath
}

/**
 * Resolves a relative file reference against `baseFilePath` inside `workspaceRootPath`,
 * preventing escapes outside the workspace root without Node path dependencies.
 */
export function resolveRelativeWorkspacePath(
  workspaceRootPath: string,
  baseFilePath: string,
  relativePath: string
): RelativeWorkspacePathResult {
  if (isAbsoluteOrDrivePrefix(relativePath)) {
    return { ok: false, reason: 'outside-workspace' }
  }
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.endsWith('/') ||
    relativePath.endsWith('\\')
  ) {
    return { ok: false, reason: 'invalid' }
  }

  const parsedRoot = splitNormalizedRootAndSegments(normalizeWorkspacePath(workspaceRootPath))
  const parsedBase = splitNormalizedRootAndSegments(normalizeWorkspacePath(baseFilePath))
  if (!parsedRoot || !parsedBase) {
    return { ok: false, reason: 'outside-workspace' }
  }

  const { matched, caseInsensitive } = hasMatchingPathRoot(parsedRoot, parsedBase)
  if (!matched) {
    return { ok: false, reason: 'outside-workspace' }
  }

  const rawSegments = relativePath.split(/[/\\]+/)
  const stack = parsedBase.segments.slice(0, -1)
  let underflowed = false
  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) {
        underflowed = true
        continue
      }
      stack.pop()
      continue
    }
    stack.push(seg)
  }

  if (underflowed || !isStrictDescendantSegments(stack, parsedRoot.segments, caseInsensitive)) {
    return { ok: false, reason: 'outside-workspace' }
  }

  const lastRawSegment = rawSegments[rawSegments.length - 1]
  if (lastRawSegment === '.' || lastRawSegment === '..') {
    return { ok: false, reason: 'invalid' }
  }

  const targetPath =
    parsedRoot.rootPrefix === '/'
      ? `/${stack.join('/')}`
      : `${parsedRoot.rootPrefix}${parsedRoot.sep}${stack.join(parsedRoot.sep)}`

  return { ok: true, targetPath }
}

/**
 * Converts path separators in `fragment` to match `referencePath`'s separator style.
 */
export function matchPathSeparators(fragment: string, referencePath: string): string {
  const usePosixSep = referencePath.includes('/') && !referencePath.includes('\\')
  return usePosixSep ? fragment.replace(/\\/g, '/') : fragment.replace(/\//g, '\\')
}

/**
 * Joins a workspace or repository root with a relative path using the root's separator style.
 */
export function joinWorkspacePath(baseRoot: string, relativePath: string): string {
  const cleanRoot = baseRoot.replace(/[\\/]+$/, '')
  const sep = baseRoot.includes('/') && !baseRoot.includes('\\') ? '/' : '\\'
  const cleanRel = relativePath.replace(/^[\\/]+/, '')
  return cleanRel ? `${cleanRoot}${sep}${matchPathSeparators(cleanRel, baseRoot)}` : cleanRoot
}

/**
 * Re-anchors `childPath` onto `rootPath`'s separator style and root casing when nested inside it.
 */
export function reanchorPathInWorkspace(rootPath: string, childPath: string): string {
  const rel = toWorkspaceRelativePath(rootPath, childPath)
  return rel ? joinWorkspacePath(rootPath, rel) : childPath
}

/**
 * Reads multiple workspace directories concurrently, keeping only successful reads.
 */
export async function readDirectoriesSettled(
  readDir: (dirPath?: string) => Promise<WorkspaceEntry[]>,
  dirPaths: readonly string[]
): Promise<Array<{ dirPath: string; entries: WorkspaceEntry[] }>> {
  if (dirPaths.length === 0) {
    return []
  }
  const settled = await Promise.allSettled(
    dirPaths.map(async (dirPath) => ({
      dirPath,
      entries: await readDir(dirPath)
    }))
  )
  const loaded: Array<{ dirPath: string; entries: WorkspaceEntry[] }> = []
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      loaded.push(result.value)
    }
  }
  return loaded
}

/**
 * Resolves a repository-relative target file path within an optional workspace root.
 * Returns `null` when the resolved file lies outside the open workspace.
 */
export function resolveRepoFileInWorkspace(
  repoRoot: string | null | undefined,
  workspaceRoot: string | null | undefined,
  repoRelativePath: string
): { path: string; relativePath: string } | null {
  const baseRoot = repoRoot ?? workspaceRoot
  if (!baseRoot) return null

  const fullPath = joinWorkspacePath(baseRoot, repoRelativePath)
  let relativePath = repoRelativePath

  if (workspaceRoot) {
    const normFull = normalizeWorkspacePath(fullPath)
    const normWorkspace = normalizeWorkspacePath(workspaceRoot)
    const keyFull = getWorkspacePathKey(normFull)
    const keyWorkspace = getWorkspacePathKey(normWorkspace)
    if (!isNestedOrSamePath(keyFull, keyWorkspace)) {
      return null
    }
    if (keyFull.length > keyWorkspace.length) {
      relativePath = normFull
        .slice(normWorkspace.length)
        .replace(/^[\\/]+/, '')
        .replace(/\\/g, '/')
    }
  }

  return { path: fullPath, relativePath }
}
