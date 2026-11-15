import { useCallback, useRef, useState } from 'react'
import {
  DEFAULT_GIT_LOG_LIMIT,
  type GitCommitDetail,
  type GitGraphCommit,
  type GitLogScope
} from '@shared/git'
import { logRendererError } from '../logging/rendererLogger'
import { toErrorMessage } from '@shared/errors'
import { useWikiApi } from './useWikiApi'

/** Discriminated union for the expanded commit detail panel in the Graph section. */
export type GitCommitDetailState =
  | { status: 'idle' }
  | { status: 'loading'; selectedHash: string }
  | { status: 'loaded'; selectedHash: string; detail: GitCommitDetail }
  | { status: 'error'; selectedHash: string; errorMessage: string }

/** Aggregated commit-graph UI state for the Graph accordion section. */
export interface GitGraphState {
  commits: readonly GitGraphCommit[]
  hasMore: boolean
  scope: GitLogScope
  isLoading: boolean
  isLoadingMore: boolean
  errorMessage: string | null
  commitDetail: GitCommitDetailState
}

/** Creates empty inline commit-detail state. */
export function createInitialGitCommitDetailState(): GitCommitDetailState {
  return { status: 'idle' }
}

/** Creates default commit-graph state starting in `'all'` scope. */
export function createInitialGitGraphState(): GitGraphState {
  return {
    commits: [],
    hasMore: false,
    scope: 'all',
    isLoading: false,
    isLoadingMore: false,
    errorMessage: null,
    commitDetail: createInitialGitCommitDetailState()
  }
}

interface UseGitGraphLogOptions {
  isCurrentRequest: (rootPath: string, epoch: number) => boolean
  getWorkspaceRootPath: () => string | null
  getWorkspaceEpoch: () => number
  isMounted: () => boolean
}

function appendUniqueCommits(
  existing: readonly GitGraphCommit[],
  incoming: readonly GitGraphCommit[]
): GitGraphCommit[] {
  const seenHashes = new Set(existing.map((commit) => commit.hash))
  const next = [...existing]
  for (const commit of incoming) {
    if (!seenHashes.has(commit.hash)) {
      seenHashes.add(commit.hash)
      next.push(commit)
    }
  }
  return next
}

/**
 * Manages Graph commit-history queries, `'all'`/`'current'` filtering,
 * pagination (`더 보기`), and stale-response cancellation.
 */
