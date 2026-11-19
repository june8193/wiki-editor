import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranchList, GitStatus } from '@shared/git'
import { logRendererError, logRendererWarn } from '../logging/rendererLogger'
import { toErrorMessage } from '@shared/errors'
import { getGitPrimaryActionState, type GitCommitActionMode } from '../utils/gitPrimaryAction'
import { useGitGraphLog } from './useGitGraphLog'
import { useWikiApi } from './useWikiApi'

export interface WorkspaceDiscardTarget {
  scope: 'all' | 'paths'
  paths: readonly string[]
}

interface UseGitControllerOptions {
  workspaceRootPath: string | null
  confirmAutoStageCommit?: () => Promise<boolean>
  confirmBeforeWorkspaceMutation?: (
    actionLabel: string,
    targetRepoPaths?: readonly string[]
  ) => Promise<boolean>
  onBeforeWorkspaceDiscard?: (target: WorkspaceDiscardTarget) => Promise<void>
  onAfterWorkspaceDiscard?: (
    target: WorkspaceDiscardTarget,
    succeeded: boolean
  ) => Promise<void>
  onWorkspaceMutated?: () => Promise<readonly string[]>
  onWorkspaceMutationActiveChange?: (active: boolean) => void
}

/**
 * Coordinates workspace Git status, branch queries, staging/committing, and remote operations.
 */
