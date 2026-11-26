import { describe, expect, it } from 'vitest'
import type { GitChangedFile, GitFileStatusCode } from '@shared/git'
import {
  canOpenGitChangedFile,
  formatGitChangedFileDisplay,
  formatGitDiffTabKey,
  formatGitRepoCopyPath,
  getGitDiffContextLabel,
  getGitDiffTabLabel,
  getGitFileDirPath,
  getGitFileStatusDisplay,
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

    expect(
      getGitDiffTabLabel({
        kind: 'stash',
        stashRef: 'stash@{0}',
        stashHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        path: 'docs/guide.md',
        status: '?'
      })
    ).toBe('guide.md (stash@{0})')
  })

  it('builds commit, stash, staged, and unstaged GitDiffRequest values uniformly while preserving origPath', () => {
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

    expect(
      toGitDiffRequest(
        {
          kind: 'stash',
          stashRef: 'stash@{1}',
          stashHash: 'f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8'
        },
        {
          path: 'sub/draft.md',
          status: '?'
        }
      )
    ).toEqual({
      kind: 'stash',
      stashRef: 'stash@{1}',
      stashHash: 'f9e8d7c6b5a4f9e8d7c6b5a4f9e8d7c6b5a4f9e8',
      path: 'sub/draft.md',
      status: '?'
    })
  })

  it('produces distinct context labels and tab keys per commit hash and stash hash', () => {
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

    const stashA = toGitDiffRequest(
      { kind: 'stash', stashRef: 'stash@{0}', stashHash: '1111111111111111111111111111111111111111' },
      { path: 'guide.md', status: '?' }
    )
    const stashAShifted = toGitDiffRequest(
      { kind: 'stash', stashRef: 'stash@{1}', stashHash: '1111111111111111111111111111111111111111' },
      { path: 'guide.md', status: '?' }
    )
    const stashB = toGitDiffRequest(
      { kind: 'stash', stashRef: 'stash@{0}', stashHash: '2222222222222222222222222222222222222222' },
      { path: 'guide.md', status: '?' }
    )

    expect(getGitDiffContextLabel(stashA)).toBe('stash@{0}')
    expect(getGitDiffContextLabel(stashAShifted)).toBe('stash@{1}')
    expect(formatGitDiffTabKey(stashA)).toBe(formatGitDiffTabKey(stashAShifted))
    expect(formatGitDiffTabKey(stashA)).not.toBe(formatGitDiffTabKey(stashB))
  })

  it('keeps branch-compare tab keys invariant regardless of mergeBaseHash presence', () => {
    const baseRequest = {
      kind: 'branch-compare' as const,
      baseRef: 'main',
      compareRef: 'feat/perf',
      mode: 'three-dot' as const,
      path: 'docs/guide.md',
      origPath: 'docs/old-guide.md',
      status: 'R' as const
    }

    const expectedKey = formatGitDiffTabKey(baseRequest)
    expect(
      formatGitDiffTabKey({
        ...baseRequest,
        mergeBaseHash: '0123456789abcdef0123456789abcdef01234567'
      })
    ).toBe(expectedKey)
    expect(
      formatGitDiffTabKey({
        ...baseRequest,
        mergeBaseHash: null
      })
    ).toBe(expectedKey)
  })

  it('maps every GitFileStatusCode to VS Code UI display char, tone, label, and strikethrough without mutating input code', () => {
    const cases: Array<{
      code: GitFileStatusCode
      displayCode: string
      tone: string
      label: string
      strikethrough: boolean
    }> = [
      { code: 'M', displayCode: 'M', tone: 'amber', label: 'Modified', strikethrough: false },
      { code: 'A', displayCode: 'A', tone: 'green', label: 'Added', strikethrough: false },
      { code: 'D', displayCode: 'D', tone: 'red', label: 'Deleted', strikethrough: true },
      { code: 'R', displayCode: 'R', tone: 'accent', label: 'Renamed', strikethrough: false },
      { code: 'C', displayCode: 'C', tone: 'accent', label: 'Copied', strikethrough: false },
      { code: '?', displayCode: 'U', tone: 'green', label: 'Untracked', strikethrough: false },
      { code: 'U', displayCode: 'C', tone: 'red', label: 'Conflict', strikethrough: false }
    ]

    for (const item of cases) {
      const file: GitChangedFile = { path: 'docs/note.md', status: item.code }
      const result = getGitFileStatusDisplay(file.status)
      expect(result).toEqual({
        status: item.code,
        displayCode: item.displayCode,
        tone: item.tone,
        label: item.label,
        strikethrough: item.strikethrough
      })
      // Internal GitFileStatusCode remains unchanged on the domain record and diff requests.
      expect(file.status).toBe(item.code)
      expect(toGitDiffRequest('unstaged', file).status).toBe(item.code)
    }
  })

  it('splits changed file paths into filename, dimmed relative directory, and rename tooltips', () => {
    expect(getGitFileDirPath('README.md')).toBe('')
    expect(getGitFileDirPath('docs/sub/guide.md')).toBe('docs/sub')
    expect(getGitFileDirPath('docs\\sub\\guide.md')).toBe('docs/sub')

    expect(formatGitChangedFileDisplay({ path: 'README.md', status: 'M' })).toEqual({
      fileName: 'README.md',
      dirPath: '',
      tooltip: 'README.md'
    })

    expect(formatGitChangedFileDisplay({ path: 'docs/sub/guide.md', status: 'A' })).toEqual({
      fileName: 'guide.md',
      dirPath: 'docs/sub',
      tooltip: 'docs/sub/guide.md'
    })

    expect(
      formatGitChangedFileDisplay({
        path: 'docs/new-name.md',
        origPath: 'docs/old-name.md',
        status: 'R'
      })
    ).toEqual({
      fileName: 'old-name.md → new-name.md',
      dirPath: 'docs',
      tooltip: 'docs/old-name.md → docs/new-name.md'
    })

    expect(
      formatGitChangedFileDisplay({
        path: 'new/guide.md',
        origPath: 'legacy/old.md',
        status: 'R'
      })
    ).toEqual({
      fileName: 'legacy/old.md → guide.md',
      dirPath: 'new',
      tooltip: 'legacy/old.md → new/guide.md'
    })
  })

  it('excludes deleted files and paths outside the open workspace root from workspace file opening', () => {
    expect(
      canOpenGitChangedFile({ path: 'notes.md', status: 'M' }, 'C:/repo', 'C:/repo')
    ).toBe(true)
    expect(
      canOpenGitChangedFile({ path: 'draft.md', status: '?' }, 'C:/repo', 'C:/repo')
    ).toBe(true)
    expect(
      canOpenGitChangedFile({ path: 'conflict.md', status: 'U' }, 'C:/repo', 'C:/repo')
    ).toBe(true)
    expect(
      canOpenGitChangedFile({ path: 'gone.md', status: 'D' }, 'C:/repo', 'C:/repo')
    ).toBe(false)

    // Subdirectory workspace inside a larger Git repo: only files under workspace root can open
    expect(
      canOpenGitChangedFile({ path: 'wiki/guide.md', status: 'M' }, 'C:/repo', 'C:/repo/wiki')
    ).toBe(true)
    expect(
      canOpenGitChangedFile({ path: 'docs/outside.md', status: 'M' }, 'C:/repo', 'C:/repo/wiki')
    ).toBe(false)
    expect(
      canOpenGitChangedFile({ path: '../escape.md', status: 'M' }, 'C:/repo', 'C:/repo/wiki')
    ).toBe(false)
    expect(canOpenGitChangedFile({ path: 'notes.md', status: 'M' }, 'C:/repo', null)).toBe(false)
  })

  it('formats workspace-relative and platform-aware absolute paths for Git and Compare files and compressed folders', () => {
    // Same root (POSIX)
    expect(formatGitRepoCopyPath('docs/guide.md', 'relative', '/repo', '/repo')).toBe('docs/guide.md')
    expect(formatGitRepoCopyPath('docs/guide.md', 'absolute', '/repo', '/repo')).toBe(
      '/repo/docs/guide.md'
    )

    // Sub-workspace inside monorepo: relative path is anchored to workspaceRootPath
    expect(
      formatGitRepoCopyPath('packages/wiki/docs/guide.md', 'relative', '/repo', '/repo/packages/wiki')
    ).toBe('docs/guide.md')
    expect(
      formatGitRepoCopyPath('packages/wiki/docs/guide.md', 'absolute', '/repo', '/repo/packages/wiki')
    ).toBe('/repo/packages/wiki/docs/guide.md')

    // External monorepo path: relative falls back to normalized repo-relative path
    expect(
      formatGitRepoCopyPath('packages/other/readme.md', 'relative', '/repo', '/repo/packages/wiki')
    ).toBe('packages/other/readme.md')
    expect(
      formatGitRepoCopyPath('packages/other/readme.md', 'absolute', '/repo', '/repo/packages/wiki')
    ).toBe('/repo/packages/other/readme.md')

    // Compressed folder node path (`a/b/c`)
    expect(formatGitRepoCopyPath('a/b/c', 'relative', '/repo', '/repo')).toBe('a/b/c')
    expect(formatGitRepoCopyPath('a/b/c', 'absolute', '/repo', '/repo')).toBe('/repo/a/b/c')

    // Windows root & backslash normalization
    expect(
      formatGitRepoCopyPath('wiki\\docs\\a.md', 'relative', 'C:\\repo', 'C:\\repo\\wiki')
    ).toBe('docs/a.md')
    expect(
      formatGitRepoCopyPath('wiki/docs/a.md', 'absolute', 'C:\\repo', 'C:\\repo\\wiki')
    ).toBe('C:\\repo\\wiki\\docs\\a.md')

    // Missing repoRoot falls back to workspaceRootPath
    expect(formatGitRepoCopyPath('notes/today.md', 'relative', null, '/workspace')).toBe(
      'notes/today.md'
    )
    expect(formatGitRepoCopyPath('notes/today.md', 'absolute', null, '/workspace')).toBe(
      '/workspace/notes/today.md'
    )
  })
})
