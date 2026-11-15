import type { FavoriteWorkspace } from './config'

export type WorkspaceEntryKind = 'directory' | 'file'

export interface WorkspaceEntry {
  name: string
  path: string
  relativePath: string
  kind: WorkspaceEntryKind
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

function isWindowsPathStyle(path: string): boolean {
  return WINDOWS_DRIVE_RE.test(path) || path.startsWith('\\\\') || path.startsWith('//')
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

export function isNestedOrSamePath(candidatePath: string, parentPath: string): boolean {
  return (
    candidatePath === parentPath ||
    candidatePath.startsWith(`${parentPath}/`) ||
    candidatePath.startsWith(`${parentPath}\\`)
  )
}

export function remapPathPrefix(targetPath: string, oldPrefix: string, newPrefix: string): string {
  if (targetPath === oldPrefix) return newPrefix
  if (isNestedOrSamePath(targetPath, oldPrefix)) {
    return `${newPrefix}${targetPath.slice(oldPrefix.length)}`
  }
  return targetPath
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