export function useGitController({
  workspaceRootPath,
  confirmAutoStageCommit,
  confirmBeforeWorkspaceMutation,
  onBeforeWorkspaceDiscard,
  onAfterWorkspaceDiscard,
  onWorkspaceMutated,
  onWorkspaceMutationActiveChange
}: UseGitControllerOptions) {
  const wikiApi = useWikiApi()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const activeWorkspaceRef = useRef<string | null>(workspaceRootPath)
  const statusRef = useRef<GitStatus | null>(status)
  statusRef.current = status
  const workspaceEpochRef = useRef(0)
  const requestSeqRef = useRef(0)
  const mutationTokenRef = useRef<number | null>(null)
  const mutationCounterRef = useRef(0)
  const callbacksRef = useRef({
    confirmAutoStageCommit,
    confirmBeforeWorkspaceMutation,
    onBeforeWorkspaceDiscard,
    onAfterWorkspaceDiscard,
    onWorkspaceMutated,
    onWorkspaceMutationActiveChange
  })

  activeWorkspaceRef.current = workspaceRootPath
  callbacksRef.current = {
    confirmAutoStageCommit,
    confirmBeforeWorkspaceMutation,
    onBeforeWorkspaceDiscard,
    onAfterWorkspaceDiscard,
    onWorkspaceMutated,
    onWorkspaceMutationActiveChange
  }

  const isCurrentRequest = useCallback((rootPath: string, epoch: number): boolean => {
    return (
      mountedRef.current &&
      activeWorkspaceRef.current === rootPath &&
      workspaceEpochRef.current === epoch
    )
  }, [])

  const {
    graphState,
    resetGraph,
    refreshGraph,
    changeLogScope,
    loadMoreCommits,
    toggleCommitDetail
  } = useGitGraphLog({
    isCurrentRequest,
    getWorkspaceRootPath: () => activeWorkspaceRef.current,
    getWorkspaceEpoch: () => workspaceEpochRef.current,
    isMounted: () => mountedRef.current
  })

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
      statusRef.current = nextStatus
      setStatus(nextStatus)

      if (!nextStatus.isRepo) {
        setBranchList(null)
        resetGraph(false)
        return
      }
      if (!fetchRepoMetadata) return

      const branchesTask = wikiApi.git
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

      await Promise.all([branchesTask, refreshGraph(rootPath, epoch)])
    },
    [isCurrentRequest, refreshGraph, resetGraph, wikiApi]
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    const rootPath = activeWorkspaceRef.current
    if (!rootPath) {
      setStatus(null)
      setBranchList(null)
      setErrorMessage(null)
      resetGraph(false)
      return
    }
    // Active mutations fetch fresh Git state when done; skip concurrent FS watch refreshes while locked
    if (mutationTokenRef.current !== null) {
      return
    }

    const epoch = workspaceEpochRef.current
    const refreshSeq = ++requestSeqRef.current
    try {
      const nextStatus = await wikiApi.git.status(rootPath)
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
  }, [applyWorkspaceGitState, isCurrentRequest, resetGraph, wikiApi])

  useEffect(() => {
    const wasMutating = mutationTokenRef.current !== null
    workspaceEpochRef.current += 1
    mutationTokenRef.current = null
    if (wasMutating) {
      callbacksRef.current.onWorkspaceMutationActiveChange?.(false)
    }
    setErrorMessage(null)
    statusRef.current = null
    setStatus(null)
    setBranchList(null)
    setPendingAction(null)
    resetGraph(true)

    if (workspaceRootPath) {
      void refreshStatus()
    }
  }, [refreshStatus, resetGraph, workspaceRootPath])

  const reportGitActionError = useCallback(
    (
      rootPath: string,
      epoch: number,
      actionLabel: string,
      error: unknown,
      fallbackError: string
    ): void => {
      if (!isCurrentRequest(rootPath, epoch)) return
      const message = toErrorMessage(error, fallbackError)
      setErrorMessage(message)
      logRendererError('git', 'Git action failed', {
        data: { action: actionLabel, workspaceRootPath: rootPath, errorMessage: message },
        error
      })
    },
    [isCurrentRequest]
  )

  const applyWorkspaceMutationWarnings = useCallback(
    async (rootPath: string, epoch: number, actionLabel: string): Promise<void> => {
      const warnings = (await callbacksRef.current.onWorkspaceMutated?.()) ?? []
      if (warnings.length > 0 && isCurrentRequest(rootPath, epoch)) {
        const message = warnings.join(' ')
        setErrorMessage(message)
        logRendererWarn('git', 'Git workspace mutation completed with warnings', {
          data: { action: actionLabel, workspaceRootPath: rootPath, warningMessage: message }
        })
      }
    },
    [isCurrentRequest]
  )

  const withMutationLock = useCallback(
    async (run: (ctx: { rootPath: string; epoch: number }) => Promise<boolean>): Promise<boolean> => {
      const rootPath = activeWorkspaceRef.current
      if (!rootPath || mutationTokenRef.current !== null) return false

      const epoch = workspaceEpochRef.current
      const token = ++mutationCounterRef.current
      mutationTokenRef.current = token
      callbacksRef.current.onWorkspaceMutationActiveChange?.(true)
      setErrorMessage(null)

      try {
        return await run({ rootPath, epoch })
      } finally {
        if (mutationTokenRef.current === token) {
          mutationTokenRef.current = null
          callbacksRef.current.onWorkspaceMutationActiveChange?.(false)
          if (mountedRef.current) {
            setPendingAction(null)
          }
        }
      }
    },
    []
  )

  const runGitAction = useCallback(
    async (
      actionLabel: string,
      options: {
        affectsWorkspaceFiles?: boolean
        fetchRepoMetadata?: boolean
        discardTarget?: WorkspaceDiscardTarget
        fallbackError: string
        run: (rootPath: string) => Promise<GitStatus>
      }
    ): Promise<boolean> => {
      return withMutationLock(async ({ rootPath, epoch }) => {
        let preparedDiscard = false
        let workspaceEffectsCompleted = false

        const completeWorkspaceEffects = async (succeeded: boolean): Promise<void> => {
          if (!options.affectsWorkspaceFiles || workspaceEffectsCompleted) return
          workspaceEffectsCompleted = true
          if (options.discardTarget) {
            if (succeeded || preparedDiscard) {
              await callbacksRef.current.onAfterWorkspaceDiscard?.(options.discardTarget, succeeded)
            }
            return
          }
          if (succeeded) {
            await applyWorkspaceMutationWarnings(rootPath, epoch, actionLabel)
          } else {
            await callbacksRef.current.onWorkspaceMutated?.()
          }
        }

        try {
          if (options.affectsWorkspaceFiles && callbacksRef.current.confirmBeforeWorkspaceMutation) {
            const confirmed = await callbacksRef.current.confirmBeforeWorkspaceMutation(
              actionLabel,
              options.discardTarget?.paths
            )
            if (!confirmed || !isCurrentRequest(rootPath, epoch)) {
              return false
            }
          }

          if (mountedRef.current) {
            setPendingAction(actionLabel)
          }

          if (options.discardTarget && callbacksRef.current.onBeforeWorkspaceDiscard) {
            preparedDiscard = true
            await callbacksRef.current.onBeforeWorkspaceDiscard(options.discardTarget)
            if (!isCurrentRequest(rootPath, epoch)) {
              return false
            }
          }

          const nextStatus = await options.run(rootPath)
          await applyWorkspaceGitState(
            rootPath,
            epoch,
            nextStatus,
            options.fetchRepoMetadata ?? false
          )

          if (isCurrentRequest(rootPath, epoch)) {
            await completeWorkspaceEffects(true)
          }

          return true
        } catch (error: unknown) {
          reportGitActionError(rootPath, epoch, actionLabel, error, options.fallbackError)
          if (isCurrentRequest(rootPath, epoch) && options.affectsWorkspaceFiles) {
            await wikiApi.git
              .status(rootPath)
              .then((fresh) => applyWorkspaceGitState(rootPath, epoch, fresh, true))
              .catch(() => undefined)
            await completeWorkspaceEffects(false).catch(() => undefined)
          }
          return false
        } finally {
          if (preparedDiscard && !workspaceEffectsCompleted) {
            await completeWorkspaceEffects(false).catch(() => undefined)
          }
        }
      })
    },
    [
      applyWorkspaceGitState,
      applyWorkspaceMutationWarnings,
      isCurrentRequest,
      reportGitActionError,
      wikiApi,
      withMutationLock
    ]
  )

  const executePostCommitRemoteStep = useCallback(
    async (
      rootPath: string,
      epoch: number,
      mode: GitCommitActionMode,
      committedStatus: GitStatus
    ): Promise<void> => {
      if (mode === 'commit') {
        await applyWorkspaceGitState(rootPath, epoch, committedStatus, true)
        return
      }

      if (mode === 'commit-push') {
        if (mountedRef.current) {
          setPendingAction('Push')
        }
        try {
          const pushedStatus = await wikiApi.git.push(rootPath)
          await applyWorkspaceGitState(rootPath, epoch, pushedStatus, true)
        } catch (error: unknown) {
          reportGitActionError(rootPath, epoch, 'Push', error, 'Push에 실패했습니다.')
          await applyWorkspaceGitState(rootPath, epoch, committedStatus, true)
        }
        return
      }

      if (callbacksRef.current.confirmBeforeWorkspaceMutation) {
        if (mountedRef.current) {
          setPendingAction(null)
        }
        const confirmed = await callbacksRef.current.confirmBeforeWorkspaceMutation('Sync')
        if (!isCurrentRequest(rootPath, epoch)) {
          return
        }
        if (!confirmed) {
          setErrorMessage('미저장 문서 확인이 취소되어 Sync를 실행하지 않았습니다.')
          await applyWorkspaceGitState(rootPath, epoch, committedStatus, true)
          return
        }
      }

      if (mountedRef.current) {
        setPendingAction('Sync')
      }
      try {
        const syncResult = await wikiApi.git.sync(rootPath)
        await applyWorkspaceGitState(rootPath, epoch, syncResult.status, true)
        if (isCurrentRequest(rootPath, epoch)) {
          await applyWorkspaceMutationWarnings(rootPath, epoch, 'Sync')
        }
      } catch (error: unknown) {
        reportGitActionError(rootPath, epoch, 'Sync', error, 'Sync에 실패했습니다.')
        if (isCurrentRequest(rootPath, epoch)) {
          await wikiApi.git
            .status(rootPath)
            .then((fresh) => applyWorkspaceGitState(rootPath, epoch, fresh, true))
            .catch(() => applyWorkspaceGitState(rootPath, epoch, committedStatus, true))
          await callbacksRef.current.onWorkspaceMutated?.().catch(() => undefined)
        }
      }
    },
    [
      applyWorkspaceGitState,
      applyWorkspaceMutationWarnings,
      isCurrentRequest,
      reportGitActionError,
      wikiApi
    ]
  )

  const initRepo = useCallback(async (): Promise<void> => {
    await runGitAction('Git 초기화', {
      fetchRepoMetadata: true,
      fallbackError: 'Git 저장소를 초기화하지 못했습니다.',
      run: (rootPath) => wikiApi.git.init(rootPath)
    })
  }, [runGitAction, wikiApi])

  const stageFile = useCallback(
    async (filePath: string): Promise<void> => {
      await runGitAction('Stage', {
        fallbackError: '파일을 Stage하지 못했습니다.',
        run: (rootPath) => wikiApi.git.stage(rootPath, [filePath])
      })
    },
    [runGitAction, wikiApi]
  )

  const stageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Stage', {
      fallbackError: '전체 파일을 Stage하지 못했습니다.',
      run: (rootPath) => wikiApi.git.stageAll(rootPath)
    })
  }, [runGitAction, wikiApi])

  const unstageFile = useCallback(
    async (filePath: string, origPath?: string): Promise<void> => {
      const targets = origPath ? [filePath, origPath] : [filePath]
      await runGitAction('Unstage', {
        fallbackError: '파일을 Unstage하지 못했습니다.',
        run: (rootPath) => wikiApi.git.unstage(rootPath, targets)
      })
    },
    [runGitAction, wikiApi]
  )

  const unstageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Unstage', {
      fallbackError: '전체 파일을 Unstage하지 못했습니다.',
      run: (rootPath) => wikiApi.git.unstageAll(rootPath)
    })
  }, [runGitAction, wikiApi])

  const discardFile = useCallback(
    async (filePath: string): Promise<void> => {
      await runGitAction('변경 사항 롤백', {
        affectsWorkspaceFiles: true,
        fetchRepoMetadata: false,
        discardTarget: { scope: 'paths', paths: [filePath] },
        fallbackError: '변경 사항을 롤백하지 못했습니다.',
        run: (rootPath) => wikiApi.git.discard(rootPath, [filePath])
      })
    },
    [runGitAction, wikiApi]
  )

  const discardAll = useCallback(async (): Promise<void> => {
    const current = statusRef.current
    const paths = current
      ? [
          ...new Set([
            ...current.unstaged.map((item) => item.path),
            ...current.untracked.map((item) => item.path)
          ])
        ]
      : []
    await runGitAction('전체 변경 사항 롤백', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: false,
      discardTarget: { scope: 'all', paths },
      fallbackError: '전체 변경 사항을 롤백하지 못했습니다.',
      run: (rootPath) => wikiApi.git.discardAll(rootPath)
    })
  }, [runGitAction, wikiApi])

  const commit = useCallback(
    async (message: string, mode: GitCommitActionMode = 'commit'): Promise<boolean> => {
      const trimmed = message.trim()
      if (!trimmed || statusRef.current?.hasConflicts) {
        return false
      }
      const primaryAction = getGitPrimaryActionState(statusRef.current)
      const needsAutoStage =
        primaryAction.kind === 'commit' && primaryAction.requiresAutoStageConfirm

      return withMutationLock(async ({ rootPath, epoch }) => {
        if (needsAutoStage && callbacksRef.current.confirmAutoStageCommit) {
          const approved = await callbacksRef.current.confirmAutoStageCommit()
          if (!approved || !isCurrentRequest(rootPath, epoch)) {
            return false
          }
        }

        if (needsAutoStage) {
          if (mountedRef.current) {
            setPendingAction('전체 Stage')
          }
          let stagedStatus: GitStatus
          try {
            stagedStatus = await wikiApi.git.stageAll(rootPath)
          } catch (error: unknown) {
            reportGitActionError(
              rootPath,
              epoch,
              '전체 Stage',
              error,
              '전체 파일을 Stage하지 못했습니다.'
            )
            return false
          }
          if (!isCurrentRequest(rootPath, epoch)) {
            return false
          }
          await applyWorkspaceGitState(rootPath, epoch, stagedStatus, false)
        }

        if (mountedRef.current) {
          setPendingAction('Commit')
        }
        let committedStatus: GitStatus
        try {
          committedStatus = await wikiApi.git.commit(rootPath, trimmed)
        } catch (error: unknown) {
          reportGitActionError(rootPath, epoch, 'Commit', error, '커밋에 실패했습니다.')
          return false
        }
        if (!isCurrentRequest(rootPath, epoch)) {
          return false
        }

        await executePostCommitRemoteStep(rootPath, epoch, mode, committedStatus)
        return true
      })
    },
    [
      applyWorkspaceGitState,
      executePostCommitRemoteStep,
      isCurrentRequest,
      reportGitActionError,
      wikiApi,
      withMutationLock
    ]
  )

  const checkoutBranch = useCallback(
    async (branchName: string): Promise<void> => {
      await runGitAction('브랜치 전환', {
        affectsWorkspaceFiles: true,
        fetchRepoMetadata: true,
        fallbackError: '브랜치를 전환하지 못했습니다.',
        run: (rootPath) => wikiApi.git.checkout(rootPath, branchName)
      })
    },
    [runGitAction, wikiApi]
  )

  const pull = useCallback(async (): Promise<void> => {
    await runGitAction('Pull', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: true,
      fallbackError: 'Pull에 실패했습니다.',
      run: (rootPath) => wikiApi.git.pull(rootPath)
    })
  }, [runGitAction, wikiApi])

  const push = useCallback(async (): Promise<void> => {
    await runGitAction('Push', {
      fetchRepoMetadata: true,
      fallbackError: 'Push에 실패했습니다.',
      run: (rootPath) => wikiApi.git.push(rootPath)
    })
  }, [runGitAction, wikiApi])

  const fetch = useCallback(async (): Promise<void> => {
    await runGitAction('Fetch', {
      fetchRepoMetadata: true,
      fallbackError: 'Fetch에 실패했습니다.',
      run: (rootPath) => wikiApi.git.fetch(rootPath)
    })
  }, [runGitAction, wikiApi])

  const sync = useCallback(async (): Promise<void> => {
    await runGitAction('Sync', {
      affectsWorkspaceFiles: true,
      fetchRepoMetadata: true,
      fallbackError: 'Sync에 실패했습니다.',
      run: async (rootPath) => (await wikiApi.git.sync(rootPath)).status
    })
  }, [runGitAction, wikiApi])

  const dismissError = useCallback((): void => {
    setErrorMessage(null)
  }, [])

  return {
    status,
    branchList,
    graphState,
    pendingAction,
    errorMessage,
    dismissError,
    refreshStatus,
    changeLogScope,
    loadMoreCommits,
    toggleCommitDetail,
    initRepo,
    stageFile,
    stageAll,
    unstageFile,
    unstageAll,
    discardFile,
    discardAll,
    commit,
    checkoutBranch,
    pull,
    push,
    fetch,
    sync
  }
}
