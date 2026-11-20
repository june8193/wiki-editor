import { useCallback, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'
import type { GitStashDetail } from '@shared/git'

/** Discriminated union for inline expandable detail panels (Commit or Stash). */
export type GitDetailState<TDetail> =
  | { status: 'idle' }
  | { status: 'loading'; selectedHash: string }
  | { status: 'loaded'; selectedHash: string; detail: TDetail }
  | { status: 'error'; selectedHash: string; errorMessage: string }

/** State alias for expanded inline Stash detail inside the Stashes accordion section. */
export type GitStashDetailState = GitDetailState<GitStashDetail>

/** Creates an empty collapsed inline detail state. */
export function createInitialGitDetailState<TDetail>(): GitDetailState<TDetail> {
  return { status: 'idle' }
}

/** Creates an empty collapsed inline Stash detail state. */
export function createInitialGitStashDetailState(): GitStashDetailState {
  return createInitialGitDetailState()
}

export interface UseGitDetailSelectionOptions<TTarget, TDetail> {
  isCurrentRequest: (rootPath: string, epoch: number) => boolean
  getWorkspaceRootPath: () => string | null
  getWorkspaceEpoch: () => number
  getSelectedHash: (target: TTarget) => string
  fetchDetail: (rootPath: string, target: TTarget) => Promise<TDetail>
  fallbackErrorMessage: string
  logFailure: (
    rootPath: string,
    target: TTarget,
    errorMessage: string,
    error: unknown
  ) => void
}

/**
 * Manages single-item inline detail expansion, stale-response cancellation,
 * collapsing, and pruning when backing entries disappear.
 */
export function useGitDetailSelection<TTarget, TDetail>(
  options: UseGitDetailSelectionOptions<TTarget, TDetail>
) {
  const [detailState, setDetailState] = useState<GitDetailState<TDetail>>(createInitialGitDetailState)
  const detailStateRef = useRef<GitDetailState<TDetail>>(detailState)
  const detailSeqRef = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const updateDetailState = useCallback((nextDetail: GitDetailState<TDetail>): void => {
    detailStateRef.current = nextDetail
    setDetailState(nextDetail)
  }, [])

  const clearDetail = useCallback((): void => {
    detailSeqRef.current += 1
    updateDetailState(createInitialGitDetailState())
  }, [updateDetailState])

  const pruneDetail = useCallback(
    (validHashes: ReadonlySet<string>): void => {
      const current = detailStateRef.current
      if (current.status !== 'idle' && !validHashes.has(current.selectedHash)) {
        clearDetail()
      }
    },
    [clearDetail]
  )

  const toggleDetail = useCallback(
    async (target: TTarget): Promise<void> => {
      const selectedHash = optionsRef.current.getSelectedHash(target)
      const currentDetail = detailStateRef.current
      if (currentDetail.status !== 'idle' && currentDetail.selectedHash === selectedHash) {
        clearDetail()
        return
      }

      const rootPath = optionsRef.current.getWorkspaceRootPath()
      if (!rootPath) {
        return
      }
      const epoch = optionsRef.current.getWorkspaceEpoch()
      const detailSeq = ++detailSeqRef.current
      const isCurrentDetailRequest = (): boolean => {
        const latestDetail = detailStateRef.current
        return (
          optionsRef.current.isCurrentRequest(rootPath, epoch) &&
          detailSeqRef.current === detailSeq &&
          latestDetail.status !== 'idle' &&
          latestDetail.selectedHash === selectedHash
        )
      }

      updateDetailState({ status: 'loading', selectedHash })

      try {
        const detail = await optionsRef.current.fetchDetail(rootPath, target)
        if (!isCurrentDetailRequest()) {
          return
        }
        updateDetailState({ status: 'loaded', selectedHash, detail })
      } catch (error: unknown) {
        if (!isCurrentDetailRequest()) {
          return
        }
        const message = toErrorMessage(error, optionsRef.current.fallbackErrorMessage)
        updateDetailState({ status: 'error', selectedHash, errorMessage: message })
        optionsRef.current.logFailure(rootPath, target, message, error)
      }
    },
    [clearDetail, updateDetailState]
  )

  return {
    detailState,
    toggleDetail,
    clearDetail,
    pruneDetail
  }
}
