import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_GIT_LOG_LIMIT,
  type GitBranchList,
  type GitGraphCommit,
  type GitLogScope,
  type GitStatus
} from '@shared/git'
import { logRendererError, logRendererWarn } from '../logging/rendererLogger'
import { toErrorMessage } from '../utils/toErrorMessage'

interface UseGitControllerOptions {
  workspaceRootPath: string | null
  confirmBeforeWorkspaceMutation?: (actionLabel: string) => Promise<boolean>
  onWorkspaceMutated?: () => Promise<readonly string[]>
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
 * Coordinates workspace Git status, branch queries, staging/committing, and remote operations.
 */
export function useGitController({
  workspaceRootPath,
  confirmBeforeWorkspaceMutation,
  onWorkspaceMutated
}: UseGitControllerOptions) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [logCommits, setLogCommits] = useState<readonly GitGraphCommit[]>([])
  const [logHasMore, setLogHasMore] = useState(false)
  const [logScope, setLogScope] = useState<GitLogScope>('all')
  const [isLogLoading, setIsLogLoading] = useState(false)
  const [isLogLoadingMore, setIsLogLoadingMore] = useState(false)
  const [logErrorMessage, setLogErrorMessage] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const activeWorkspaceRef = useRef<string | null>(workspaceRootPath)
  const workspaceEpochRef = useRef(0)
  const requestSeqRef = useRef(0)
  const logRequestSeqRef = useRef(0)
  const logScopeRef = useRef<GitLogScope>('all')
  const logCommitsRef = useRef<readonly GitGraphCommit[]>([])
  const logHasMoreRef = useRef(false)
  const isLogLoadingRef = useRef(false)
  const isLogLoadingMoreRef = useRef(false)
  const mutationTokenRef = useRef<number | null>(null)
  const mutationCounterRef = useRef(0)
  const callbacksRef = useRef({ confirmBeforeWorkspaceMutation, onWorkspaceMutated })

  activeWorkspaceRef.current = workspaceRootPath
  callbacksRef.current = { confirmBeforeWorkspaceMutation, onWorkspaceMutated }

  const isCurrentRequest = useCallback((rootPath: string, epoch: number): boolean => {
    return (
      mountedRef.current &&
      activeWorkspaceRef.current === rootPath &&
      workspaceEpochRef.current === epoch
    )
  }, [])

  const resetLogState = useCallback((resetScope: boolean): void => {
    logRequestSeqRef.current += 1
    logCommitsRef.current = []
    logHasMoreRef.current = false
    isLogLoadingRef.current = false
    isLogLoadingMoreRef.current = false
    if (resetScope) {
      logScopeRef.current = 'all'
      setLogScope('all')
    }
    setLogCommits([])
    setLogHasMore(false)
    setIsLogLoading(false)
    setIsLogLoadingMore(false)
    setLogErrorMessage(null)
  }, [])

