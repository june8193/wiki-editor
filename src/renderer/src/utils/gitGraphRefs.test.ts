import { describe, expect, it } from 'vitest'
import type { GitRefBadge } from '@shared/git'
import { normalizeGitGraphRefs } from './gitGraphRefs'

describe('normalizeGitGraphRefs', () => {
  it('returns an empty list when a commit has no refs', () => {
    expect(normalizeGitGraphRefs([])).toEqual([])
  })

  it('merges matching remote tracking refs into the local branch and omits redundant HEAD when checked out', () => {
    const refs: GitRefBadge[] = [
      { name: 'HEAD', kind: 'head', isCurrentHead: true },
      { name: 'master', kind: 'local-branch', isCurrentHead: true },
      { name: 'origin/master', kind: 'remote-branch' },
      { name: 'upstream/master', kind: 'remote-branch' }
    ]

    expect(normalizeGitGraphRefs(refs)).toEqual([
      {
        kind: 'branch',
        name: 'master',
        isCurrentHead: true,
        syncedRemotes: ['origin', 'upstream']
      }
    ])
  })

  it('splits remote refs on the first slash so slashed branch names merge cleanly', () => {
    const refs: GitRefBadge[] = [
      { name: 'feature/git-panel', kind: 'local-branch', isCurrentHead: false },
      { name: 'origin/feature/git-panel', kind: 'remote-branch' },
      { name: 'origin/feature/unmatched', kind: 'remote-branch' }
    ]

    expect(normalizeGitGraphRefs(refs)).toEqual([
      {
        kind: 'branch',
        name: 'feature/git-panel',
        isCurrentHead: false,
        syncedRemotes: ['origin']
      },
      {
        kind: 'remote',
        name: 'origin/feature/unmatched'
      }
    ])
  })

  it('keeps unmatched remote refs as standalone remote badges', () => {
    const refs: GitRefBadge[] = [
      { name: 'origin/main', kind: 'remote-branch' },
      { name: 'upstream/release/v2', kind: 'remote-branch' },
      { name: 'malformed-remote', kind: 'remote-branch' }
    ]

    expect(normalizeGitGraphRefs(refs)).toEqual([
      { kind: 'remote', name: 'origin/main' },
      { kind: 'remote', name: 'upstream/release/v2' },
      { kind: 'remote', name: 'malformed-remote' }
    ])
  })

  it('displays HEAD badge only on detached HEAD, even when non-checked-out local branches point to the same commit', () => {
    expect(
      normalizeGitGraphRefs([{ name: 'HEAD', kind: 'head', isCurrentHead: true }])
    ).toEqual([{ kind: 'head' }])

    expect(
      normalizeGitGraphRefs([
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: false },
        { name: 'origin/main', kind: 'remote-branch' }
      ])
    ).toEqual([
      { kind: 'head' },
      {
        kind: 'branch',
        name: 'main',
        isCurrentHead: false,
        syncedRemotes: ['origin']
      }
    ])
  })

  it('orders head/current-branch, local branches, standalone remotes, and tags deterministically and deduplicates', () => {
    const refs: GitRefBadge[] = [
      { name: 'v1.0.0', kind: 'tag' },
      { name: 'v1.0.0', kind: 'tag' },
      { name: 'origin/release', kind: 'remote-branch' },
      { name: 'topic', kind: 'local-branch' },
      { name: 'origin/main', kind: 'remote-branch' },
      { name: 'origin/main', kind: 'remote-branch' },
      { name: 'main', kind: 'local-branch', isCurrentHead: true },
      { name: 'HEAD', kind: 'head', isCurrentHead: true }
    ]

    expect(normalizeGitGraphRefs(refs)).toEqual([
      {
        kind: 'branch',
        name: 'main',
        isCurrentHead: true,
        syncedRemotes: ['origin']
      },
      {
        kind: 'branch',
        name: 'topic',
        isCurrentHead: false,
        syncedRemotes: []
      },
      { kind: 'remote', name: 'origin/release' },
      { kind: 'tag', name: 'v1.0.0' }
    ])
  })
})
