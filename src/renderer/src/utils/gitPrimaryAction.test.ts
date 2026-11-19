import { describe, expect, it } from 'vitest'
import { createEmptyGitStatus, type GitStatus } from '@shared/git'
import {
  formatGitCommitPlaceholder,
  getGitBranchLabel,
  getGitPrimaryActionState
} from './gitPrimaryAction'

function buildStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ...createEmptyGitStatus(true, 'C:/wiki'),
    branch: 'main',
    ...overrides
  }
}

describe('getGitPrimaryActionState', () => {
  it('returns disabled commit without auto-stage when status is null or not a git repository', () => {
    expect(getGitPrimaryActionState(null)).toEqual({
      kind: 'commit',
      disabled: true,
      requiresAutoStageConfirm: false
    })

    expect(getGitPrimaryActionState(createEmptyGitStatus(false, null))).toEqual({
      kind: 'commit',
      disabled: true,
      requiresAutoStageConfirm: false
    })
  })

  it.each([
    {
      name: 'staged changes present (no auto-stage confirm)',
      overrides: {
        staged: [{ path: 'a.md', status: 'A' as const }],
        unstaged: [],
        untracked: []
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: false }
    },
    {
      name: 'both staged and unstaged changes present (no auto-stage confirm)',
      overrides: {
        staged: [{ path: 'a.md', status: 'A' as const }],
        unstaged: [{ path: 'b.md', status: 'M' as const }],
        untracked: [{ path: 'c.md', status: '?' as const }]
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: false }
    },
    {
      name: 'only unstaged changes when staged is empty (requires auto-stage confirm)',
      overrides: {
        staged: [],
        unstaged: [{ path: 'b.md', status: 'M' as const }],
        untracked: []
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: true }
    },
    {
      name: 'only untracked files when staged is empty (requires auto-stage confirm)',
      overrides: {
        staged: [],
        unstaged: [],
        untracked: [{ path: 'c.md', status: '?' as const }]
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: true }
    },
    {
      name: 'changes take priority over unpublished branch state',
      overrides: {
        hasUpstream: false,
        staged: [],
        unstaged: [{ path: 'b.md', status: 'M' as const }]
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: true }
    },
    {
      name: 'changes take priority over ahead/behind upstream state',
      overrides: {
        hasUpstream: true,
        ahead: 2,
        behind: 1,
        staged: [{ path: 'a.md', status: 'M' as const }]
      },
      expected: { kind: 'commit', disabled: false, requiresAutoStageConfirm: false }
    },
    {
      name: 'merge conflicts disable commit and suppress auto-stage even with unstaged changes',
      overrides: {
        hasConflicts: true,
        staged: [],
        unstaged: [{ path: 'conflict.md', status: 'U' as const }]
      },
      expected: { kind: 'commit', disabled: true, requiresAutoStageConfirm: false }
    },
    {
      name: 'merge conflicts disable commit even when staged entries exist',
      overrides: {
        hasConflicts: true,
        staged: [{ path: 'resolved.md', status: 'M' as const }],
        unstaged: [{ path: 'conflict.md', status: 'U' as const }]
      },
      expected: { kind: 'commit', disabled: true, requiresAutoStageConfirm: false }
    },
    {
      name: 'clean working tree without upstream on regular branch returns publish',
      overrides: {
        hasUpstream: false,
        isUnborn: false,
        isDetached: false
      },
      expected: { kind: 'publish' }
    },
    {
      name: 'clean unborn repository without upstream disables commit instead of publish',
      overrides: {
        hasUpstream: false,
        isUnborn: true,
        isDetached: false
      },
      expected: { kind: 'commit', disabled: true, requiresAutoStageConfirm: false }
    },
    {
      name: 'clean detached HEAD without upstream disables commit instead of publish',
      overrides: {
        branch: null,
        hasUpstream: false,
        isUnborn: false,
        isDetached: true
      },
      expected: { kind: 'commit', disabled: true, requiresAutoStageConfirm: false }
    },
    {
      name: 'clean tree with upstream ahead only returns sync',
      overrides: {
        hasUpstream: true,
        ahead: 3,
        behind: 0
      },
      expected: { kind: 'sync', ahead: 3, behind: 0 }
    },
    {
      name: 'clean tree with upstream behind only returns sync',
      overrides: {
        hasUpstream: true,
        ahead: 0,
        behind: 2
      },
      expected: { kind: 'sync', ahead: 0, behind: 2 }
    },
    {
      name: 'clean tree with upstream both ahead and behind returns sync',
      overrides: {
        hasUpstream: true,
        ahead: 2,
        behind: 1
      },
      expected: { kind: 'sync', ahead: 2, behind: 1 }
    },
    {
      name: 'clean tree fully synced with upstream returns disabled commit',
      overrides: {
        hasUpstream: true,
        ahead: 0,
        behind: 0
      },
      expected: { kind: 'commit', disabled: true, requiresAutoStageConfirm: false }
    }
  ])('$name', ({ overrides, expected }) => {
    expect(getGitPrimaryActionState(buildStatus(overrides))).toEqual(expected)
  })
})

describe('getGitBranchLabel & formatGitCommitPlaceholder', () => {
  it('resolves branch labels for named, detached, and fallback HEAD states and formats commit placeholder', () => {
    expect(getGitBranchLabel(buildStatus({ branch: 'feature/smart-cta' }))).toBe(
      'feature/smart-cta'
    )
    expect(getGitBranchLabel(buildStatus({ branch: null, isDetached: true }))).toBe('(detached)')
    expect(getGitBranchLabel(buildStatus({ branch: null, isDetached: false }))).toBe('HEAD')
    expect(getGitBranchLabel(null)).toBe('HEAD')

    expect(formatGitCommitPlaceholder('main')).toBe('메시지 (Ctrl+Enter로 "main"에 커밋)')
    expect(formatGitCommitPlaceholder('(detached)')).toBe(
      '메시지 (Ctrl+Enter로 "(detached)"에 커밋)'
    )
  })
})
