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
      nextStatus: GitStatus,
      seq: number,
      fetchBranches: boolean
    ): Promise<void> => {
      if (!mountedRef.current || activeWorkspaceRef.current !== rootPath || requestSeqRef.current !== seq) {
        return
      }
      setStatus(nextStatus)

      if (!nextStatus.isRepo) {
        setBranchList(null)
        return
      }
      if (!fetchBranches) return

      try {
        const nextBranches = await window.wikiApi.git.branches(rootPath)
        if (!mountedRef.current || activeWorkspaceRef.current !== rootPath || requestSeqRef.current !== seq) {
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

    const seq = ++requestSeqRef.current
    try {
      const nextStatus = await window.wikiApi.git.status(rootPath)
      await applyWorkspaceGitState(rootPath, nextStatus, seq, true)
    } catch (error: unknown) {
      if (!mountedRef.current || activeWorkspaceRef.current !== rootPath) return
      setErrorMessage(toErrorMessage(error, 'Git 상태를 불러오지 못했습니다.'))
    }
  }, [applyWorkspaceGitState])

  useEffect(() => {
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
    async <T,>(
      actionLabel: string,
      options: {
        affectsWorkspaceFiles?: boolean
        fetchBranches?: boolean
        fallbackError: string
        run: (rootPath: string) => Promise<{ nextStatus: GitStatus; result: T }>
      }
    ): Promise<T | null> => {
      const rootPath = activeWorkspaceRef.current
      if (!rootPath || mutationLockRef.current) return null

      mutationLockRef.current = true
      setErrorMessage(null)

      try {
        if (options.affectsWorkspaceFiles && callbacksRef.current.confirmBeforeWorkspaceMutation) {
          const confirmed = await callbacksRef.current.confirmBeforeWorkspaceMutation(actionLabel)
          if (!confirmed || !mountedRef.current || activeWorkspaceRef.current !== rootPath) {
            return null
          }
        }

        if (mountedRef.current) {
          setPendingAction(actionLabel)
        }

        const seq = ++requestSeqRef.current
        const { nextStatus, result } = await options.run(rootPath)
        await applyWorkspaceGitState(rootPath, nextStatus, seq, options.fetchBranches ?? false)

        if (
          options.affectsWorkspaceFiles &&
          mountedRef.current &&
          activeWorkspaceRef.current === rootPath &&
          callbacksRef.current.onWorkspaceMutated
        ) {
          const warnings = await callbacksRef.current.onWorkspaceMutated()
          if (mountedRef.current && activeWorkspaceRef.current === rootPath && warnings.length > 0) {
            setErrorMessage(warnings.join(' '))
          }
        }

        return result
      } catch (error: unknown) {
        if (mountedRef.current && activeWorkspaceRef.current === rootPath) {
          setErrorMessage(toErrorMessage(error, options.fallbackError))
          if (options.affectsWorkspaceFiles) {
            const seq = ++requestSeqRef.current
            await window.wikiApi.git
              .status(rootPath)
              .then((fresh) => applyWorkspaceGitState(rootPath, fresh, seq, true))
              .catch(() => undefined)
            await callbacksRef.current.onWorkspaceMutated?.().catch(() => [])
          }
        }
        return null
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
      run: async (rootPath) => {
        const nextStatus = await window.wikiApi.git.init(rootPath)
        return { nextStatus, result: true }
      }
    })
  }, [runGitAction])

  const stageFile = useCallback(
    async (filePath: string): Promise<void> => {
      await runGitAction('Stage', {
        fallbackError: '파일을 Stage하지 못했습니다.',
        run: async (rootPath) => ({
          nextStatus: await window.wikiApi.git.stage(rootPath, [filePath]),
          result: true
        })
      })
    },
    [runGitAction]
  )

  const stageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Stage', {
      fallbackError: '전체 파일을 Stage하지 못했습니다.',
      run: async (rootPath) => ({
        nextStatus: await window.wikiApi.git.stageAll(rootPath),
        result: true
      })
    })
  }, [runGitAction])

  const unstageFile = useCallback(
    async (filePath: string): Promise<void> => {
      await runGitAction('Unstage', {
        fallbackError: '파일을 Unstage하지 못했습니다.',
        run: async (rootPath) => ({
          nextStatus: await window.wikiApi.git.unstage(rootPath, [filePath]),
          result: true
        })
      })
    },
    [runGitAction]
  )

  const unstageAll = useCallback(async (): Promise<void> => {
    await runGitAction('전체 Unstage', {
      fallbackError: '전체 파일을 Unstage하지 못했습니다.',
      run: async (rootPath) => ({
        nextStatus: await window.wikiApi.git.unstageAll(rootPath),
        result: true
      })
    })
  }, [runGitAction])

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      const ok = await runGitAction('Commit', {
        fetchBranches: true,
        fallbackError: '커밋에 실패했습니다.',
        run: async (rootPath) => ({
          nextStatus: await window.wikiApi.git.commit(rootPath, message),
          result: true
        })
      })
      return ok === true
    },
    [runGitAction]
  )

  const checkoutBranch = useCallback(
    async (branchName: string): Promise<void> => {
      await runGitAction('브랜치 전환', {
        affectsWorkspaceFiles: true,
        fetchBranches: true,
        fallbackError: '브랜치를 전환하지 못했습니다.',
        run: async (rootPath) => ({
          nextStatus: await window.wikiApi.git.checkout(rootPath, branchName),
          result: true
        })
      })
    },
    [runGitAction]
  )

  const pull = useCallback(async (): Promise<void> => {
    await runGitAction('Pull', {
      affectsWorkspaceFiles: true,
      fetchBranches: true,
      fallbackError: 'Pull에 실패했습니다.',
      run: async (rootPath) => ({
        nextStatus: await window.wikiApi.git.pull(rootPath),
        result: true
      })
    })
  }, [runGitAction])

  const push = useCallback(async (): Promise<void> => {
    await runGitAction('Push', {
      fetchBranches: true,
      fallbackError: 'Push에 실패했습니다.',
      run: async (rootPath) => ({
        nextStatus: await window.wikiApi.git.push(rootPath),
        result: true
      })
    })
  }, [runGitAction])

  const sync = useCallback(async (): Promise<void> => {
    await runGitAction('Sync', {
      affectsWorkspaceFiles: true,
      fetchBranches: true,
      fallbackError: 'Sync에 실패했습니다.',
      run: async (rootPath) => {
        const syncResult = await window.wikiApi.git.sync(rootPath)
        return { nextStatus: syncResult.status, result: syncResult }
      }
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
