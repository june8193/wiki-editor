import type {
  GitCompareSummaryRequest,
  GitDiffRequest,
  GitLogOptions,
  GitStashCreateOptions
} from '@shared/git'
import { GIT_IPC_CHANNELS } from '@shared/ipc'
import { isSameWorkspacePath } from '@shared/workspace'
import type { GitService } from '../git/GitService'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  IpcHandlerTuple,
  IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  type WebContentsLike
} from './ipcHelpers'

export interface RegisterGitIpcOptions {
  ipcMain: IpcMainLike
  gitService: GitService
  workspaceService?: WorkspaceFsService
  resolveWorkspaceService?: (sender: WebContentsLike | undefined) => WorkspaceFsService | undefined
  logService?: LogService
}

function assertActiveWorkspaceRoot(
  workspaceService: WorkspaceFsService | undefined,
  workspacePath: unknown
): string {
  const activeRoot = workspaceService?.getWorkspaceRoot()
  if (!activeRoot) {
    throw new Error('열린 워크스페이스가 없습니다.')
  }
  if (
    typeof workspacePath !== 'string' ||
    !workspacePath.trim() ||
    !isSameWorkspacePath(activeRoot, workspacePath)
  ) {
    throw new Error('요청한 경로가 현재 활성 워크스페이스 경로와 일치하지 않습니다.')
  }
  return activeRoot
}

/**
 * Registers git:* IPC handlers scoped strictly to the sender session's currently opened workspace.
 */
export function registerGitIpc({
  ipcMain,
  gitService,
  workspaceService,
  resolveWorkspaceService,
  logService
}: RegisterGitIpcOptions): () => void {
  const resolveService =
    resolveWorkspaceService ??
    (() => workspaceService)

  const withWorkspace =
    <TArgs extends unknown[], TResult>(fn: (rootPath: string, ...args: TArgs) => Promise<TResult>) =>
    (event: unknown, workspacePath: unknown, ...rest: unknown[]) => {
      const senderService = resolveService(resolveSenderWebContents(event))
      const rootPath = assertActiveWorkspaceRoot(senderService, workspacePath)
      return fn(rootPath, ...(rest as TArgs))
    }

  const handlers: readonly IpcHandlerTuple[] = [
    [GIT_IPC_CHANNELS.status, withWorkspace((rootPath) => gitService.status(rootPath))],
    [GIT_IPC_CHANNELS.init, withWorkspace((rootPath) => gitService.init(rootPath))],
    [
      GIT_IPC_CHANNELS.stage,
      withWorkspace<[string[]], Awaited<ReturnType<GitService['stage']>>>((rootPath, paths) =>
        gitService.stage(rootPath, paths)
      )
    ],
    [GIT_IPC_CHANNELS.stageAll, withWorkspace((rootPath) => gitService.stageAll(rootPath))],
    [
      GIT_IPC_CHANNELS.unstage,
      withWorkspace<[string[]], Awaited<ReturnType<GitService['unstage']>>>((rootPath, paths) =>
        gitService.unstage(rootPath, paths)
      )
    ],
    [GIT_IPC_CHANNELS.unstageAll, withWorkspace((rootPath) => gitService.unstageAll(rootPath))],
    [
      GIT_IPC_CHANNELS.discard,
      withWorkspace<[string[]], Awaited<ReturnType<GitService['discard']>>>((rootPath, paths) =>
        gitService.discard(rootPath, paths)
      )
    ],
    [GIT_IPC_CHANNELS.discardAll, withWorkspace((rootPath) => gitService.discardAll(rootPath))],
    [
      GIT_IPC_CHANNELS.commit,
      withWorkspace<[string], Awaited<ReturnType<GitService['commit']>>>((rootPath, message) =>
        gitService.commit(rootPath, message)
      )
    ],
    [GIT_IPC_CHANNELS.branches, withWorkspace((rootPath) => gitService.branches(rootPath))],
    [
      GIT_IPC_CHANNELS.checkout,
      withWorkspace<[string], Awaited<ReturnType<GitService['checkout']>>>((rootPath, branchName) =>
        gitService.checkout(rootPath, branchName)
      )
    ],
    [GIT_IPC_CHANNELS.pull, withWorkspace((rootPath) => gitService.pull(rootPath))],
    [GIT_IPC_CHANNELS.push, withWorkspace((rootPath) => gitService.push(rootPath))],
    [GIT_IPC_CHANNELS.fetch, withWorkspace((rootPath) => gitService.fetch(rootPath))],
    [GIT_IPC_CHANNELS.sync, withWorkspace((rootPath) => gitService.sync(rootPath))],
    [
      GIT_IPC_CHANNELS.log,
      withWorkspace<[GitLogOptions | undefined], Awaited<ReturnType<GitService['log']>>>(
        (rootPath, options) => gitService.log(rootPath, options)
      )
    ],
    [
      GIT_IPC_CHANNELS.commitDetail,
      withWorkspace<[string], Awaited<ReturnType<GitService['commitDetail']>>>(
        (rootPath, commitHash) => gitService.commitDetail(rootPath, commitHash)
      )
    ],
    [
      GIT_IPC_CHANNELS.diff,
      withWorkspace<[GitDiffRequest], Awaited<ReturnType<GitService['diff']>>>(
        (rootPath, request) => gitService.diff(rootPath, request)
      )
    ],
    [
      GIT_IPC_CHANNELS.compareRefs,
      withWorkspace((rootPath) => gitService.compareRefs(rootPath))
    ],
    [
      GIT_IPC_CHANNELS.compareSummary,
      withWorkspace<[GitCompareSummaryRequest], Awaited<ReturnType<GitService['compareSummary']>>>(
        (rootPath, request) => gitService.compareSummary(rootPath, request)
      )
    ],
    [GIT_IPC_CHANNELS.stashList, withWorkspace((rootPath) => gitService.stashList(rootPath))],
    [
      GIT_IPC_CHANNELS.stashDetail,
      withWorkspace<[string], Awaited<ReturnType<GitService['stashDetail']>>>(
        (rootPath, stashRef) => gitService.stashDetail(rootPath, stashRef)
      )
    ],
    [
      GIT_IPC_CHANNELS.stashCreate,
      withWorkspace<[GitStashCreateOptions], Awaited<ReturnType<GitService['stashCreate']>>>(
        (rootPath, options) => gitService.stashCreate(rootPath, options)
      )
    ],
    [
      GIT_IPC_CHANNELS.stashApply,
      withWorkspace<[string], Awaited<ReturnType<GitService['stashApply']>>>(
        (rootPath, stashRef) => gitService.stashApply(rootPath, stashRef)
      )
    ],
    [
      GIT_IPC_CHANNELS.stashPop,
      withWorkspace<[string], Awaited<ReturnType<GitService['stashPop']>>>((rootPath, stashRef) =>
        gitService.stashPop(rootPath, stashRef)
      )
    ],
    [
      GIT_IPC_CHANNELS.stashDrop,
      withWorkspace<[string], Awaited<ReturnType<GitService['stashDrop']>>>((rootPath, stashRef) =>
        gitService.stashDrop(rootPath, stashRef)
      )
    ],
    [GIT_IPC_CHANNELS.stashClear, withWorkspace((rootPath) => gitService.stashClear(rootPath))]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
