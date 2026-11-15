import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceEntryKind } from '@shared/workspace'
import { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  IpcHandlerTuple,
  IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  WebContentsLike
} from './ipcHelpers'

export interface RegisterWorkspaceIpcOptions {
  ipcMain: IpcMainLike
  workspaceService: WorkspaceFsService
  configService: ConfigService
  selectDirectory: () => Promise<string | null>
  getTargets: () => WebContentsLike[]
  isMainWindowSender?: (sender: WebContentsLike | undefined) => boolean
  logService?: LogService
}

/**
 * Registers workspace:* IPC handlers and broadcasts filesystem watch updates to live renderers.
 */
export function registerWorkspaceIpc({
  ipcMain,
  workspaceService,
  configService,
  selectDirectory,
  getTargets,
  isMainWindowSender = () => true,
  logService
}: RegisterWorkspaceIpcOptions): () => void {
  let stopWatching: (() => void) | null = null

  const clearWatcher = (): void => {
    stopWatching?.()
    stopWatching = null
    workspaceService.unwatch()
  }

  const isAllowedMainSender = (event: unknown): boolean =>
    isMainWindowSender(resolveSenderWebContents(event))

  const handlers: readonly IpcHandlerTuple[] = [
    [WORKSPACE_IPC_CHANNELS.selectFolder, () => selectDirectory()],
    [
      WORKSPACE_IPC_CHANNELS.open,
      async (event, rootPath) => {
        if (!isAllowedMainSender(event)) {
          throw new Error('Only the main window can open a workspace')
        }
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
      (event) => {
        if (!isAllowedMainSender(event)) {
          return
        }
        if (!stopWatching) {
          stopWatching = workspaceService.watch((changeEvent) => {
            broadcastIpcEvent(getTargets, WORKSPACE_IPC_CHANNELS.changed, changeEvent)
          })
        }
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.unwatch,
      (event) => {
        if (!isAllowedMainSender(event)) {
          return
        }
        clearWatcher()
      }
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })

  return () => {
    clearWatcher()
    removeHandlers()
  }
}
