import { describe, expect, it } from 'vitest'
import {
  formatGitDiffTabKey,
  getGitDiffContextLabel,
  getGitDiffTabLabel,
  toGitDiffRequest
} from './gitFilePresentation'

describe('gitFilePresentation', () => {
  it('formats tab labels with short commit hash only for commit diff requests', () => {
    expect(
      getGitDiffTabLabel({
        kind: 'unstaged',
        path: 'docs/guide.md',
        status: 'M'
      })
    ).toBe('guide.md')

    expect(
      getGitDiffTabLabel({
        kind: 'staged',
        path: 'docs/guide.md',
        status: 'A'
      })
    ).toBe('guide.md')

    expect(
      getGitDiffTabLabel({
        kind: 'commit',
        commitHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        shortHash: 'a1b2c3d',
        path: 'docs/guide.md',
        status: 'M'
      })
    ).toBe('guide.md (a1b2c3d)')
  })

  it('builds commit, staged, and unstaged GitDiffRequest values uniformly while preserving origPath', () => {
    expect(
      toGitDiffRequest('staged', {
        path: 'sub/new-name.md',
        origPath: 'old-name.md',
        status: 'R'
      })
    ).toEqual({
      kind: 'staged',
      path: 'sub/new-name.md',
      origPath: 'old-name.md',
      status: 'R'
    })

    expect(
      toGitDiffRequest(
        {
          kind: 'commit',
          commitHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          shortHash: 'a1b2c3d'
        },
        {
          path: 'sub/moved.md',
          origPath: 'legacy.md',
          status: 'R'
        }
      )
    ).toEqual({
      kind: 'commit',
      commitHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      shortHash: 'a1b2c3d',
      path: 'sub/moved.md',
      origPath: 'legacy.md',
      status: 'R'
    })
  })

  it('produces distinct context labels and tab keys per commit hash', () => {
    const reqA = toGitDiffRequest(
      { kind: 'commit', commitHash: 'a1b2c3d000000000000000000000000000000001', shortHash: 'a1b2c3d' },
      { path: 'guide.md', status: 'M' }
    )
    const reqB = toGitDiffRequest(
      { kind: 'commit', commitHash: 'f9e8d7c000000000000000000000000000000002', shortHash: 'f9e8d7c' },
      { path: 'guide.md', status: 'M' }
    )

    expect(getGitDiffContextLabel(reqA)).toBe('Commit a1b2c3d')
    expect(formatGitDiffTabKey(reqA)).not.toBe(formatGitDiffTabKey(reqB))
  })
})
