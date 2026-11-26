export type GitStagedStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U'
export type GitUnstagedStatus = 'M' | 'D' | 'U'
export type GitUntrackedStatus = '?'
export type GitFileStatusCode = GitStagedStatus | GitUnstagedStatus | GitUntrackedStatus

export interface GitChangedFile {
  path: string
  origPath?: string
  status: GitFileStatusCode
}

export interface GitStatus {
  isRepo: boolean
  repoRoot: string | null
  branch: string | null
  isDetached: boolean
  isUnborn: boolean
  ahead: number
  behind: number
  hasUpstream: boolean
  hasConflicts: boolean
  staged: GitChangedFile[]
  unstaged: GitChangedFile[]
  untracked: GitChangedFile[]
}

export interface GitBranchInfo {
  name: string
  current: boolean
  upstream: string | null
}

export interface GitBranchList {
  current: string | null
  isDetached: boolean
  branches: GitBranchInfo[]
}

export interface GitSyncResult {
  status: GitStatus
  pulled: boolean
  pushed: boolean
  summary: string
}

export const DEFAULT_GIT_LOG_LIMIT = 100

export type GitLogScope = 'all' | 'current'
export type GitRefKind = 'head' | 'local-branch' | 'remote-branch' | 'tag'

export interface GitRefBadge {
  name: string
  kind: GitRefKind
  isCurrentHead?: boolean
}

export interface GitGraphCommit {
  hash: string
  shortHash: string
  parents: string[]
  subject: string
  authorName: string
  committedAt: string
  refs: GitRefBadge[]
}

export interface GitLogOptions {
  scope?: GitLogScope
  limit?: number
  skip?: number
}

export interface GitLogResult {
  commits: GitGraphCommit[]
  hasMore: boolean
}

export interface GitCommitDetail {
  hash: string
  shortHash: string
  parents: string[]
  subject: string
  body: string
  authorName: string
  authorEmail: string
  committedAt: string
  files: GitChangedFile[]
}

export const GIT_EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const GIT_DIFF_MAX_BYTES = 1024 * 1024

export type GitCompareRefKind = 'worktree' | 'local-branch' | 'remote-branch'
export type GitCompareMode = 'three-dot' | 'two-dot'

export interface GitCompareRef {
  id: string
  kind: GitCompareRefKind
  ref: string
  displayName: string
  worktreeName?: string
  branchName?: string | null
  shortHash?: string
  isDetached?: boolean
  isCurrent?: boolean
}

export interface GitCompareRefList {
  defaultBaseRef: string | null
  currentRef: string | null
  worktrees: GitCompareRef[]
  localBranches: GitCompareRef[]
  remoteBranches: GitCompareRef[]
}

export interface GitCompareChangedFile extends GitChangedFile {
  additions: number | null
  deletions: number | null
  isBinary: boolean
}

export interface GitCompareSummary {
  baseRef: string
  compareRef: string
  mode: GitCompareMode
  mergeBaseHash: string | null
  totalAdditions: number
  totalDeletions: number
  files: GitCompareChangedFile[]
  commits: GitGraphCommit[]
}

export interface GitCompareSummaryRequest {
  baseRef: string
  compareRef: string
  mode: GitCompareMode
}

export type GitDiffViewMode = 'side-by-side' | 'inline'

export type GitDiffRequest =
  | ({ kind: 'staged' } & GitChangedFile)
  | ({ kind: 'unstaged' } & GitChangedFile)
  | ({
      kind: 'commit'
      commitHash: string
      shortHash: string
    } & GitChangedFile)
  | ({
      kind: 'stash'
      stashRef: string
      stashHash: string
    } & GitChangedFile)
  | ({
      kind: 'branch-compare'
      baseRef: string
      compareRef: string
      mode: GitCompareMode
      mergeBaseHash?: string | null
    } & GitChangedFile)

export type GitStashScope = 'unstaged' | 'all' | 'paths'

export interface GitStashEntry {
  ref: string
  hash: string
  branch: string | null
  message: string
  createdAt: string
}

export interface GitStashDetail extends GitStashEntry {
  files: GitChangedFile[]
}

export interface GitStashCreateOptions {
  scope: GitStashScope
  message?: string
  includeUntracked?: boolean
  paths?: string[]
}

export interface GitFileDiff extends GitChangedFile {
  isBinary: boolean
  isTruncated: boolean
  existsInWorkspace: boolean
  rawPatch: string
}

export function createEmptyGitStatus(isRepo = false, repoRoot: string | null = null): GitStatus {
  return {
    isRepo,
    repoRoot,
    branch: null,
    isDetached: false,
    isUnborn: false,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    hasConflicts: false,
    staged: [],
    unstaged: [],
    untracked: []
  }
}

export function getGitChangedCount(status: GitStatus | null): number {
  if (!status || !status.isRepo) {
    return 0
  }
  return status.staged.length + status.unstaged.length + status.untracked.length
}

/**
 * Collects unique repo-relative paths present in `Staged Changes` (including rename origins).
 */
export function collectGitStagedPaths(status: GitStatus): string[] {
  return [
    ...new Set(
      status.staged.flatMap((item) => (item.origPath ? [item.path, item.origPath] : [item.path]))
    )
  ]
}

/**
 * Collects unique repo-relative paths present in `Changes` (`unstaged` + optional `untracked`).
 */
export function collectGitUnstagedPaths(status: GitStatus, includeUntracked: boolean): string[] {
  const paths = new Set(status.unstaged.map((item) => item.path))
  if (includeUntracked) {
    for (const item of status.untracked) {
      paths.add(item.path)
    }
  }
  return [...paths]
}

/**
 * Collects all unique repo-relative paths present in `status` (`staged`, `unstaged`, optional `untracked`).
 */
export function collectGitStatusPaths(status: GitStatus, includeUntracked: boolean): string[] {
  return [
    ...new Set([...collectGitStagedPaths(status), ...collectGitUnstagedPaths(status, includeUntracked)])
  ]
}
