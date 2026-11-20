import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  createInitialGitDetailState,
  useGitDetailSelection
} from './useGitDetailSelection'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useGitDetailSelection', () => {
  it('loads detail on expand and collapses to idle when toggling the same item', async () => {
    const fetchDetail = vi.fn(async (_rootPath: string, item: { id: string }) => ({
      summary: `detail:${item.id}`
    }))
    const logFailure = vi.fn()

    const { result } = renderHook(() =>
      useGitDetailSelection<{ id: string }, { summary: string }>({
        isCurrentRequest: () => true,
        getWorkspaceRootPath: () => 'C:/wiki',
        getWorkspaceEpoch: () => 1,
        getSelectedHash: (item) => item.id,
        fetchDetail,
        fallbackErrorMessage: '상세 조회 실패',
        logFailure
      })
    )

    expect(result.current.detailState).toEqual(createInitialGitDetailState())

    await act(async () => {
      await result.current.toggleDetail({ id: 'hash-1' })
    })

    expect(fetchDetail).toHaveBeenCalledWith('C:/wiki', { id: 'hash-1' })
    expect(result.current.detailState).toEqual({
      status: 'loaded',
      selectedHash: 'hash-1',
      detail: { summary: 'detail:hash-1' }
    })

    await act(async () => {
      await result.current.toggleDetail({ id: 'hash-1' })
    })

    expect(result.current.detailState).toEqual({ status: 'idle' })
    expect(logFailure).not.toHaveBeenCalled()
  })

  it('ignores stale responses when selection switches, detail clears, or workspace becomes invalid', async () => {
    const first = createDeferred<{ summary: string }>()
    const second = createDeferred<{ summary: string }>()
    let activeRoot: string | null = 'C:/wiki'
    let activeEpoch = 1

    const fetchDetail = vi.fn((_rootPath: string, item: { id: string }) =>
      item.id === 'hash-1' ? first.promise : second.promise
    )

    const { result } = renderHook(() =>
      useGitDetailSelection<{ id: string }, { summary: string }>({
        isCurrentRequest: (rootPath, epoch) =>
          activeRoot === rootPath && activeEpoch === epoch,
        getWorkspaceRootPath: () => activeRoot,
        getWorkspaceEpoch: () => activeEpoch,
        getSelectedHash: (item) => item.id,
        fetchDetail,
        fallbackErrorMessage: '상세 조회 실패',
        logFailure: vi.fn()
      })
    )

    let firstPromise!: Promise<void>
    let secondPromise!: Promise<void>
    await act(async () => {
      firstPromise = result.current.toggleDetail({ id: 'hash-1' })
      secondPromise = result.current.toggleDetail({ id: 'hash-2' })
    })

    expect(result.current.detailState).toEqual({
      status: 'loading',
      selectedHash: 'hash-2'
    })

    await act(async () => {
      first.resolve({ summary: 'stale-1' })
      await firstPromise
    })
    expect(result.current.detailState).toEqual({
      status: 'loading',
      selectedHash: 'hash-2'
    })

    await act(async () => {
      second.resolve({ summary: 'fresh-2' })
      await secondPromise
    })
    expect(result.current.detailState).toEqual({
      status: 'loaded',
      selectedHash: 'hash-2',
      detail: { summary: 'fresh-2' }
    })

    const third = createDeferred<{ summary: string }>()
    fetchDetail.mockImplementationOnce(() => third.promise)
    let thirdPromise!: Promise<void>
    await act(async () => {
      thirdPromise = result.current.toggleDetail({ id: 'hash-3' })
    })
    expect(result.current.detailState).toEqual({ status: 'loading', selectedHash: 'hash-3' })

    await act(async () => {
      activeEpoch = 2
      result.current.clearDetail()
      third.reject(new Error('late error'))
      await thirdPromise
    })
    expect(result.current.detailState).toEqual({ status: 'idle' })
    activeRoot = null
  })

  it('records error state and failure log on rejection and prunes only missing hashes', async () => {
    const logFailure = vi.fn()
    const fetchDetail = vi
      .fn<(_rootPath: string, item: { id: string }) => Promise<{ summary: string }>>()
      .mockRejectedValueOnce(new Error('git failure'))
      .mockResolvedValueOnce({ summary: 'ok' })

    const { result } = renderHook(() =>
      useGitDetailSelection<{ id: string }, { summary: string }>({
        isCurrentRequest: () => true,
        getWorkspaceRootPath: () => 'C:/wiki',
        getWorkspaceEpoch: () => 1,
        getSelectedHash: (item) => item.id,
        fetchDetail,
        fallbackErrorMessage: '기본 실패 메시지',
        logFailure
      })
    )

    await act(async () => {
      await result.current.toggleDetail({ id: 'bad-hash' })
    })

    expect(result.current.detailState).toEqual({
      status: 'error',
      selectedHash: 'bad-hash',
      errorMessage: 'git failure'
    })
    expect(logFailure).toHaveBeenCalledWith(
      'C:/wiki',
      { id: 'bad-hash' },
      'git failure',
      expect.any(Error)
    )

    await act(async () => {
      await result.current.toggleDetail({ id: 'keep-hash' })
    })
    expect(result.current.detailState.status).toBe('loaded')

    await act(async () => {
      result.current.pruneDetail(new Set(['keep-hash', 'other-hash']))
    })
    expect(result.current.detailState.status).toBe('loaded')

    await act(async () => {
      result.current.pruneDetail(new Set(['other-hash']))
    })
    expect(result.current.detailState).toEqual({ status: 'idle' })
  })
})
