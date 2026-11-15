import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitGraphCommit,
  type GitLogResult,
  type GitStatus
} from '@shared/git'
import type { WikiApi } from '@shared/ipc'
import { useGitController } from './useGitController'

function makeStatus(branch: string, ahead = 0): GitStatus {
  return {
    ...createEmptyGitStatus(true, 'C:/wiki'),
    branch,
    hasUpstream: true,
    ahead
  }
}

describe('useGitController', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does not drop active mutation updates when refreshStatus is triggered concurrently by file watchers', async () => {
    let resolvePull!: (value: GitStatus) => void
    const pullPromise = new Promise<GitStatus>((resolve) => {
      resolvePull = resolve
    })

    const pullMock = vi.fn(() => pullPromise)
    const statusMock = vi.fn(async () => makeStatus('main', 0))
    const branchesMock = vi.fn(async () => ({
      current: 'feature',
      isDetached: false,
      branches: [
        { name: 'main', current: false, upstream: 'origin/main' },
        { name: 'feature', current: true, upstream: 'origin/feature' }
      ]
    }))

    window.wikiApi = {
      git: {
        status: statusMock,
        init: vi.fn(),
        stage: vi.fn(),
        stageAll: vi.fn(),
        unstage: vi.fn(),
        unstageAll: vi.fn(),
        commit: vi.fn(),
        branches: branchesMock,
        checkout: vi.fn(),
        pull: pullMock,
        push: vi.fn(),
        sync: vi.fn(),
        log: vi.fn(async () => ({ commits: [], hasMore: false }))
      }
    } as unknown as WikiApi

    const onWorkspaceMutated = vi.fn(async () => [])
    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        onWorkspaceMutated
      })
    )

    await waitFor(() => {
      expect(result.current.status?.branch).toBe('main')
    })

    // Start Pull (blocks on pullPromise)
    let pendingPull!: Promise<void>
    act(() => {
      pendingPull = result.current.pull()
    })

    await waitFor(() => {
      expect(result.current.pendingAction).toBe('Pull')
    })

    // Simulate fsWatch calling refreshStatus mid-Pull
    const callsBeforeWatch = statusMock.mock.calls.length
    await act(async () => {
      await result.current.refreshStatus()
    })
    expect(statusMock.mock.calls.length).toBe(callsBeforeWatch)

    // Complete Pull -> updated status & branches apply cleanly
    await act(async () => {
      resolvePull(makeStatus('feature', 3))
      await pendingPull
    })

    expect(result.current.status?.branch).toBe('feature')
    expect(result.current.status?.ahead).toBe(3)
    expect(result.current.branchList?.current).toBe('feature')
    expect(onWorkspaceMutated).toHaveBeenCalledTimes(1)
    expect(result.current.pendingAction).toBeNull()
  })

  it('passes both path and origPath to unstage and discards stale status when workspace switches', async () => {
    let resolveFirstStatus!: (value: GitStatus) => void
    const firstStatusPromise = new Promise<GitStatus>((resolve) => {
      resolveFirstStatus = resolve
    })

    const unstageMock = vi.fn(async () => makeStatus('main'))
    const statusMock = vi
      .fn()
      .mockImplementationOnce(() => firstStatusPromise)
      .mockImplementation(async () => makeStatus('other-repo', 1))

    window.wikiApi = {
      git: {
        status: statusMock,
        init: vi.fn(),
        stage: vi.fn(),
        stageAll: vi.fn(),
        unstage: unstageMock,
        unstageAll: vi.fn(),
        commit: vi.fn(),
        branches: vi.fn(async () => ({ current: 'other-repo', isDetached: false, branches: [] })),
        checkout: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        sync: vi.fn(),
        log: vi.fn(async () => ({ commits: [], hasMore: false }))
      }
    } as unknown as WikiApi

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) => useGitController({ workspaceRootPath: ws }),
      { initialProps: { ws: 'C:/repo-a' } }
    )

    // Switch workspace before repo-a status resolves
    rerender({ ws: 'C:/repo-b' })
    await waitFor(() => {
      expect(result.current.status?.branch).toBe('other-repo')
    })

    // Resolve stale repo-a status -> must NOT overwrite repo-b
    await act(async () => {
      resolveFirstStatus(makeStatus('stale-a', 9))
    })
    expect(result.current.status?.branch).toBe('other-repo')

    await act(async () => {
      await result.current.unstageFile('new.md', 'old.md')
    })
    expect(unstageMock).toHaveBeenCalledWith('C:/repo-b', ['new.md', 'old.md'])
  })

  it('does not clear active mutation lock or loading state in a new workspace when a stale mutation finishes', async () => {
    let resolveSlowRepoAPull!: (value: GitStatus) => void
    let resolveRepoBPull!: (value: GitStatus) => void
    const pullMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GitStatus>((resolve) => {
            resolveSlowRepoAPull = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<GitStatus>((resolve) => {
            resolveRepoBPull = resolve
          })
      )

    window.wikiApi = {
      git: {
        status: vi.fn(async (ws) => makeStatus(ws === 'C:/repo-a' ? 'a-branch' : 'b-branch')),
        init: vi.fn(),
        stage: vi.fn(),
        stageAll: vi.fn(),
        unstage: vi.fn(),
        unstageAll: vi.fn(),
        commit: vi.fn(),
        branches: vi.fn(async () => ({ current: 'b-branch', isDetached: false, branches: [] })),
        checkout: vi.fn(),
        pull: pullMock,
        push: vi.fn(),
        sync: vi.fn(),
        log: vi.fn(async () => ({ commits: [], hasMore: false }))
      }
    } as unknown as WikiApi

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) => useGitController({ workspaceRootPath: ws }),
      { initialProps: { ws: 'C:/repo-a' } }
    )

    await waitFor(() => {
      expect(result.current.status?.branch).toBe('a-branch')
    })

    let slowPull!: Promise<void>
    act(() => {
      slowPull = result.current.pull()
    })
    await waitFor(() => {
      expect(result.current.pendingAction).toBe('Pull')
    })

    // Switch to repo-b and start a Pull there before repo-a finishes
    rerender({ ws: 'C:/repo-b' })
    await waitFor(() => {
      expect(result.current.status?.branch).toBe('b-branch')
    })

    let repoBPull!: Promise<void>
    act(() => {
      repoBPull = result.current.pull()
    })
    await waitFor(() => {
      expect(result.current.pendingAction).toBe('Pull')
    })

    // Resolve stale repo-a Pull -> repo-b lock and pendingAction must stay active
    await act(async () => {
      resolveSlowRepoAPull(makeStatus('stale-a'))
      await slowPull
    })
    expect(result.current.pendingAction).toBe('Pull')
    expect(result.current.status?.branch).toBe('b-branch')

    await act(async () => {
      resolveRepoBPull(makeStatus('b-updated', 2))
      await repoBPull
    })
    expect(result.current.pendingAction).toBeNull()
    expect(result.current.status?.branch).toBe('b-updated')
  })

  it('loads commit graph on repo init, filters by scope, paginates with loadMoreCommits, and refreshes page 1 on repository mutations', async () => {
    const makeCommit = (hash: string): GitGraphCommit => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents: [],
      subject: `commit ${hash}`,
      authorName: 'Tester',
      committedAt: '2026-11-15T12:00:00+09:00',
      refs: []
    })

    const allPage1 = [makeCommit('a1'), makeCommit('a2')]
    const allPage2 = [makeCommit('a3')]
    const currentPage1 = [makeCommit('c1')]
    const refreshedCurrent = [makeCommit('c2'), makeCommit('c1')]

    let committed = false
    const logMock = vi.fn(async (_ws, options?: { scope?: string; skip?: number }) => {
      if (options?.scope === 'current') {
        return {
          commits: committed ? refreshedCurrent : currentPage1,
          hasMore: false
        }
      }
      if ((options?.skip ?? 0) === 2) {
        return { commits: allPage2, hasMore: false }
      }
      return { commits: allPage1, hasMore: true }
    })

    const nextStatus = makeStatus('main', 0)
    window.wikiApi = {
      git: {
        status: vi.fn(async () => nextStatus),
        init: vi.fn(async () => nextStatus),
        stage: vi.fn(async () => nextStatus),
        stageAll: vi.fn(async () => nextStatus),
        unstage: vi.fn(async () => nextStatus),
        unstageAll: vi.fn(async () => nextStatus),
        commit: vi.fn(async () => {
          committed = true
          return nextStatus
        }),
        branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
        checkout: vi.fn(async () => nextStatus),
        pull: vi.fn(async () => nextStatus),
        push: vi.fn(async () => nextStatus),
        sync: vi.fn(async () => nextStatus),
        log: logMock
      }
    } as unknown as WikiApi

    const { result } = renderHook(() => useGitController({ workspaceRootPath: 'C:/wiki' }))

    await waitFor(() => {
      expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['a1', 'a2'])
    })
    expect(result.current.graphState.scope).toBe('all')
    expect(result.current.graphState.hasMore).toBe(true)
    expect(logMock).toHaveBeenCalledWith('C:/wiki', { scope: 'all', limit: 100, skip: 0 })

    // Load next page
    await act(async () => {
      await result.current.loadMoreCommits()
    })
    expect(logMock).toHaveBeenLastCalledWith('C:/wiki', { scope: 'all', limit: 100, skip: 2 })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['a1', 'a2', 'a3'])
    expect(result.current.graphState.hasMore).toBe(false)

    // Stage/unstage should NOT re-fetch commit history
    const callsBeforeStage = logMock.mock.calls.length
    await act(async () => {
      await result.current.stageFile('notes.md')
      await result.current.unstageFile('notes.md')
    })
    expect(logMock).toHaveBeenCalledTimes(callsBeforeStage)

    // Switch filter to current branch
    await act(async () => {
      await result.current.changeLogScope('current')
    })
    expect(result.current.graphState.scope).toBe('current')
    expect(logMock).toHaveBeenLastCalledWith('C:/wiki', { scope: 'current', limit: 100, skip: 0 })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['c1'])

    // Commit, Checkout, Pull, Push, Sync, and Refresh each refresh page 1 with active scope
    await act(async () => {
      await result.current.commit('Add feature')
    })
    expect(logMock).toHaveBeenLastCalledWith('C:/wiki', { scope: 'current', limit: 100, skip: 0 })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['c2', 'c1'])

    const callsBeforeActions = logMock.mock.calls.length
    await act(async () => {
      await result.current.checkoutBranch('main')
      await result.current.pull()
      await result.current.push()
      await result.current.sync()
      await result.current.refreshStatus()
    })
    expect(logMock).toHaveBeenCalledTimes(callsBeforeActions + 5)
  })

  it('ignores stale git.log responses across filter switches, loadMore races, and workspace switches', async () => {
    const makeCommit = (hash: string): GitGraphCommit => ({
      hash,
      shortHash: hash.slice(0, 7),
      parents: [],
      subject: hash,
      authorName: 'Tester',
      committedAt: '2026-11-15T12:00:00+09:00',
      refs: []
    })

    let resolveRepoAAllPage2!: (value: GitLogResult) => void
    const repoAAllPage2Promise = new Promise<GitLogResult>((resolve) => {
      resolveRepoAAllPage2 = resolve
    })

    let resolveRepoACurrentDelayed!: (value: GitLogResult) => void
    let delayRepoACurrent = false
    const repoACurrentDelayedPromise = new Promise<GitLogResult>((resolve) => {
      resolveRepoACurrentDelayed = resolve
    })

    let resolveRepoBLog!: (value: GitLogResult) => void
    const repoBLogPromise = new Promise<GitLogResult>((resolve) => {
      resolveRepoBLog = resolve
    })

    const logMock = vi.fn((ws: string, options?: { scope?: string; skip?: number }) => {
      if (ws === 'C:/repo-a') {
        if (options?.scope === 'current') {
          if (delayRepoACurrent) {
            return repoACurrentDelayedPromise
          }
          return Promise.resolve({ commits: [makeCommit('a-current-1')], hasMore: false })
        }
        if ((options?.skip ?? 0) === 1) {
          return repoAAllPage2Promise
        }
        return Promise.resolve({ commits: [makeCommit('a-all-1')], hasMore: true })
      }
      return repoBLogPromise
    })

    window.wikiApi = {
      git: {
        status: vi.fn(async (ws) => makeStatus(ws === 'C:/repo-a' ? 'branch-a' : 'branch-b')),
        init: vi.fn(),
        stage: vi.fn(),
        stageAll: vi.fn(),
        unstage: vi.fn(),
        unstageAll: vi.fn(),
        commit: vi.fn(),
        branches: vi.fn(async () => ({ current: 'branch-a', isDetached: false, branches: [] })),
        checkout: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        sync: vi.fn(),
        log: logMock
      }
    } as unknown as WikiApi

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) => useGitController({ workspaceRootPath: ws }),
      { initialProps: { ws: 'C:/repo-a' } }
    )

    await waitFor(() => {
      expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['a-all-1'])
    })

    // Start slow loadMore on 'all', then switch filter to 'current' before page 2 resolves
    let pendingLoadMore!: Promise<void>
    act(() => {
      pendingLoadMore = result.current.loadMoreCommits()
    })

    await act(async () => {
      await result.current.changeLogScope('current')
    })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['a-current-1'])

    // Stale page-2 response resolves later -> must NOT append onto 'current' results
    await act(async () => {
      resolveRepoAAllPage2({ commits: [makeCommit('stale-page-2')], hasMore: false })
      await pendingLoadMore
    })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['a-current-1'])
    expect(result.current.graphState.scope).toBe('current')
    expect(result.current.graphState.isLoadingMore).toBe(false)

    // Trigger a slow refresh in repo-a before switching to repo-b
    delayRepoACurrent = true
    act(() => {
      void result.current.refreshStatus()
    })

    // Switch workspace -> scope resets to 'all' and previous repo commits clear cleanly
    rerender({ ws: 'C:/repo-b' })
    await waitFor(() => {
      expect(result.current.graphState.scope).toBe('all')
    })
    expect(result.current.graphState.commits).toEqual([])

    await act(async () => {
      resolveRepoBLog({ commits: [makeCommit('b-all-1')], hasMore: false })
    })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['b-all-1'])

    // Stale repo-a response resolving after repo-b finished must be ignored
    await act(async () => {
      resolveRepoACurrentDelayed({ commits: [makeCommit('stale-repo-a')], hasMore: false })
    })
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['b-all-1'])
  })
})
