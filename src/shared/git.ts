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

export type GitDiffRequest =
  | ({ kind: 'staged' } & GitChangedFile)
  | ({ kind: 'unstaged' } & GitChangedFile)
  | ({
      kind: 'commit'
      commitHash: string
      shortHash: string
    } & GitChangedFile)

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
