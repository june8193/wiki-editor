import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranchList, GitStatus } from '@shared/git'
import { logRendererError, logRendererWarn } from '../logging/rendererLogger'
import { toErrorMessage } from '../utils/toErrorMessage'
import { useGitGraphLog } from './useGitGraphLog'

interface UseGitControllerOptions {
  workspaceRootPath: string | null
  confirmBeforeWorkspaceMutation?: (actionLabel: string) => Promise<boolean>
  onWorkspaceMutated?: () => Promise<readonly string[]>
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
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const activeWorkspaceRef = useRef<string | null>(workspaceRootPath)
  const workspaceEpochRef = useRef(0)
  const requestSeqRef = useRef(0)
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

  const { graphState, resetGraph, refreshGraph, changeLogScope, loadMoreCommits } = useGitGraphLog({
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
      setStatus(nextStatus)

      if (!nextStatus.isRepo) {
        setBranchList(null)
        resetGraph(false)
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

      await Promise.all([branchesTask, refreshGraph(rootPath, epoch)])
    },
    [isCurrentRequest, refreshGraph, resetGraph]
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
  }, [applyWorkspaceGitState, isCurrentRequest, resetGraph])

  useEffect(() => {
    workspaceEpochRef.current += 1
    mutationTokenRef.current = null
    setErrorMessage(null)
    setStatus(null)
    setBranchList(null)
    setPendingAction(null)
    resetGraph(true)

    if (workspaceRootPath) {
      void refreshStatus()
    }
  }, [refreshStatus, resetGraph, workspaceRootPath])

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
