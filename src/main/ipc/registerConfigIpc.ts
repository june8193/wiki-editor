import { AppConfig } from '@shared/config'
import { CONFIG_IPC_CHANNELS } from '@shared/ipc'
import { ConfigService } from '../config/ConfigService'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/**
 * Registers config:* IPC handlers and broadcasts config changes to live renderer windows.
 */
export function registerConfigIpc(
  ipcMain: IpcMainLike,
  configService: ConfigService,
  getTargets: () => WebContentsLike[]
): () => void {
  const invokeChannels = [
    CONFIG_IPC_CHANNELS.get,
    CONFIG_IPC_CHANNELS.update,
    CONFIG_IPC_CHANNELS.getPath,
    CONFIG_IPC_CHANNELS.readRaw
  ]

  ipcMain.handle(CONFIG_IPC_CHANNELS.get, () => configService.get())
  ipcMain.handle(CONFIG_IPC_CHANNELS.update, (_event, patch) =>
    configService.update((patch ?? {}) as Partial<AppConfig>)
  )
  ipcMain.handle(CONFIG_IPC_CHANNELS.getPath, () => configService.getConfigPath())
  ipcMain.handle(CONFIG_IPC_CHANNELS.readRaw, () => configService.readRaw())

  const unsubscribe = configService.onChanged((updatedConfig) => {
    for (const target of getTargets()) {
      if (!target.isDestroyed()) {
        target.send(CONFIG_IPC_CHANNELS.changed, updatedConfig)
      }
    }
  })

  return () => {
    unsubscribe()
    for (const channel of invokeChannels) {
      ipcMain.removeHandler(channel)
    }
  }
}
