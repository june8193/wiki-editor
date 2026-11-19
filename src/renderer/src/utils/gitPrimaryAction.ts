import { getGitChangedCount, type GitStatus } from '@shared/git'

export type GitPrimaryActionState =
  | { kind: 'publish' }
  | { kind: 'sync'; ahead: number; behind: number }
  | {
      kind: 'commit'
      disabled: boolean
      requiresAutoStageConfirm: boolean
    }

export type GitCommitActionMode = 'commit' | 'commit-push' | 'commit-sync'

/**
 * Resolves the active primary CTA state for the Git panel from current repository status.
 */
export function getGitPrimaryActionState(status: GitStatus | null): GitPrimaryActionState {
  if (!status || !status.isRepo) {
    return {
      kind: 'commit',
      disabled: true,
      requiresAutoStageConfirm: false
    }
  }

  const hasChanges = getGitChangedCount(status) > 0
  if (
    !hasChanges &&
    !status.hasConflicts &&
    !status.isUnborn &&
    !status.isDetached &&
    !status.hasUpstream
  ) {
    return { kind: 'publish' }
  }

  if (
    !hasChanges &&
    !status.hasConflicts &&
    status.hasUpstream &&
    (status.ahead > 0 || status.behind > 0)
  ) {
    return {
      kind: 'sync',
      ahead: status.ahead,
      behind: status.behind
    }
  }

  return {
    kind: 'commit',
    disabled: !hasChanges || status.hasConflicts,
    requiresAutoStageConfirm: hasChanges && status.staged.length === 0 && !status.hasConflicts
  }
}

/**
 * Returns the human-readable label for the current Git HEAD state (branch name, `(detached)`, or `HEAD`).
 */
export function getGitBranchLabel(
  status: Pick<GitStatus, 'branch' | 'isDetached'> | null
): string {
  if (!status) {
    return 'HEAD'
  }
  return status.branch ?? (status.isDetached ? '(detached)' : 'HEAD')
}

/**
 * Formats the VS Code-style commit input placeholder including the active branch label.
 */
export function formatGitCommitPlaceholder(branchLabel: string): string {
  return `메시지 (Ctrl+Enter로 "${branchLabel}"에 커밋)`
}
