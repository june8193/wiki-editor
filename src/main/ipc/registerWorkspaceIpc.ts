import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceEntryKind } from '@shared/workspace'
import { ConfigService } from '../config/ConfigService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  IpcHandlerTuple,
  IpcMainLike,
  registerIpcHandlers,
  WebContentsLike
} from './ipcHelpers'

export interface RegisterWorkspaceIpcOptions {
  ipcMain: IpcMainLike
  workspaceService: WorkspaceFsService
  configService: ConfigService
  selectDirectory: () => Promise<string | null>
  getTargets: () => WebContentsLike[]
}

/**
 * Registers workspace:* IPC handlers and broadcasts filesystem watch updates to live renderers.
 */
export function registerWorkspaceIpc({
  ipcMain,
  workspaceService,
  configService,
  selectDirectory,
  getTargets
}: RegisterWorkspaceIpcOptions): () => void {
  let stopWatching: (() => void) | null = null

  const clearWatcher = (): void => {
    stopWatching?.()
    stopWatching = null
    workspaceService.unwatch()
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [WORKSPACE_IPC_CHANNELS.selectFolder, () => selectDirectory()],
    [
      WORKSPACE_IPC_CHANNELS.open,
      async (_event, rootPath) => {
        const info = await workspaceService.openWorkspace(rootPath as string)
        stopWatching = null
        await configService.recordRecentWorkspace(info.rootPath)
        return info
      }
    ],
    [WORKSPACE_IPC_CHANNELS.readDir, (_event, dirPath) => workspaceService.readDir(dirPath as string | undefined)],
    [WORKSPACE_IPC_CHANNELS.readFile, (_event, filePath) => workspaceService.readFile(filePath as string)],
    [
      WORKSPACE_IPC_CHANNELS.writeFile,
      (_event, filePath, content) =>
        workspaceService.writeFile(filePath as string, content as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.createEntry,
      (_event, parentDirPath, name, kind, initialContent) =>
        workspaceService.createEntry(
          parentDirPath as string,
          name as string,
          kind as WorkspaceEntryKind,
          initialContent as string | undefined
        )
    ],
    [
      WORKSPACE_IPC_CHANNELS.renameEntry,
      (_event, targetPath, newName) =>
        workspaceService.renameEntry(targetPath as string, newName as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.deleteEntry,
      (_event, targetPath) => workspaceService.deleteEntry(targetPath as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.watch,
      () => {
        if (!stopWatching) {
          stopWatching = workspaceService.watch((event) => {
            broadcastIpcEvent(getTargets, WORKSPACE_IPC_CHANNELS.changed, event)
          })
        }
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.unwatch,
      () => {
        clearWatcher()
      }
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers)

  return () => {
    clearWatcher()
    removeHandlers()
  }
}
