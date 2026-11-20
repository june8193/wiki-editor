import { useCallback, useRef, useState } from 'react'
import { toErrorMessage } from '@shared/errors'

/** Discriminated union for inline expandable detail panels (Commit or Stash). */
export type GitDetailState<TDetail> =
  | { status: 'idle' }
  | { status: 'loading'; selectedHash: string }
  | { status: 'loaded'; selectedHash: string; detail: TDetail }
  | { status: 'error'; selectedHash: string; errorMessage: string }

/** Creates an empty collapsed inline detail state. */
export function createInitialGitDetailState<TDetail>(): GitDetailState<TDetail> {
  return { status: 'idle' }
}

/** Shared workspace-epoch guard for ignoring stale async Git responses across switches. */
export interface GitWorkspaceRequestGuard {
  isCurrentRequest: (rootPath: string, epoch: number) => boolean
  getWorkspaceRootPath: () => string | null
  getWorkspaceEpoch: () => number
}

export interface UseGitDetailSelectionOptions<TTarget, TDetail> {
  requestGuard: GitWorkspaceRequestGuard
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
      const { requestGuard, getSelectedHash, fetchDetail, fallbackErrorMessage, logFailure } =
        optionsRef.current
      const selectedHash = getSelectedHash(target)
      const currentDetail = detailStateRef.current
      if (currentDetail.status !== 'idle' && currentDetail.selectedHash === selectedHash) {
        clearDetail()
        return
      }

      const rootPath = requestGuard.getWorkspaceRootPath()
      if (!rootPath) {
        return
      }
      const epoch = requestGuard.getWorkspaceEpoch()
      const detailSeq = ++detailSeqRef.current
      const isCurrentDetailRequest = (): boolean => {
        const latestDetail = detailStateRef.current
        return (
          optionsRef.current.requestGuard.isCurrentRequest(rootPath, epoch) &&
          detailSeqRef.current === detailSeq &&
          latestDetail.status !== 'idle' &&
          latestDetail.selectedHash === selectedHash
        )
      }

      updateDetailState({ status: 'loading', selectedHash })

      try {
        const detail = await fetchDetail(rootPath, target)
        if (!isCurrentDetailRequest()) {
          return
        }
        updateDetailState({ status: 'loaded', selectedHash, detail })
      } catch (error: unknown) {
        if (!isCurrentDetailRequest()) {
          return
        }
        const message = toErrorMessage(error, fallbackErrorMessage)
        updateDetailState({ status: 'error', selectedHash, errorMessage: message })
        logFailure(rootPath, target, message, error)
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
