import type { GitChangedFile, GitFileStatusCode } from '@shared/git'

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
