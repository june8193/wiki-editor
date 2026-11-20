import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_GIT_LOG_LIMIT,
  type GitCommitDetail,
  type GitGraphCommit,
  type GitLogScope
} from '@shared/git'
import { logRendererError } from '../logging/rendererLogger'
import { toErrorMessage } from '@shared/errors'
import {
  createInitialGitDetailState,
  type GitDetailState,
  useGitDetailSelection
} from './useGitDetailSelection'
import { useWikiApi } from './useWikiApi'

/** Discriminated union for the expanded commit detail panel in the Graph section. */
export type GitCommitDetailState = GitDetailState<GitCommitDetail>

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

type GitGraphLogState = Omit<GitGraphState, 'commitDetail'>

/** Creates empty inline commit-detail state. */
export function createInitialGitCommitDetailState(): GitCommitDetailState {
  return createInitialGitDetailState()
}

function createInitialGitGraphLogState(): GitGraphLogState {
  return {
    commits: [],
    hasMore: false,
    scope: 'all',
    isLoading: false,
    isLoadingMore: false,
    errorMessage: null
  }
}

/** Creates default commit-graph state starting in `'all'` scope. */
export function createInitialGitGraphState(): GitGraphState {
  return {
    ...createInitialGitGraphLogState(),
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
  const [graphLogState, setGraphLogState] = useState<GitGraphLogState>(createInitialGitGraphLogState)
  const graphLogStateRef = useRef<GitGraphLogState>(graphLogState)
  const logRequestSeqRef = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const updateGraphLogState = useCallback(
    (updater: (prev: GitGraphLogState) => GitGraphLogState): void => {
      const next = updater(graphLogStateRef.current)
      graphLogStateRef.current = next
      setGraphLogState(next)
    },
    []
  )

  const {
    detailState: commitDetail,
    toggleDetail: toggleCommitDetail,
    clearDetail: clearCommitDetail,
    pruneDetail: pruneCommitDetail
  } = useGitDetailSelection<string, GitCommitDetail>({
    isCurrentRequest: (rootPath, epoch) => optionsRef.current.isCurrentRequest(rootPath, epoch),
    getWorkspaceRootPath: () => optionsRef.current.getWorkspaceRootPath(),
    getWorkspaceEpoch: () => optionsRef.current.getWorkspaceEpoch(),
    getSelectedHash: (commitHash) => commitHash,
    fetchDetail: (rootPath, commitHash) => wikiApi.git.commitDetail(rootPath, commitHash),
    fallbackErrorMessage: '커밋 상세 정보를 불러오지 못했습니다.',
    logFailure: (rootPath, commitHash, errorMessage, error) => {
      logRendererError('git', 'Git commit detail fetch failed', {
        data: { workspaceRootPath: rootPath, commitHash, errorMessage },
        error
      })
    }
  })

  const isCurrentLogRequest = useCallback(
    (rootPath: string, epoch: number, logSeq: number, scope: GitLogScope): boolean => {
      return (
        optionsRef.current.isCurrentRequest(rootPath, epoch) &&
        logRequestSeqRef.current === logSeq &&
        graphLogStateRef.current.scope === scope
      )
    },
    []
  )

  const resetGraph = useCallback(
    (resetScope: boolean, nextScope?: GitLogScope): void => {
      logRequestSeqRef.current += 1
      clearCommitDetail()
      updateGraphLogState((prev) => ({
        commits: [],
        hasMore: false,
        scope: resetScope ? 'all' : (nextScope ?? prev.scope),
        isLoading: false,
        isLoadingMore: false,
        errorMessage: null
      }))
    },
    [clearCommitDetail, updateGraphLogState]
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
      const skip = append ? graphLogStateRef.current.commits.length : 0

      updateGraphLogState((prev) => ({
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

        const nextCommits = append
          ? appendUniqueCommits(graphLogStateRef.current.commits, result.commits)
          : result.commits
        if (!append) {
          pruneCommitDetail(new Set(nextCommits.map((commit) => commit.hash)))
        }
        updateGraphLogState((prev) => ({
          ...prev,
          commits: nextCommits,
          hasMore: result.hasMore
        }))
      } catch (error: unknown) {
        if (!isCurrentLogRequest(rootPath, epoch, logSeq, scope)) {
          return
        }
        const message = toErrorMessage(error, '커밋 히스토리를 불러오지 못했습니다.')
        updateGraphLogState((prev) => ({
          ...prev,
          errorMessage: message
        }))
        logRendererError('git', 'Git commit log fetch failed', {
          data: { workspaceRootPath: rootPath, scope, skip, errorMessage: message },
          error
        })
      } finally {
        if (optionsRef.current.isMounted() && logRequestSeqRef.current === logSeq) {
          updateGraphLogState((prev) => ({
            ...prev,
            isLoading: append ? prev.isLoading : false,
            isLoadingMore: append ? false : prev.isLoadingMore
          }))
        }
      }
    },
    [isCurrentLogRequest, pruneCommitDetail, updateGraphLogState, wikiApi]
  )

  const refreshGraph = useCallback(
    async (rootPath: string, epoch: number): Promise<void> => {
      await fetchCommitLog(rootPath, epoch, graphLogStateRef.current.scope, false)
    },
    [fetchCommitLog]
  )

  const changeLogScope = useCallback(
    async (nextScope: GitLogScope): Promise<void> => {
      if (graphLogStateRef.current.scope === nextScope) {
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
    const current = graphLogStateRef.current
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

  const graphState = useMemo<GitGraphState>(
    () => ({
      ...graphLogState,
      commitDetail
    }),
    [commitDetail, graphLogState]
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
