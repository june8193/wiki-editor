import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitCommitDetail,
  type GitGraphCommit,
  type GitLogResult,
  type GitStashEntry,
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

function makeCommit(hash: string): GitGraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    subject: `commit ${hash}`,
    authorName: 'Tester',
    committedAt: '2026-11-15T12:00:00+09:00',
    refs: []
  }
}

function makeCommitDetail(hash: string): GitCommitDetail {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    subject: `commit ${hash}`,
    body: `Detail body for ${hash}`,
    authorName: 'Tester',
    authorEmail: 'tester@example.com',
    committedAt: '2026-11-15T12:00:00+09:00',
    files: [{ path: `${hash}.md`, status: 'A' }]
  }
}

function installMockGitWikiApi(overrides: Partial<WikiApi['git']> = {}): void {
  window.wikiApi = {
    git: {
      status: vi.fn(async () => makeStatus('main')),
      init: vi.fn(),
      stage: vi.fn(),
      stageAll: vi.fn(),
      unstage: vi.fn(),
      unstageAll: vi.fn(),
      discard: vi.fn(),
      discardAll: vi.fn(),
      commit: vi.fn(),
      branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
      checkout: vi.fn(),
      pull: vi.fn(),
      push: vi.fn(),
      fetch: vi.fn(),
      sync: vi.fn(),
      log: vi.fn(async () => ({ commits: [], hasMore: false })),
      commitDetail: vi.fn(async (_ws: string, hash: string) => makeCommitDetail(hash)),
      diff: vi.fn(async (_ws: string, req) => ({
        path: req.path,
        ...(req.origPath ? { origPath: req.origPath } : {}),
        status: req.status,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: ''
      })),
      stashList: vi.fn(async () => []),
      stashCreate: vi.fn(),
      stashApply: vi.fn(),
      stashPop: vi.fn(),
      stashDrop: vi.fn(async () => []),
      stashClear: vi.fn(async () => []),
      ...overrides
    }
  } as unknown as WikiApi
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
        log: vi.fn(async () => ({ commits: [], hasMore: false })),
        stashList: vi.fn(async () => [])
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
        log: vi.fn(async () => ({ commits: [], hasMore: false })),
        stashList: vi.fn(async () => [])
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
        log: vi.fn(async () => ({ commits: [], hasMore: false })),
        stashList: vi.fn(async () => [])
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
        log: logMock,
        stashList: vi.fn(async () => [])
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
        log: logMock,
        stashList: vi.fn(async () => [])
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

  it('toggles inline commit detail expand/collapse, handles errors, and ignores stale detail responses', async () => {
    let resolveSlowDetail1!: (value: GitCommitDetail) => void
    const slowDetail1Promise = new Promise<GitCommitDetail>((resolve) => {
      resolveSlowDetail1 = resolve
    })

    const detailMock = vi.fn((_ws: string, hash: string) => {
      if (hash === 'aaaa111') {
        return slowDetail1Promise
      }
      if (hash === 'err3333') {
        return Promise.reject(new Error('커밋 상세 조회 실패'))
      }
      return Promise.resolve(makeCommitDetail(hash))
    })

    installMockGitWikiApi({
      log: vi.fn(async () => ({
        commits: [makeCommit('aaaa111'), makeCommit('bbbb222'), makeCommit('err3333')],
        hasMore: false
      })),
      commitDetail: detailMock
    })

    const { result } = renderHook(() => useGitController({ workspaceRootPath: 'C:/wiki' }))
    await waitFor(() => {
      expect(result.current.graphState.commits).toHaveLength(3)
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })

    // Start loading detail for aaaa111, then immediately switch to bbbb222
    let pendingFirst!: Promise<void>
    act(() => {
      pendingFirst = result.current.toggleCommitDetail('aaaa111')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loading',
      selectedHash: 'aaaa111'
    })

    await act(async () => {
      await result.current.toggleCommitDetail('bbbb222')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: 'bbbb222',
      detail: makeCommitDetail('bbbb222')
    })

    // Stale slow response for aaaa111 must be ignored
    await act(async () => {
      resolveSlowDetail1(makeCommitDetail('aaaa111'))
      await pendingFirst
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: 'bbbb222',
      detail: makeCommitDetail('bbbb222')
    })

    // Clicking bbbb222 again collapses it without re-fetching
    const callsBeforeCollapse = detailMock.mock.calls.length
    await act(async () => {
      await result.current.toggleCommitDetail('bbbb222')
    })
    expect(detailMock).toHaveBeenCalledTimes(callsBeforeCollapse)
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })

    // Error state is preserved on selected commit until collapsed
    await act(async () => {
      await result.current.toggleCommitDetail('err3333')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'error',
      selectedHash: 'err3333',
      errorMessage: '커밋 상세 조회 실패'
    })

    await act(async () => {
      await result.current.toggleCommitDetail('err3333')
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })
  })

  it('clears expanded commit detail on scope filter switch, workspace switch, and when refreshed log drops selected commit', async () => {
    let scopeMode: 'all' | 'current' = 'all'
    let currentCommits = [makeCommit('main111'), makeCommit('side222')]

    let resolveDelayedDetail!: (value: GitCommitDetail) => void
    let delayNextDetail = false

    const detailMock = vi.fn((_ws: string, hash: string) => {
      if (delayNextDetail) {
        delayNextDetail = false
        return new Promise<GitCommitDetail>((resolve) => {
          resolveDelayedDetail = resolve
        })
      }
      return Promise.resolve(makeCommitDetail(hash))
    })

    installMockGitWikiApi({
      status: vi.fn(async (ws) => makeStatus(ws === 'C:/repo-a' ? 'main' : 'other')),
      log: vi.fn(async (_ws: string, options?: { scope?: 'all' | 'current' }) => {
        scopeMode = options?.scope ?? 'all'
        if (scopeMode === 'current') {
          return { commits: [makeCommit('main111')], hasMore: false }
        }
        return { commits: currentCommits, hasMore: false }
      }),
      commitDetail: detailMock
    })

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) => useGitController({ workspaceRootPath: ws }),
      { initialProps: { ws: 'C:/repo-a' } }
    )
    await waitFor(() => {
      expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['main111', 'side222'])
    })

    // Expand side222, then switch scope to current -> expansion must clear cleanly
    await act(async () => {
      await result.current.toggleCommitDetail('side222')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: 'side222',
      detail: makeCommitDetail('side222')
    })

    await act(async () => {
      await result.current.changeLogScope('current')
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })

    // Expand main111 while switching back to 'all', keeping main111 when refreshed list still includes it
    await act(async () => {
      await result.current.changeLogScope('all')
    })
    await act(async () => {
      await result.current.toggleCommitDetail('main111')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: 'main111',
      detail: makeCommitDetail('main111')
    })

    await act(async () => {
      await result.current.refreshStatus()
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loaded',
      selectedHash: 'main111',
      detail: makeCommitDetail('main111')
    })

    // If refresh drops main111 (e.g. rewritten/different history), selection clears cleanly
    currentCommits = [makeCommit('other999')]
    await act(async () => {
      await result.current.refreshStatus()
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })

    // Start delayed detail fetch in repo-a, then switch to repo-b -> clears & ignores stale response
    delayNextDetail = true
    let pendingStaleDetail!: Promise<void>
    act(() => {
      pendingStaleDetail = result.current.toggleCommitDetail('other999')
    })
    expect(result.current.graphState.commitDetail).toEqual({
      status: 'loading',
      selectedHash: 'other999'
    })

    rerender({ ws: 'C:/repo-b' })
    await waitFor(() => {
      expect(result.current.status?.branch).toBe('other')
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })

    await act(async () => {
      resolveDelayedDetail(makeCommitDetail('other999'))
      await pendingStaleDetail
    })
    expect(result.current.graphState.commitDetail).toEqual({ status: 'idle' })
  })

  it('runs discardFile with target-scoped confirm, prepare/finish discard callbacks, status refresh without log refetch, and error recovery', async () => {
    const cleanStatus = makeStatus('main', 0)
    const dirtyStatus: GitStatus = {
      ...cleanStatus,
      unstaged: [{ path: 'notes.md', status: 'M' }]
    }
    const discardMock = vi
      .fn()
      .mockResolvedValueOnce(cleanStatus)
      .mockRejectedValueOnce(new Error('discard failed'))
    const logMock = vi.fn(async () => ({ commits: [], hasMore: false }))

    installMockGitWikiApi({
      status: vi.fn(async () => dirtyStatus),
      discard: discardMock,
      log: logMock
    })

    let confirmDecision = false
    const confirmBeforeWorkspaceMutation = vi.fn(async () => confirmDecision)
    const onBeforeWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onAfterWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onWorkspaceMutated = vi.fn(async () => [])
    const activeTransitions: boolean[] = []

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmBeforeWorkspaceMutation,
        onBeforeWorkspaceBufferMutation,
        onAfterWorkspaceBufferMutation,
        onWorkspaceMutated,
        onWorkspaceMutationActiveChange: (active) => activeTransitions.push(active)
      })
    )

    await waitFor(() => {
      expect(result.current.status?.unstaged).toHaveLength(1)
    })
    const logCallsBeforeDiscard = logMock.mock.calls.length

    // 1. Canceled confirmation aborts discard cleanly
    await act(async () => {
      await result.current.discardFile('notes.md')
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledWith('변경 사항 롤백', ['notes.md'])
    expect(onBeforeWorkspaceBufferMutation).not.toHaveBeenCalled()
    expect(discardMock).not.toHaveBeenCalled()
    expect(onAfterWorkspaceBufferMutation).not.toHaveBeenCalled()
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(activeTransitions).toEqual([true, false])

    // 2. Approved confirmation prepares, discards, updates status, and skips log refetch
    confirmDecision = true
    await act(async () => {
      await result.current.discardFile('notes.md')
    })
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledWith({
      kind: 'discard-paths',
      paths: ['notes.md']
    })
    expect(discardMock).toHaveBeenCalledWith('C:/wiki', ['notes.md'])
    expect(onAfterWorkspaceBufferMutation).toHaveBeenCalledWith(
      { kind: 'discard-paths', paths: ['notes.md'] },
      true,
      cleanStatus
    )
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(result.current.status?.unstaged).toEqual([])
    expect(logMock).toHaveBeenCalledTimes(logCallsBeforeDiscard)

    // 3. Failure releases discard lock with succeeded=false and reports error
    await act(async () => {
      await result.current.discardFile('notes.md')
    })
    expect(onAfterWorkspaceBufferMutation).toHaveBeenLastCalledWith(
      { kind: 'discard-paths', paths: ['notes.md'] },
      false,
      dirtyStatus
    )
    expect(result.current.errorMessage).toBe('discard failed')
  })

  it('runs discardAll with unstaged+untracked target paths (excluding staged-only), scope=all, skips log refetch, and recovers on failure', async () => {
    const cleanAfterStatus: GitStatus = {
      ...makeStatus('main', 0),
      staged: [{ path: 'staged-only.md', status: 'A' }]
    }
    const mixedStatus: GitStatus = {
      ...cleanAfterStatus,
      unstaged: [
        { path: 'modified.md', status: 'M' },
        { path: 'conflict.md', status: 'U' }
      ],
      untracked: [{ path: 'draft.md', status: '?' }]
    }
    const discardAllMock = vi
      .fn()
      .mockResolvedValueOnce(cleanAfterStatus)
      .mockRejectedValueOnce(new Error('discardAll failed'))
    const logMock = vi.fn(async () => ({ commits: [], hasMore: false }))

    installMockGitWikiApi({
      status: vi.fn(async () => mixedStatus),
      discardAll: discardAllMock,
      log: logMock
    })

    let confirmDecision = false
    const confirmBeforeWorkspaceMutation = vi.fn(async () => confirmDecision)
    const onBeforeWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onAfterWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onWorkspaceMutated = vi.fn(async () => [])

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmBeforeWorkspaceMutation,
        onBeforeWorkspaceBufferMutation,
        onAfterWorkspaceBufferMutation,
        onWorkspaceMutated
      })
    )

    await waitFor(() => {
      expect(result.current.status?.unstaged).toHaveLength(2)
    })
    const logCallsBeforeDiscardAll = logMock.mock.calls.length
    const expectedTargets = ['modified.md', 'conflict.md', 'draft.md']

    // 1. Canceled confirmation aborts cleanly
    await act(async () => {
      await result.current.discardAll()
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledWith(
      '전체 변경 사항 롤백',
      expectedTargets
    )
    expect(onBeforeWorkspaceBufferMutation).not.toHaveBeenCalled()
    expect(discardAllMock).not.toHaveBeenCalled()
    expect(onAfterWorkspaceBufferMutation).not.toHaveBeenCalled()

    // 2. Approved confirmation runs discardAll, skips log refetch, and passes scope=all
    confirmDecision = true
    await act(async () => {
      await result.current.discardAll()
    })
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledWith({
      kind: 'discard-all',
      paths: expectedTargets
    })
    expect(discardAllMock).toHaveBeenCalledWith('C:/wiki')
    expect(onAfterWorkspaceBufferMutation).toHaveBeenCalledWith(
      { kind: 'discard-all', paths: expectedTargets },
      true,
      cleanAfterStatus
    )
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(result.current.status?.unstaged).toEqual([])
    expect(result.current.status?.untracked).toEqual([])
    expect(result.current.status?.staged).toEqual([{ path: 'staged-only.md', status: 'A' }])
    expect(logMock).toHaveBeenCalledTimes(logCallsBeforeDiscardAll)

    // 3. Failure releases discard lock with succeeded=false and reports error
    await act(async () => {
      await result.current.discardAll()
    })
    expect(onAfterWorkspaceBufferMutation).toHaveBeenLastCalledWith(
      { kind: 'discard-all', paths: [] },
      false,
      mixedStatus
    )
    expect(result.current.errorMessage).toBe('discardAll failed')
  })

  it('runs fetch without dirty workspace confirm or workspace mutation callbacks, updates status/branches/graph, and reports errors', async () => {
    const initialStatus = makeStatus('main', 0)
    const fetchedStatus: GitStatus = { ...initialStatus, behind: 2 }

    let resolveFetch!: (value: GitStatus) => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GitStatus>((resolve) => {
            resolveFetch = resolve
          })
      )
      .mockRejectedValueOnce(new Error('원격 저장소(remote)가 설정되어 있지 않습니다.'))
      .mockRejectedValueOnce('unknown error')

    const branchesMock = vi
      .fn()
      .mockResolvedValueOnce({ current: 'main', isDetached: false, branches: [] })
      .mockResolvedValueOnce({
        current: 'main',
        isDetached: false,
        branches: [
          { name: 'main', current: true, upstream: 'origin/main' },
          { name: 'release', current: false, upstream: null }
        ]
      })

    let fetchedOnce = false
    const logMock = vi.fn(async () => ({
      commits: fetchedOnce ? [makeCommit('remote222'), makeCommit('local111')] : [makeCommit('local111')],
      hasMore: false
    }))

    installMockGitWikiApi({
      status: vi.fn(async () => initialStatus),
      fetch: fetchMock,
      branches: branchesMock,
      log: logMock
    })

    const confirmBeforeWorkspaceMutation = vi.fn(async () => true)
    const onWorkspaceMutated = vi.fn(async () => [])

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmBeforeWorkspaceMutation,
        onWorkspaceMutated
      })
    )

    await waitFor(() => {
      expect(result.current.status?.branch).toBe('main')
    })

    let pendingFetch!: Promise<void>
    act(() => {
      pendingFetch = result.current.fetch()
    })
    await waitFor(() => {
      expect(result.current.pendingAction).toBe('Fetch')
    })

    fetchedOnce = true
    await act(async () => {
      resolveFetch(fetchedStatus)
      await pendingFetch
    })

    expect(fetchMock).toHaveBeenCalledWith('C:/wiki')
    expect(confirmBeforeWorkspaceMutation).not.toHaveBeenCalled()
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(result.current.pendingAction).toBeNull()
    expect(result.current.status?.behind).toBe(2)
    expect(result.current.branchList?.branches.map((b) => b.name)).toEqual(['main', 'release'])
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['remote222', 'local111'])

    await act(async () => {
      await result.current.fetch()
    })
    expect(result.current.errorMessage).toBe('원격 저장소(remote)가 설정되어 있지 않습니다.')

    await act(async () => {
      await result.current.fetch()
    })
    expect(result.current.errorMessage).toBe('Fetch에 실패했습니다.')
  })

  it('prompts confirmAutoStageCommit when staged=0 with working changes, runs stageAll -> commit under single lock, and preserves staged state if commit fails', async () => {
    const baseStatus = makeStatus('main', 0)
    const unstagedOnlyStatus: GitStatus = {
      ...baseStatus,
      unstaged: [{ path: 'notes.md', status: 'M' }]
    }
    const stagedStatus: GitStatus = {
      ...baseStatus,
      staged: [{ path: 'notes.md', status: 'M' }]
    }
    const cleanCommittedStatus: GitStatus = {
      ...baseStatus,
      ahead: 1
    }

    const callOrder: string[] = []
    let resolveStageAll!: (status: GitStatus) => void
    const statusMock = vi.fn(async () => unstagedOnlyStatus)
    const stageAllMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GitStatus>((resolve) => {
            callOrder.push('stageAll')
            resolveStageAll = resolve
          })
      )
      .mockImplementationOnce(async () => {
        callOrder.push('stageAll-2')
        return stagedStatus
      })
      .mockRejectedValueOnce(new Error('stageAll failed'))

    const commitMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        callOrder.push('commit')
        return cleanCommittedStatus
      })
      .mockRejectedValueOnce(new Error('hook rejected commit'))

    let committed = false
    const logMock = vi.fn(async () => ({
      commits: committed ? [makeCommit('new222'), makeCommit('old111')] : [makeCommit('old111')],
      hasMore: false
    }))

    installMockGitWikiApi({
      status: statusMock,
      stageAll: stageAllMock,
      commit: commitMock,
      log: logMock
    })

    let autoStageApproved = false
    const confirmAutoStageCommit = vi.fn(async () => autoStageApproved)
    const activeTransitions: boolean[] = []

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmAutoStageCommit,
        onWorkspaceMutationActiveChange: (active) => activeTransitions.push(active)
      })
    )

    await waitFor(() => {
      expect(result.current.status?.unstaged).toHaveLength(1)
    })

    // 1. Canceled auto-stage confirmation aborts cleanly without touching git
    let firstResult!: boolean
    await act(async () => {
      firstResult = await result.current.commit('feat: first attempt', 'commit')
    })
    expect(firstResult).toBe(false)
    expect(confirmAutoStageCommit).toHaveBeenCalledTimes(1)
    expect(stageAllMock).not.toHaveBeenCalled()
    expect(commitMock).not.toHaveBeenCalled()
    expect(activeTransitions).toEqual([true, false])

    // 2. Approved auto-stage runs stageAll -> commit under a single mutation lock
    autoStageApproved = true
    let pendingCommit!: Promise<boolean>
    act(() => {
      pendingCommit = result.current.commit('feat: auto stage commit', 'commit')
    })

    await waitFor(() => {
      expect(result.current.pendingAction).toBe('전체 Stage')
    })

    // Concurrent FS watch refresh must be skipped while locked
    const statusCallsDuringLock = statusMock.mock.calls.length
    await act(async () => {
      await result.current.refreshStatus()
    })
    expect(statusMock.mock.calls.length).toBe(statusCallsDuringLock)

    committed = true
    let secondResult!: boolean
    await act(async () => {
      resolveStageAll(stagedStatus)
      secondResult = await pendingCommit
    })

    expect(secondResult).toBe(true)
    expect(callOrder).toEqual(['stageAll', 'commit'])
    expect(commitMock).toHaveBeenCalledWith('C:/wiki', 'feat: auto stage commit')
    expect(result.current.status?.ahead).toBe(1)
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['new222', 'old111'])
    expect(result.current.pendingAction).toBeNull()
    expect(result.current.errorMessage).toBeNull()

    // 3. Re-seed unstaged status: if stageAll succeeds and commit fails, staged status is preserved and returns false
    statusMock.mockResolvedValue(unstagedOnlyStatus)
    await act(async () => {
      await result.current.refreshStatus()
    })

    let thirdResult!: boolean
    await act(async () => {
      thirdResult = await result.current.commit('feat: failing commit', 'commit')
    })
    expect(thirdResult).toBe(false)
    expect(result.current.status?.staged).toEqual([{ path: 'notes.md', status: 'M' }])
    expect(result.current.status?.unstaged).toEqual([])
    expect(result.current.errorMessage).toBe('hook rejected commit')

    // 4. If stageAll itself fails, commit is skipped and error is reported
    statusMock.mockResolvedValue(unstagedOnlyStatus)
    await act(async () => {
      await result.current.refreshStatus()
    })

    const commitCallsBeforeStageFail = commitMock.mock.calls.length
    let fourthResult!: boolean
    await act(async () => {
      fourthResult = await result.current.commit('feat: failing stage', 'commit')
    })
    expect(fourthResult).toBe(false)
    expect(commitMock).toHaveBeenCalledTimes(commitCallsBeforeStageFail)
    expect(result.current.errorMessage).toBe('stageAll failed')
  })

  it('handles Commit & Push compound flow: returns true and reports only push error when commit succeeds and push fails', async () => {
    const unstagedStatus: GitStatus = {
      ...makeStatus('main', 0),
      unstaged: [{ path: 'guide.md', status: 'M' }]
    }
    const stagedStatus: GitStatus = {
      ...makeStatus('main', 0),
      staged: [{ path: 'guide.md', status: 'M' }]
    }
    const committedStatus: GitStatus = makeStatus('main', 1)
    const pushedStatus: GitStatus = makeStatus('main', 0)

    const callOrder: string[] = []
    let commitDone = false
    const stageAllMock = vi.fn(async () => {
      callOrder.push('stageAll')
      return stagedStatus
    })
    const commitMock = vi.fn(async () => {
      callOrder.push('commit')
      commitDone = true
      return committedStatus
    })
    const pushMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        callOrder.push('push-ok')
        return pushedStatus
      })
      .mockImplementationOnce(async () => {
        callOrder.push('push-fail')
        throw new Error('원격 Push가 거부되었습니다.')
      })

    installMockGitWikiApi({
      status: vi.fn(async () => (commitDone ? committedStatus : unstagedStatus)),
      stageAll: stageAllMock,
      commit: commitMock,
      push: pushMock,
      log: vi.fn(async () => ({
        commits: commitDone ? [makeCommit('commit111')] : [],
        hasMore: false
      }))
    })

    const confirmAutoStageCommit = vi.fn(async () => true)
    const confirmBeforeWorkspaceMutation = vi.fn(async () => true)

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmAutoStageCommit,
        confirmBeforeWorkspaceMutation
      })
    )

    await waitFor(() => {
      expect(result.current.status?.unstaged).toHaveLength(1)
    })

    // 1. Full Commit & Push succeeds without dirty workspace confirm
    let okResult!: boolean
    await act(async () => {
      okResult = await result.current.commit('feat: push combo', 'commit-push')
    })
    expect(okResult).toBe(true)
    expect(callOrder).toEqual(['stageAll', 'commit', 'push-ok'])
    expect(confirmBeforeWorkspaceMutation).not.toHaveBeenCalled()
    expect(result.current.status?.ahead).toBe(0)
    expect(result.current.errorMessage).toBeNull()

    // 2. Staged commit succeeds, push fails -> returns true (caller clears message), updates graph/status, shows push error only
    commitDone = false
    await act(async () => {
      await result.current.refreshStatus()
    })
    commitDone = true
    let partialResult!: boolean
    await act(async () => {
      partialResult = await result.current.commit('feat: local ok remote fail', 'commit-push')
    })
    expect(partialResult).toBe(true)
    expect(result.current.status?.ahead).toBe(1)
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['commit111'])
    expect(result.current.errorMessage).toBe('원격 Push가 거부되었습니다.')
  })

  it('handles Commit & Sync compound flow: honors dirty buffer confirm, aborts sync on cancel while keeping commit=true, and propagates sync errors/warnings', async () => {
    const stagedStatus: GitStatus = {
      ...makeStatus('main', 0),
      staged: [{ path: 'guide.md', status: 'M' }]
    }
    const committedStatus: GitStatus = makeStatus('main', 1)
    const syncedStatus: GitStatus = makeStatus('main', 0)

    let commitDone = false
    const commitMock = vi.fn(async () => {
      commitDone = true
      return committedStatus
    })
    const syncMock = vi
      .fn()
      .mockResolvedValueOnce({ status: syncedStatus, pulled: true, pushed: true, summary: '완료' })
      .mockRejectedValueOnce(new Error('원격 Sync 충돌 발생'))

    let confirmSyncDecision = false
    const confirmBeforeWorkspaceMutation = vi.fn(async () => confirmSyncDecision)
    const onWorkspaceMutated = vi.fn(async () => [] as string[])
    const confirmAutoStageCommit = vi.fn(async () => true)

    installMockGitWikiApi({
      status: vi.fn(async () => (commitDone ? committedStatus : stagedStatus)),
      commit: commitMock,
      sync: syncMock,
      log: vi.fn(async () => ({
        commits: commitDone ? [makeCommit('sync111')] : [],
        hasMore: false
      }))
    })

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmAutoStageCommit,
        confirmBeforeWorkspaceMutation,
        onWorkspaceMutated
      })
    )

    await waitFor(() => {
      expect(result.current.status?.staged).toHaveLength(1)
    })

    // 1. Commit succeeds, user cancels dirty buffer Sync confirmation -> returns true, sync NOT called, error banner set
    let cancelResult!: boolean
    await act(async () => {
      cancelResult = await result.current.commit('feat: commit then cancel sync', 'commit-sync')
    })
    expect(cancelResult).toBe(true)
    expect(confirmAutoStageCommit).not.toHaveBeenCalled()
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledWith('Sync')
    expect(syncMock).not.toHaveBeenCalled()
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(result.current.status?.ahead).toBe(1)
    expect(result.current.graphState.commits.map((c) => c.hash)).toEqual(['sync111'])
    expect(result.current.errorMessage).toMatch(/Sync/)

    // 2. Approved dirty buffer confirm -> sync runs & refreshes workspace buffers
    confirmSyncDecision = true
    commitDone = false
    await act(async () => {
      await result.current.refreshStatus()
    })
    let okResult!: boolean
    await act(async () => {
      okResult = await result.current.commit('feat: commit and sync ok', 'commit-sync')
    })
    expect(okResult).toBe(true)
    expect(syncMock).toHaveBeenCalledWith('C:/wiki')
    expect(onWorkspaceMutated).toHaveBeenCalledTimes(1)
    expect(result.current.status?.ahead).toBe(0)
    expect(result.current.errorMessage).toBeNull()

    // 3. Approved dirty buffer confirm, sync fails -> returns true, reports sync error, still reconciles workspace
    commitDone = false
    await act(async () => {
      await result.current.refreshStatus()
    })
    let failResult!: boolean
    await act(async () => {
      failResult = await result.current.commit('feat: commit ok sync fail', 'commit-sync')
    })
    expect(failResult).toBe(true)
    expect(onWorkspaceMutated).toHaveBeenCalledTimes(2)
    expect(result.current.errorMessage).toBe('원격 Sync 충돌 발생')
  })

  it('loads stashes, runs stashChanges with target-scoped confirm/sync & auto-expand, and runs stashApply/stashPop with full confirm & conflict preservation', async () => {
    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: '1111111111111111111111111111111111111111',
      branch: 'main',
      message: 'WIP on main: seed',
      createdAt: '2026-11-20T10:00:00+09:00'
    }
    const initialStatus: GitStatus = {
      ...makeStatus('main', 0),
      staged: [{ path: 'staged.md', status: 'A' }],
      unstaged: [{ path: 'dirty.md', status: 'M' }],
      untracked: [{ path: 'draft.md', status: '?' }]
    }
    const afterStashStatus: GitStatus = {
      ...makeStatus('main', 0),
      staged: [{ path: 'staged.md', status: 'A' }]
    }
    const afterApplyStatus: GitStatus = {
      ...afterStashStatus,
      unstaged: [{ path: 'dirty.md', status: 'M' }],
      untracked: [{ path: 'draft.md', status: '?' }]
    }
    const conflictStatus: GitStatus = {
      ...afterStashStatus,
      hasConflicts: true,
      unstaged: [{ path: 'dirty.md', status: 'U' }]
    }

    let currentStatus = initialStatus
    let currentStashes: GitStashEntry[] = []

    const stashListMock = vi.fn(async () => currentStashes)
    const stashCreateMock = vi.fn(async () => {
      currentStatus = afterStashStatus
      currentStashes = [stash0]
      return currentStatus
    })
    const stashApplyMock = vi.fn(async () => {
      currentStatus = afterApplyStatus
      return currentStatus
    })
    const stashPopMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        currentStatus = conflictStatus
        currentStashes = [stash0]
        throw new Error('병합 충돌(Conflict)이 발생했습니다.')
      })
      .mockImplementationOnce(async () => {
        currentStatus = afterApplyStatus
        currentStashes = []
        return currentStatus
      })
    const logMock = vi.fn(async () => ({ commits: [], hasMore: false }))

    installMockGitWikiApi({
      status: vi.fn(async () => currentStatus),
      log: logMock,
      stashList: stashListMock,
      stashCreate: stashCreateMock,
      stashApply: stashApplyMock,
      stashPop: stashPopMock
    })

    let confirmDecision = false
    const confirmBeforeWorkspaceMutation = vi.fn(async () => confirmDecision)
    const onBeforeWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onAfterWorkspaceBufferMutation = vi.fn(async () => undefined)
    const onWorkspaceMutated = vi.fn(async () => [])
    const onStashCreated = vi.fn()

    const { result, rerender } = renderHook(
      ({ ws }: { ws: string | null }) =>
        useGitController({
          workspaceRootPath: ws,
          confirmBeforeWorkspaceMutation,
          onBeforeWorkspaceBufferMutation,
          onAfterWorkspaceBufferMutation,
          onWorkspaceMutated,
          onStashCreated
        }),
      { initialProps: { ws: 'C:/wiki' as string | null } }
    )

    await waitFor(() => {
      expect(result.current.status?.unstaged).toHaveLength(1)
    })
    expect(result.current.stashes).toEqual([])
    const logCallsInitial = logMock.mock.calls.length

    // 1. Canceled confirmation aborts stashChanges cleanly without calling git or expanding
    await act(async () => {
      await result.current.stashChanges()
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledWith('Changes Stash', [
      'dirty.md',
      'draft.md'
    ])
    expect(stashCreateMock).not.toHaveBeenCalled()
    expect(onBeforeWorkspaceBufferMutation).not.toHaveBeenCalled()
    expect(onStashCreated).not.toHaveBeenCalled()

    // 2. Approved stashChanges creates stash, updates stashes, calls onStashCreated, and skips log refetch
    confirmDecision = true
    await act(async () => {
      await result.current.stashChanges()
    })
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledWith({
      kind: 'stash-create',
      paths: ['dirty.md', 'draft.md']
    })
    expect(stashCreateMock).toHaveBeenCalledWith('C:/wiki', {
      scope: 'unstaged',
      includeUntracked: true
    })
    expect(onAfterWorkspaceBufferMutation).toHaveBeenCalledWith(
      {
        kind: 'stash-create',
        paths: ['dirty.md', 'draft.md']
      },
      true,
      afterStashStatus
    )
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(onStashCreated).toHaveBeenCalledTimes(1)
    expect(result.current.stashes).toEqual([stash0])
    expect(result.current.status?.unstaged).toEqual([])
    expect(logMock).toHaveBeenCalledTimes(logCallsInitial)

    // 3. stashApply checks full workspace (undefined paths), reconciles via onWorkspaceMutated (not force-discard), and preserves stash entry
    await act(async () => {
      await result.current.stashApply('stash@{0}')
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenLastCalledWith('Stash Apply')
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledTimes(1)
    expect(stashApplyMock).toHaveBeenCalledWith('C:/wiki', 'stash@{0}')
    expect(onWorkspaceMutated).toHaveBeenLastCalledWith(afterApplyStatus)
    expect(result.current.stashes).toEqual([stash0])

    // 4. stashPop conflict refreshes fresh status & preserves stash list, reconciles with conflictStatus while keeping conflict error
    currentStatus = conflictStatus
    await act(async () => {
      await result.current.stashPop('stash@{0}')
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenLastCalledWith('Stash Pop')
    expect(result.current.errorMessage).toMatch(/충돌/)
    expect(result.current.stashes).toEqual([stash0])
    expect(onWorkspaceMutated).toHaveBeenLastCalledWith(conflictStatus)

    // 5. Clean stashPop clears stash list
    await act(async () => {
      await result.current.stashPop('stash@{0}')
    })
    expect(result.current.stashes).toEqual([])
    expect(logMock).toHaveBeenCalledTimes(logCallsInitial)

    // 6. Switching workspace clears stashes immediately
    currentStashes = [stash0]
    await act(async () => {
      await result.current.refreshStatus()
    })
    expect(result.current.stashes).toEqual([stash0])
    rerender({ ws: null })
    expect(result.current.stashes).toEqual([])
  })

  it('supports single-file stash, options-based stashCreate, stashDrop, and stashClear', async () => {
    const baseStatus = makeStatus('main')
    const initialStatus: GitStatus = {
      ...baseStatus,
      staged: [{ path: 'staged.md', status: 'M' }],
      unstaged: [{ path: 'target.md', status: 'M' }],
      untracked: [{ path: 'draft.md', status: '?' }]
    }
    const stash0: GitStashEntry = {
      ref: 'stash@{0}',
      hash: '1111111111111111111111111111111111111111',
      branch: 'main',
      message: 'target only',
      createdAt: '2026-11-20T12:00:00Z'
    }
    const stash1: GitStashEntry = {
      ref: 'stash@{1}',
      hash: '2222222222222222222222222222222222222222',
      branch: 'main',
      message: 'WIP release',
      createdAt: '2026-11-20T12:05:00Z'
    }

    let currentStatus = initialStatus
    let currentStashes: GitStashEntry[] = []
    const stashCreateMock = vi.fn(async () => {
      currentStashes = [...currentStashes, stash0]
      return currentStatus
    })
    const stashDropMock = vi.fn(async (_ws: string, stashRef: string) => {
      if (stashRef === 'stash@{99}') {
        throw new Error('지정한 Stash 항목을 찾을 수 없습니다.')
      }
      currentStashes = [
        {
          ...stash1,
          ref: 'stash@{0}'
        }
      ]
      return currentStashes
    })
    const stashClearMock = vi.fn(async () => {
      currentStashes = []
      return currentStashes
    })
    const statusMock = vi.fn(async () => currentStatus)

    installMockGitWikiApi({
      status: statusMock,
      stashList: vi.fn(async () => currentStashes),
      stashCreate: stashCreateMock,
      stashDrop: stashDropMock,
      stashClear: stashClearMock
    })

    const confirmBeforeWorkspaceMutation = vi.fn(async () => true)
    const onBeforeWorkspaceBufferMutation = vi.fn(async () => {})
    const onAfterWorkspaceBufferMutation = vi.fn(async () => {})
    const onStashCreated = vi.fn()

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmBeforeWorkspaceMutation,
        onBeforeWorkspaceBufferMutation,
        onAfterWorkspaceBufferMutation,
        onStashCreated
      })
    )

    await waitFor(() => {
      expect(result.current.status?.branch).toBe('main')
    })

    // 1. stashFile scopes dirty buffer check & stashCreate to the single target path
    currentStatus = {
      ...baseStatus,
      staged: initialStatus.staged,
      unstaged: [],
      untracked: initialStatus.untracked
    }
    await act(async () => {
      await expect(result.current.stashFile('target.md')).resolves.toBe(true)
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenLastCalledWith('파일 Stash', ['target.md'])
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenLastCalledWith({
      kind: 'stash-create',
      paths: ['target.md']
    })
    expect(stashCreateMock).toHaveBeenLastCalledWith('C:/wiki', {
      scope: 'paths',
      includeUntracked: true,
      paths: ['target.md']
    })
    expect(onStashCreated).toHaveBeenCalledTimes(1)
    expect(result.current.stashes).toEqual([stash0])

    // 2. stashWithOptions with scope: 'all' and includeUntracked: false excludes untracked paths from buffer target
    currentStatus = initialStatus
    await act(async () => {
      await result.current.refreshStatus()
    })
    currentStatus = {
      ...baseStatus,
      staged: [],
      unstaged: [],
      untracked: initialStatus.untracked
    }
    await act(async () => {
      await expect(
        result.current.stashWithOptions({
          scope: 'all',
          message: 'WIP release',
          includeUntracked: false
        })
      ).resolves.toBe(true)
    })
    expect(confirmBeforeWorkspaceMutation).toHaveBeenLastCalledWith('전체 변경 사항 Stash', [
      'staged.md',
      'target.md'
    ])
    expect(stashCreateMock).toHaveBeenLastCalledWith('C:/wiki', {
      scope: 'all',
      message: 'WIP release',
      includeUntracked: false
    })
    expect(onStashCreated).toHaveBeenCalledTimes(2)

    // 3. stashDrop skips buffer confirm/mutation hooks and updates stashes directly from return value
    const confirmCountBeforeDrop = confirmBeforeWorkspaceMutation.mock.calls.length
    const bufferBeforeCountBeforeDrop = onBeforeWorkspaceBufferMutation.mock.calls.length
    await act(async () => {
      await expect(result.current.stashDrop('stash@{0}')).resolves.toBe(true)
    })
    expect(stashDropMock).toHaveBeenCalledWith('C:/wiki', 'stash@{0}')
    expect(result.current.stashes).toEqual([{ ...stash1, ref: 'stash@{0}' }])
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledTimes(confirmCountBeforeDrop)
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledTimes(bufferBeforeCountBeforeDrop)

    // 4. stashDrop surfaces errors without triggering workspace buffer prompts
    await act(async () => {
      await expect(result.current.stashDrop('stash@{99}')).resolves.toBe(false)
    })
    expect(result.current.errorMessage).toBe('지정한 Stash 항목을 찾을 수 없습니다.')

    // 5. stashClear empties stashes and skips buffer confirm/mutation hooks
    await act(async () => {
      await expect(result.current.stashClear()).resolves.toBe(true)
    })
    expect(stashClearMock).toHaveBeenCalledWith('C:/wiki')
    expect(result.current.stashes).toEqual([])
    expect(confirmBeforeWorkspaceMutation).toHaveBeenCalledTimes(confirmCountBeforeDrop)
    expect(onBeforeWorkspaceBufferMutation).toHaveBeenCalledTimes(bufferBeforeCountBeforeDrop)
  })
})
