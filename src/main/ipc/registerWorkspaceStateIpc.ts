import { WORKSPACE_STATE_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceStateUpdate } from '@shared/workspaceState'
import type { LogService } from '../logging/LogService'
import type { WorkspaceStateService } from '../workspace/WorkspaceStateService'
import {
  type IpcHandlerTuple,
  type IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  type WebContentsLike
} from './ipcHelpers'

export interface RegisterWorkspaceStateIpcOptions {
  ipcMain: IpcMainLike
  workspaceStateService: WorkspaceStateService
  isMainWindowSender?: (sender: WebContentsLike | undefined) => boolean
  logService?: LogService
}

/**
 * Registers workspace-state:* IPC handlers restricted to the main window.
 */
export function registerWorkspaceStateIpc({
  ipcMain,
  workspaceStateService,
  isMainWindowSender = () => true,
  logService
}: RegisterWorkspaceStateIpcOptions): () => void {
  const assertMainWindowSender = (event: unknown): void => {
    if (!isMainWindowSender(resolveSenderWebContents(event))) {
      throw new Error('Only the main window can access workspace state')
    }
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [
      WORKSPACE_STATE_IPC_CHANNELS.get,
      (event, rootPath) => {
        assertMainWindowSender(event)
        return workspaceStateService.getWorkspaceState(rootPath as string)
      }
    ],
    [
      WORKSPACE_STATE_IPC_CHANNELS.save,
      (event, rootPath, update) => {
        assertMainWindowSender(event)
        return workspaceStateService.saveWorkspaceState(
          rootPath as string,
          update as WorkspaceStateUpdate
        )
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
