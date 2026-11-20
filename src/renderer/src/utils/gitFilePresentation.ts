import type { GitChangedFile, GitDiffRequest, GitFileStatusCode } from '@shared/git'
import { isAbsoluteOrDrivePrefix, resolveRepoFileInWorkspace } from '@shared/workspace'

export type GitFileStatusTone = 'amber' | 'green' | 'red' | 'accent'

export interface GitFileStatusDisplay {
  status: GitFileStatusCode
  displayCode: 'M' | 'A' | 'D' | 'R' | 'C' | 'U'
  tone: GitFileStatusTone
  label: string
  strikethrough: boolean
}

const GIT_FILE_STATUS_DISPLAY_MAP: Record<GitFileStatusCode, Omit<GitFileStatusDisplay, 'status'>> =
  {
    M: {
      displayCode: 'M',
      tone: 'amber',
      label: 'Modified',
      strikethrough: false
    },
    A: {
      displayCode: 'A',
      tone: 'green',
      label: 'Added',
      strikethrough: false
    },
    D: {
      displayCode: 'D',
      tone: 'red',
      label: 'Deleted',
      strikethrough: true
    },
    R: {
      displayCode: 'R',
      tone: 'accent',
      label: 'Renamed',
      strikethrough: false
    },
    C: {
      displayCode: 'C',
      tone: 'accent',
      label: 'Copied',
      strikethrough: false
    },
    '?': {
      displayCode: 'U',
      tone: 'green',
      label: 'Untracked',
      strikethrough: false
    },
    U: {
      displayCode: 'C',
      tone: 'red',
      label: 'Conflict',
      strikethrough: false
    }
  }

export interface GitChangedFileDisplay {
  fileName: string
  dirPath: string
  tooltip: string
}

function normalizeRepoRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Maps an internal `GitFileStatusCode` to its VS Code UI display metadata without mutating the source code.
 */
export function getGitFileStatusDisplay(status: GitFileStatusCode): GitFileStatusDisplay {
  return {
    status,
    ...GIT_FILE_STATUS_DISPLAY_MAP[status]
  }
}

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
 * Extracts the normalized POSIX parent directory path for a repo-relative file path (`''` for root files).
 */
export function getGitFileDirPath(filePath: string): string {
  const normalized = normalizeRepoRelativePath(filePath)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : ''
}

/**
 * Splits a changed Git file into its primary filename label, dimmed relative directory, and full tooltip.
 */
export function formatGitChangedFileDisplay(file: GitChangedFile): GitChangedFileDisplay {
  const normalizedPath = normalizeRepoRelativePath(file.path)
  const targetName = getGitFileBaseName(normalizedPath)
  const targetDir = getGitFileDirPath(normalizedPath)

  if (!file.origPath) {
    return {
      fileName: targetName,
      dirPath: targetDir,
      tooltip: normalizedPath
    }
  }

  const normalizedOrig = normalizeRepoRelativePath(file.origPath)
  const origDir = getGitFileDirPath(normalizedOrig)
  const origLabel = origDir === targetDir ? getGitFileBaseName(normalizedOrig) : normalizedOrig

  return {
    fileName: `${origLabel} → ${targetName}`,
    dirPath: targetDir,
    tooltip: `${normalizedOrig} → ${normalizedPath}`
  }
}

/**
 * Returns true when a changed Git file exists in the working tree (`status !== 'D'`)
 * and resolves strictly inside the currently open workspace root.
 */
export function canOpenGitChangedFile(
  file: Pick<GitChangedFile, 'path' | 'status'>,
  repoRoot: string | null | undefined,
  workspaceRootPath: string | null | undefined
): boolean {
  if (file.status === 'D' || !workspaceRootPath || !file.path) {
    return false
  }
  const normalized = normalizeRepoRelativePath(file.path)
  if (!normalized || isAbsoluteOrDrivePrefix(file.path)) {
    return false
  }
  const segments = normalized.split('/')
  if (segments.some((seg) => seg === '..')) {
    return false
  }
  return resolveRepoFileInWorkspace(repoRoot, workspaceRootPath, file.path) !== null
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

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Formats an ISO-8601 Git timestamp into local `YYYY-MM-DD HH:mm`, returning the raw input if unparseable.
 */
export function formatGitTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp)
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp
  }
  const year = parsed.getFullYear()
  const month = padTwo(parsed.getMonth() + 1)
  const day = padTwo(parsed.getDate())
  const hours = padTwo(parsed.getHours())
  const minutes = padTwo(parsed.getMinutes())
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

/**
 * Formats the discard-all confirmation message distinguishing irreversible tracked restores
 * and OS trash moves for untracked files.
 */
export function buildDiscardAllConfirmMessage(
  trackedCount: number,
  untrackedCount: number
): string {
  if (trackedCount > 0 && untrackedCount > 0) {
    const totalCount = trackedCount + untrackedCount
    return `총 ${totalCount}개 파일의 변경 사항을 롤백합니다. 추적된 파일 ${trackedCount}개는 이전 상태로 되돌려지며(복구 불가), 추적되지 않은 새 파일 ${untrackedCount}개는 OS 휴지통으로 이동됩니다. 계속할까요?`
  }
  if (trackedCount > 0) {
    return `추적된 변경 파일 ${trackedCount}개를 이전 상태로 되돌립니다. 되돌린 변경 사항은 복구할 수 없습니다. 계속할까요?`
  }
  return `추적되지 않은 새 파일 ${untrackedCount}개를 OS 휴지통으로 이동합니다. 계속할까요?`
}
