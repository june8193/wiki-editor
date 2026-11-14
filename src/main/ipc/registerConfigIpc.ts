import { AppConfig } from '@shared/config'
import { CONFIG_IPC_CHANNELS } from '@shared/ipc'
import { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import {
  broadcastIpcEvent,
  IpcHandlerTuple,
  IpcMainLike,
  registerIpcHandlers,
  WebContentsLike
} from './ipcHelpers'

export type { IpcMainLike, WebContentsLike }

/**
 * Registers config:* IPC handlers and broadcasts config changes to live renderer windows.
 */
export function registerConfigIpc(
  ipcMain: IpcMainLike,
  configService: ConfigService,
  getTargets: () => WebContentsLike[],
  logService?: LogService
): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [CONFIG_IPC_CHANNELS.get, () => configService.get()],
    [
      CONFIG_IPC_CHANNELS.update,
      (_event, patch) => configService.update(patch as Partial<AppConfig>)
    ],
    [CONFIG_IPC_CHANNELS.getPath, () => configService.getConfigPath()],
    [CONFIG_IPC_CHANNELS.readRaw, () => configService.readRaw()],
    [CONFIG_IPC_CHANNELS.saveRaw, (_event, raw) => configService.saveRaw(raw as string)],
    [
      CONFIG_IPC_CHANNELS.toggleFavoriteWorkspace,
      (_event, workspacePath, name) =>
        configService.toggleFavoriteWorkspace(
          workspacePath as string,
          name as string | undefined
        )
    ],
    [
      CONFIG_IPC_CHANNELS.removeFavoriteWorkspace,
      (_event, workspacePath) => configService.removeFavoriteWorkspace(workspacePath as string)
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })
  const unsubscribe = configService.onChanged((updatedConfig) => {
    broadcastIpcEvent(getTargets, CONFIG_IPC_CHANNELS.changed, updatedConfig)
  })

  return () => {
    unsubscribe()
    removeHandlers()
  }
}
