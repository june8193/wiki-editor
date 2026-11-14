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
