import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmptyGitStatus,
  type GitCommitDetail,
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
      commit: vi.fn(),
      branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
      checkout: vi.fn(),
      pull: vi.fn(),
      push: vi.fn(),
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
    const onBeforeWorkspaceDiscard = vi.fn(async () => undefined)
    const onAfterWorkspaceDiscard = vi.fn(async () => undefined)
    const onWorkspaceMutated = vi.fn(async () => [])
    const activeTransitions: boolean[] = []

    const { result } = renderHook(() =>
      useGitController({
        workspaceRootPath: 'C:/wiki',
        confirmBeforeWorkspaceMutation,
        onBeforeWorkspaceDiscard,
        onAfterWorkspaceDiscard,
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
    expect(onBeforeWorkspaceDiscard).not.toHaveBeenCalled()
    expect(discardMock).not.toHaveBeenCalled()
    expect(onAfterWorkspaceDiscard).not.toHaveBeenCalled()
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(activeTransitions).toEqual([true, false])

    // 2. Approved confirmation prepares, discards, updates status, and skips log refetch
    confirmDecision = true
    await act(async () => {
      await result.current.discardFile('notes.md')
    })
    expect(onBeforeWorkspaceDiscard).toHaveBeenCalledWith(['notes.md'])
    expect(discardMock).toHaveBeenCalledWith('C:/wiki', ['notes.md'])
    expect(onAfterWorkspaceDiscard).toHaveBeenCalledWith(['notes.md'], true)
    expect(onWorkspaceMutated).not.toHaveBeenCalled()
    expect(result.current.status?.unstaged).toEqual([])
    expect(logMock).toHaveBeenCalledTimes(logCallsBeforeDiscard)

    // 3. Failure releases discard lock with succeeded=false and reports error
    await act(async () => {
      await result.current.discardFile('notes.md')
    })
    expect(onAfterWorkspaceDiscard).toHaveBeenLastCalledWith(['notes.md'], false)
    expect(result.current.errorMessage).toBe('discard failed')
  })
})
