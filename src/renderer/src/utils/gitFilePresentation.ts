import type { GitChangedFile, GitDiffRequest, GitFileStatusCode } from '@shared/git'

/**
 * Formats a Git file path label, showing `origPath → path` for renamed or copied files.
 */
export function formatGitFileLabel(file: GitChangedFile): string {
  return file.origPath ? `${file.origPath} → ${file.path}` : file.path
}

/**
 * Maps a Git status code to the lowercase `.git-badge--*` CSS modifier.
 */
export function getGitFileBadgeModifier(code: GitFileStatusCode): string {
  return code === '?' ? 'untracked' : code.toLowerCase()
}

/**
 * Extracts the filename segment from a repo-relative POSIX or Windows path.
 */
export function getGitFileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/**
 * Returns the short tab display label for a Diff tab, appending the abbreviated
 * commit hash when inspecting a historical commit file.
 */
export function getGitDiffTabLabel(request: GitDiffRequest): string {
  const baseName = getGitFileBaseName(request.path)
  return request.kind === 'commit' ? `${baseName} (${request.shortHash})` : baseName
}

/**
 * Maps a diff source request to its human-readable context badge label.
 */
export function getGitDiffContextLabel(request: GitDiffRequest): string {
  switch (request.kind) {
    case 'staged':
      return 'Staged'
    case 'unstaged':
      return 'Working Tree'
    case 'commit':
      return `Commit ${request.shortHash}`
  }
}

/**
 * Builds a deterministic identity key for a GitDiffRequest across tabs and caches.
 */
export function formatGitDiffTabKey(request: GitDiffRequest): string {
  const renamePart = request.origPath ?? ''
  if (request.kind === 'commit') {
    return `diff:commit:${request.commitHash}:${request.status}:${renamePart}:${request.path}`
  }
  return `diff:${request.kind}:${request.status}:${renamePart}:${request.path}`
}

export type GitDiffTarget =
  | 'staged'
  | 'unstaged'
  | { kind: 'commit'; commitHash: string; shortHash: string }

/**
 * Builds a typed GitDiffRequest from either a Working/Staged target or a Commit target.
 */
export function toGitDiffRequest(
  target: GitDiffTarget,
  file: GitChangedFile
): GitDiffRequest {
  const base = {
    path: file.path,
    ...(file.origPath ? { origPath: file.origPath } : {}),
    status: file.status
  }
  if (typeof target === 'string') {
    return { kind: target, ...base }
  }
  return {
    kind: 'commit',
    commitHash: target.commitHash,
    shortHash: target.shortHash,
    ...base
  }
}