  const fetchCommitLog = useCallback(
    async (
      rootPath: string,
      epoch: number,
      scope: GitLogScope,
      append: boolean
    ): Promise<void> => {
      if (!isCurrentRequest(rootPath, epoch)) {
        return
      }

      const logSeq = ++logRequestSeqRef.current
      const skip = append ? logCommitsRef.current.length : 0

      if (append) {
        isLogLoadingMoreRef.current = true
        setIsLogLoadingMore(true)
      } else {
        isLogLoadingMoreRef.current = false
        isLogLoadingRef.current = true
        setIsLogLoadingMore(false)
        setIsLogLoading(true)
      }
      setLogErrorMessage(null)

      try {
        const result = await window.wikiApi.git.log(rootPath, {
          scope,
          limit: DEFAULT_GIT_LOG_LIMIT,
          skip
        })
        if (
          !isCurrentRequest(rootPath, epoch) ||
          logRequestSeqRef.current !== logSeq ||
          logScopeRef.current !== scope
        ) {
          return
        }

        const nextCommits = append
          ? appendUniqueCommits(logCommitsRef.current, result.commits)
          : result.commits
        logCommitsRef.current = nextCommits
        logHasMoreRef.current = result.hasMore
        setLogCommits(nextCommits)
        setLogHasMore(result.hasMore)
      } catch (error: unknown) {
        if (
          !isCurrentRequest(rootPath, epoch) ||
          logRequestSeqRef.current !== logSeq ||
          logScopeRef.current !== scope
        ) {
          return
        }
        const message = toErrorMessage(error, '커밋 히스토리를 불러오지 못했습니다.')
        setLogErrorMessage(message)
        logRendererError('git', 'Git commit log fetch failed', {
          data: { workspaceRootPath: rootPath, scope, skip, errorMessage: message },
          error
        })
      } finally {
        if (mountedRef.current && logRequestSeqRef.current === logSeq) {
          if (append) {
            isLogLoadingMoreRef.current = false
            setIsLogLoadingMore(false)
          } else {
            isLogLoadingRef.current = false
            setIsLogLoading(false)
          }
        }
      }
    },
    [isCurrentRequest]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const applyWorkspaceGitState = useCallback(
    async (
      rootPath: string,
      epoch: number,
      nextStatus: GitStatus,
      fetchRepoMetadata: boolean
    ): Promise<void> => {
      if (!isCurrentRequest(rootPath, epoch)) {
        return
      }
      const applySeq = ++requestSeqRef.current
      setStatus(nextStatus)

      if (!nextStatus.isRepo) {
        setBranchList(null)
        resetLogState(false)
        return
      }
      if (!fetchRepoMetadata) return

      const branchesTask = window.wikiApi.git
        .branches(rootPath)
        .then((nextBranches) => {
          if (!isCurrentRequest(rootPath, epoch) || requestSeqRef.current !== applySeq) {
            return
          }
          setBranchList(nextBranches)
        })
        .catch(() => {
          // Branch lookup failures are non-fatal if status succeeded cleanly
        })

      const logTask = fetchCommitLog(rootPath, epoch, logScopeRef.current, false)
      await Promise.all([branchesTask, logTask])
    },
    [fetchCommitLog, isCurrentRequest, resetLogState]
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    const rootPath = activeWorkspaceRef.current
    if (!rootPath) {
      setStatus(null)
      setBranchList(null)
      setErrorMessage(null)
      resetLogState(false)
      return
    }
    // Active mutations fetch fresh Git state when done; skip concurrent FS watch refreshes while locked
    if (mutationTokenRef.current !== null) {
      return
    }

    const epoch = workspaceEpochRef.current
    const refreshSeq = ++requestSeqRef.current
    try {
      const nextStatus = await window.wikiApi.git.status(rootPath)
      if (
        mutationTokenRef.current !== null ||
        !isCurrentRequest(rootPath, epoch) ||
        requestSeqRef.current !== refreshSeq
      ) {
        return
      }
      await applyWorkspaceGitState(rootPath, epoch, nextStatus, true)
    } catch (error: unknown) {
      if (!isCurrentRequest(rootPath, epoch)) {
        return
      }
      const message = toErrorMessage(error, 'Git 상태를 불러오지 못했습니다.')
      setErrorMessage(message)
      logRendererError('git', 'Git status refresh failed', {
        data: { workspaceRootPath: rootPath, errorMessage: message },
        error
      })
    }
  }, [applyWorkspaceGitState, isCurrentRequest, resetLogState])

  useEffect(() => {
    workspaceEpochRef.current += 1
    mutationTokenRef.current = null
    setErrorMessage(null)
    setStatus(null)
    setBranchList(null)
    setPendingAction(null)
    resetLogState(true)

    if (workspaceRootPath) {
      void refreshStatus()
    }
  }, [refreshStatus, resetLogState, workspaceRootPath])

  const runGitAction = useCallback(
    async (
      actionLabel: string,
      options: {
        affectsWorkspaceFiles?: boolean
        fetchBranches?: boolean
        fallbackError: string
        run: (rootPath: string) => Promise<GitStatus>
      }
    ): Promise<boolean> => {
      const rootPath = activeWorkspaceRef.current
      if (!rootPath || mutationTokenRef.current !== null) return false

      const epoch = workspaceEpochRef.current
      const token = ++mutationCounterRef.current
      mutationTokenRef.current = token
      setErrorMessage(null)

      try {
        if (options.affectsWorkspaceFiles && callbacksRef.current.confirmBeforeWorkspaceMutation) {
          const confirmed = await callbacksRef.current.confirmBeforeWorkspaceMutation(actionLabel)
          if (!confirmed || !isCurrentRequest(rootPath, epoch)) {
            return false
          }
        }

        if (mountedRef.current) {
          setPendingAction(actionLabel)
        }

        const nextStatus = await options.run(rootPath)
        await applyWorkspaceGitState(rootPath, epoch, nextStatus, options.fetchBranches ?? false)

        if (
          options.affectsWorkspaceFiles &&
          isCurrentRequest(rootPath, epoch) &&
          callbacksRef.current.onWorkspaceMutated
        ) {
          const warnings = await callbacksRef.current.onWorkspaceMutated()
          if (isCurrentRequest(rootPath, epoch) && warnings.length > 0) {
            const message = warnings.join(' ')
            setErrorMessage(message)
            logRendererWarn('git', 'Git workspace mutation completed with warnings', {
              data: { action: actionLabel, workspaceRootPath: rootPath, warningMessage: message }
            })
          }
        }

        return true
      } catch (error: unknown) {
        if (isCurrentRequest(rootPath, epoch)) {
          const message = toErrorMessage(error, options.fallbackError)
          setErrorMessage(message)
          logRendererError('git', 'Git action failed', {
            data: { action: actionLabel, workspaceRootPath: rootPath, errorMessage: message },
            error
          })
          if (options.affectsWorkspaceFiles) {
            await window.wikiApi.git
              .status(rootPath)
              .then((fresh) => applyWorkspaceGitState(rootPath, epoch, fresh, true))
              .catch(() => undefined)
            await callbacksRef.current.onWorkspaceMutated?.().catch(() => [])
          }
        }
        return false
      } finally {
        if (mutationTokenRef.current === token) {
          mutationTokenRef.current = null
          if (mountedRef.current) {
            setPendingAction(null)
          }
        }
      }
    },
    [applyWorkspaceGitState, isCurrentRequest]
  )

