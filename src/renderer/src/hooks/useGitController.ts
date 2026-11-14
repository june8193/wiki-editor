import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranchList, GitStatus } from '@shared/git'
import { toErrorMessage } from '../utils/toErrorMessage'

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
  const mutationLockRef = useRef(false)
  const callbacksRef = useRef({ confirmBeforeWorkspaceMutation, onWorkspaceMutated })

  activeWorkspaceRef.current = workspaceRootPath
  callbacksRef.current = { confirmBeforeWorkspaceMutation, onWorkspaceMutated }

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
      fetchBranches: boolean
    ): Promise<void> => {
      if (
        !mountedRef.current ||
        activeWorkspaceRef.current !== rootPath ||
        workspaceEpochRef.current !== epoch
      ) {
        return
      }
      const applySeq = ++requestSeqRef.current
      setStatus(nextStatus)

      if (!nextStatus.isRepo) {
        setBranchList(null)
        return
      }
      if (!fetchBranches) return

      try {
        const nextBranches = await window.wikiApi.git.branches(rootPath)
        if (
          !mountedRef.current ||
          activeWorkspaceRef.current !== rootPath ||
          workspaceEpochRef.current !== epoch ||
          requestSeqRef.current !== applySeq
        ) {
          return
        }
        setBranchList(nextBranches)
      } catch {
        // Branch lookup failures are non-fatal if status succeeded cleanly
      }
    },
    []
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    const rootPath = activeWorkspaceRef.current
    if (!rootPath) {
      setStatus(null)
      setBranchList(null)
      setErrorMessage(null)
      return
    }
    // Active mutations fetch fresh Git state when done; skip concurrent FS watch refreshes while locked
    if (mutationLockRef.current) {
      return
    }

    const epoch = workspaceEpochRef.current
    const refreshSeq = ++requestSeqRef.current
    try {
      const nextStatus = await window.wikiApi.git.status(rootPath)
      if (
        mutationLockRef.current ||
        workspaceEpochRef.current !== epoch ||
        requestSeqRef.current !== refreshSeq
      ) {
        return
      }
      await applyWorkspaceGitState(rootPath, epoch, nextStatus, true)
    } catch (error: unknown) {
      if (
        !mountedRef.current ||
        activeWorkspaceRef.current !== rootPath ||
        workspaceEpochRef.current !== epoch
      ) {
        return
      }
      setErrorMessage(toErrorMessage(error, 'Git 상태를 불러오지 못했습니다.'))
    }
  }, [applyWorkspaceGitState])

  useEffect(() => {
    workspaceEpochRef.current += 1
    setErrorMessage(null)
    setStatus(null)
    setBranchList(null)
    setPendingAction(null)
    mutationLockRef.current = false

    if (workspaceRootPath) {
      void refreshStatus()
    }
  }, [refreshStatus, workspaceRootPath])

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
      if (!rootPath || mutationLockRef.current) return false

      const epoch = workspaceEpochRef.current
      mutationLockRef.current = true
      setErrorMessage(null)

      try {
        if (options.affectsWorkspaceFiles && callbacksRef.current.confirmBeforeWorkspaceMutation) {
          const confirmed = await callbacksRef.current.confirmBeforeWorkspaceMutation(actionLabel)
          if (
            !confirmed ||
            !mountedRef.current ||
            activeWorkspaceRef.current !== rootPath ||
            workspaceEpochRef.current !== epoch
          ) {
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
          mountedRef.current &&
          activeWorkspaceRef.current === rootPath &&
          workspaceEpochRef.current === epoch &&
          callbacksRef.current.onWorkspaceMutated
        ) {
          const warnings = await callbacksRef.current.onWorkspaceMutated()
          if (
            mountedRef.current &&
            activeWorkspaceRef.current === rootPath &&
            workspaceEpochRef.current === epoch &&
            warnings.length > 0
          ) {
            setErrorMessage(warnings.join(' '))
          }
        }

        return true
      } catch (error: unknown) {
        if (
          mountedRef.current &&
          activeWorkspaceRef.current === rootPath &&
          workspaceEpochRef.current === epoch
        ) {
          setErrorMessage(toErrorMessage(error, options.fallbackError))
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
        mutationLockRef.current = false
        if (mountedRef.current) {
          setPendingAction(null)
        }
      }
    },
    [applyWorkspaceGitState]
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
    pendingAction,
    errorMessage,
    dismissError,
    refreshStatus,
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
