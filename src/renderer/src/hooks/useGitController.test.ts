import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus, type GitStatus } from '@shared/git'
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
        sync: vi.fn()
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
        sync: vi.fn()
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
        sync: vi.fn()
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
})
