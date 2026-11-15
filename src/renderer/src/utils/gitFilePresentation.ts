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
