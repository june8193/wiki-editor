import { AppConfig } from '@shared/config'
import { CONFIG_IPC_CHANNELS, WikiApi } from '@shared/ipc'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

/**
 * Builds the type-safe window.wikiApi bridge exposed through Electron's contextBridge.
 */
export function createWikiApi(ipcRenderer: IpcRendererLike): WikiApi {
  return {
    config: {
      get: () => ipcRenderer.invoke(CONFIG_IPC_CHANNELS.get) as Promise<AppConfig>,
      update: (patch) =>
        ipcRenderer.invoke(CONFIG_IPC_CHANNELS.update, patch) as Promise<AppConfig>,
      getConfigPath: () => ipcRenderer.invoke(CONFIG_IPC_CHANNELS.getPath) as Promise<string>,
      readRaw: () => ipcRenderer.invoke(CONFIG_IPC_CHANNELS.readRaw) as Promise<string>,
      onChanged: (listener) => {
        const handler = (_event: unknown, updatedConfig: unknown): void => {
          listener(updatedConfig as AppConfig)
        }
        ipcRenderer.on(CONFIG_IPC_CHANNELS.changed, handler)
        return () => {
          ipcRenderer.removeListener(CONFIG_IPC_CHANNELS.changed, handler)
        }
      }
    }
  }
}
