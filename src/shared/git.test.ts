import { describe, expect, it } from 'vitest'
import { createEmptyGitStatus, getGitChangedCount } from './git'

describe('shared git helpers', () => {
  it('counts total staged, unstaged, and untracked files only when inside a git repo', () => {
    expect(getGitChangedCount(null)).toBe(0)
    expect(
      getGitChangedCount({
        ...createEmptyGitStatus(false, 'C:\\wiki'),
        staged: [{ path: 'a.md', status: 'A' }]
      })
    ).toBe(0)

    expect(
      getGitChangedCount({
        ...createEmptyGitStatus(true, 'C:\\wiki'),
        staged: [{ path: 'a.md', status: 'A' }],
        unstaged: [
          { path: 'b.md', status: 'M' },
          { path: 'c.md', status: 'D' }
        ],
        untracked: [{ path: 'd.md', status: '?' }]
      })
    ).toBe(4)
  })
})