export function useGitGraphLog(options: UseGitGraphLogOptions) {
  const wikiApi = useWikiApi()
  const [graphState, setGraphState] = useState<GitGraphState>(createInitialGitGraphState)
  const graphStateRef = useRef<GitGraphState>(graphState)
  const logRequestSeqRef = useRef(0)
  const detailRequestSeqRef = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const updateGraphState = useCallback((updater: (prev: GitGraphState) => GitGraphState): void => {
    const next = updater(graphStateRef.current)
    graphStateRef.current = next
    setGraphState(next)
  }, [])

  const isCurrentLogRequest = useCallback(
    (rootPath: string, epoch: number, logSeq: number, scope: GitLogScope): boolean => {
      return (
        optionsRef.current.isCurrentRequest(rootPath, epoch) &&
        logRequestSeqRef.current === logSeq &&
        graphStateRef.current.scope === scope
      )
    },
    []
  )

  const resetGraph = useCallback(
    (resetScope: boolean, nextScope?: GitLogScope): void => {
      logRequestSeqRef.current += 1
      detailRequestSeqRef.current += 1
      updateGraphState((prev) => ({
        commits: [],
        hasMore: false,
        scope: resetScope ? 'all' : (nextScope ?? prev.scope),
        isLoading: false,
        isLoadingMore: false,
        errorMessage: null,
        commitDetail: createInitialGitCommitDetailState()
      }))
    },
    [updateGraphState]
  )

  const fetchCommitLog = useCallback(
    async (
      rootPath: string,
      epoch: number,
      scope: GitLogScope,
      append: boolean
    ): Promise<void> => {
      if (!optionsRef.current.isCurrentRequest(rootPath, epoch)) {
        return
      }

      const logSeq = ++logRequestSeqRef.current
      const skip = append ? graphStateRef.current.commits.length : 0

      updateGraphState((prev) => ({
        ...prev,
        isLoading: append ? prev.isLoading : true,
        isLoadingMore: append,
        errorMessage: null
      }))

      try {
        const result = await wikiApi.git.log(rootPath, {
          scope,
          limit: DEFAULT_GIT_LOG_LIMIT,
          skip
        })
        if (!isCurrentLogRequest(rootPath, epoch, logSeq, scope)) {
          return
        }

        updateGraphState((prev) => {
          const nextCommits = append
            ? appendUniqueCommits(prev.commits, result.commits)
            : result.commits
          const currentDetail = prev.commitDetail
          const shouldClearDetail =
            !append &&
            currentDetail.status !== 'idle' &&
            !nextCommits.some((commit) => commit.hash === currentDetail.selectedHash)
          if (shouldClearDetail) {
            detailRequestSeqRef.current += 1
          }
          return {
            ...prev,
            commits: nextCommits,
            hasMore: result.hasMore,
            commitDetail: shouldClearDetail
              ? createInitialGitCommitDetailState()
              : currentDetail
          }
        })
      } catch (error: unknown) {
        if (!isCurrentLogRequest(rootPath, epoch, logSeq, scope)) {
          return
        }
        const message = toErrorMessage(error, '커밋 히스토리를 불러오지 못했습니다.')
        updateGraphState((prev) => ({
          ...prev,
          errorMessage: message
        }))
        logRendererError('git', 'Git commit log fetch failed', {
          data: { workspaceRootPath: rootPath, scope, skip, errorMessage: message },
          error
        })
      } finally {
        if (optionsRef.current.isMounted() && logRequestSeqRef.current === logSeq) {
          updateGraphState((prev) => ({
            ...prev,
            isLoading: append ? prev.isLoading : false,
            isLoadingMore: append ? false : prev.isLoadingMore
          }))
        }
      }
    },
    [isCurrentLogRequest, updateGraphState, wikiApi]
  )

  const refreshGraph = useCallback(
    async (rootPath: string, epoch: number): Promise<void> => {
      await fetchCommitLog(rootPath, epoch, graphStateRef.current.scope, false)
    },
    [fetchCommitLog]
  )

  const changeLogScope = useCallback(
    async (nextScope: GitLogScope): Promise<void> => {
      if (graphStateRef.current.scope === nextScope) {
        return
      }
      resetGraph(false, nextScope)

      const rootPath = optionsRef.current.getWorkspaceRootPath()
      if (!rootPath) {
        return
      }
      await fetchCommitLog(rootPath, optionsRef.current.getWorkspaceEpoch(), nextScope, false)
    },
    [fetchCommitLog, resetGraph]
  )

  const loadMoreCommits = useCallback(async (): Promise<void> => {
    const rootPath = optionsRef.current.getWorkspaceRootPath()
    const current = graphStateRef.current
    if (!rootPath || current.isLoading || current.isLoadingMore || !current.hasMore) {
      return
    }
    await fetchCommitLog(
      rootPath,
      optionsRef.current.getWorkspaceEpoch(),
      current.scope,
      true
    )
  }, [fetchCommitLog])

  const toggleCommitDetail = useCallback(
    async (commitHash: string): Promise<void> => {
      const currentDetail = graphStateRef.current.commitDetail
      if (currentDetail.status !== 'idle' && currentDetail.selectedHash === commitHash) {
        detailRequestSeqRef.current += 1
        updateGraphState((prev) => ({
          ...prev,
          commitDetail: createInitialGitCommitDetailState()
        }))
        return
      }

      const rootPath = optionsRef.current.getWorkspaceRootPath()
      if (!rootPath) {
        return
      }
      const epoch = optionsRef.current.getWorkspaceEpoch()
      const detailSeq = ++detailRequestSeqRef.current
      const isCurrentDetailRequest = (): boolean => {
        const latestDetail = graphStateRef.current.commitDetail
        return (
          optionsRef.current.isCurrentRequest(rootPath, epoch) &&
          detailRequestSeqRef.current === detailSeq &&
          latestDetail.status !== 'idle' &&
          latestDetail.selectedHash === commitHash
        )
      }

      updateGraphState((prev) => ({
        ...prev,
        commitDetail: { status: 'loading', selectedHash: commitHash }
      }))

      try {
        const detail = await wikiApi.git.commitDetail(rootPath, commitHash)
        if (!isCurrentDetailRequest()) {
          return
        }
        updateGraphState((prev) => ({
          ...prev,
          commitDetail: { status: 'loaded', selectedHash: commitHash, detail }
        }))
      } catch (error: unknown) {
        if (!isCurrentDetailRequest()) {
          return
        }
        const message = toErrorMessage(error, '커밋 상세 정보를 불러오지 못했습니다.')
        updateGraphState((prev) => ({
          ...prev,
          commitDetail: { status: 'error', selectedHash: commitHash, errorMessage: message }
        }))
        logRendererError('git', 'Git commit detail fetch failed', {
          data: { workspaceRootPath: rootPath, commitHash, errorMessage: message },
          error
        })
      }
    },
    [updateGraphState, wikiApi]
  )

  return {
    graphState,
    resetGraph,
    refreshGraph,
    changeLogScope,
    loadMoreCommits,
    toggleCommitDetail
  }
}