  const initRepo = useCallback(async (): Promise<void> => {
    await runGitAction('Git 초기화', {
      fetchBranches: true,
      fallbackError: 'Git 저장소를 초기화하지 못했습니다.',
      run: (rootPath) => window.wikiApi.git.init(rootPath)
    })
  }, [runGitAction])

  const stageFile = useCallback(
    async (filePath: string): Promise<void> => {
      await runGitAction('Stage', {
        fallbackError: '파일을 Stage하지 못했습니다.',
        run: (rootPath) => window.wikiApi.git.stage(rootPath, [filePath])
      })
    },
    [runGitAction]
  )

  const stageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Stage', {
      fallbackError: '전체 파일을 Stage하지 못했습니다.',
      run: (rootPath) => window.wikiApi.git.stageAll(rootPath)
    })
  }, [runGitAction])

  const unstageFile = useCallback(
    async (filePath: string, origPath?: string): Promise<void> => {
      const targets = origPath ? [filePath, origPath] : [filePath]
      await runGitAction('Unstage', {
        fallbackError: '파일을 Unstage하지 못했습니다.',
        run: (rootPath) => window.wikiApi.git.unstage(rootPath, targets)
      })
    },
    [runGitAction]
  )

  const unstageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Unstage', {
      fallbackError: '전체 파일을 Unstage하지 못했습니다.',
      run: (rootPath) => window.wikiApi.git.unstageAll(rootPath)
    })
  }, [runGitAction])

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      return runGitAction('Commit', {
        fetchBranches: true,
        fallbackError: '커밋에 실패했습니다.',
        run: (rootPath) => window.wikiApi.git.commit(rootPath, message)
      })
    },
    [runGitAction]
  )

  const checkoutBranch = useCallback(
    async (branchName: string): Promise<void> => {
      await runGitAction('브랜치 전환', {
        affectsWorkspaceFiles: true,
        fetchBranches: true,
        fallbackError: '브랜치를 전환하지 못했습니다.',
        run: (rootPath) => window.wikiApi.git.checkout(rootPath, branchName)
      })
    },
    [runGitAction]
  )

  const pull = useCallback(async (): Promise<void> => {
    await runGitAction('Pull', {
      affectsWorkspaceFiles: true,
      fetchBranches: true,
      fallbackError: 'Pull에 실패했습니다.',
      run: (rootPath) => window.wikiApi.git.pull(rootPath)
    })
  }, [runGitAction])

  const push = useCallback(async (): Promise<void> => {
    await runGitAction('Push', {
      fetchBranches: true,
      fallbackError: 'Push에 실패했습니다.',
      run: (rootPath) => window.wikiApi.git.push(rootPath)
    })
  }, [runGitAction])

  const sync = useCallback(async (): Promise<void> => {
    await runGitAction('Sync', {
      affectsWorkspaceFiles: true,
      fetchBranches: true,
      fallbackError: 'Sync에 실패했습니다.',
      run: async (rootPath) => (await window.wikiApi.git.sync(rootPath)).status
    })
  }, [runGitAction])

  const changeLogScope = useCallback(
    async (nextScope: GitLogScope): Promise<void> => {
      if (logScopeRef.current === nextScope) {
        return
      }
      logScopeRef.current = nextScope
      setLogScope(nextScope)
      resetLogState(false)

      const rootPath = activeWorkspaceRef.current
      if (!rootPath) {
        return
      }
      await fetchCommitLog(rootPath, workspaceEpochRef.current, nextScope, false)
    },
    [fetchCommitLog, resetLogState]
  )

  const loadMoreCommits = useCallback(async (): Promise<void> => {
    const rootPath = activeWorkspaceRef.current
    if (
      !rootPath ||
      isLogLoadingRef.current ||
      isLogLoadingMoreRef.current ||
      !logHasMoreRef.current
    ) {
      return
    }
    await fetchCommitLog(rootPath, workspaceEpochRef.current, logScopeRef.current, true)
  }, [fetchCommitLog])

  const dismissError = useCallback((): void => {
    setErrorMessage(null)
  }, [])

  return {
    status,
    branchList,
    logCommits,
    logHasMore,
    logScope,
    isLogLoading,
    isLogLoadingMore,
    logErrorMessage,
    pendingAction,
    errorMessage,
    dismissError,
    refreshStatus,
    changeLogScope,
    loadMoreCommits,
    initRepo,
    stageFile,
    stageAll,
    unstageFile,
    unstageAll,
    commit,
    checkoutBranch,
    pull,
    push,
    sync
  }
}
