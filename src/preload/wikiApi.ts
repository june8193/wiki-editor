import type { AppConfig } from '@shared/config'
import { CONFIG_IPC_CHANNELS, WikiApi, WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type {
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceInfo
} from '@shared/workspace'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

function subscribeChannel<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  listener: (payload: T) => void
): () => void {
  const handler = (_event: unknown, payload: unknown): void => {
    listener(payload as T)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
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
      saveRaw: (raw) => ipcRenderer.invoke(CONFIG_IPC_CHANNELS.saveRaw, raw) as Promise<AppConfig>,
      toggleFavoriteWorkspace: (workspacePath, name) =>
        ipcRenderer.invoke(
          CONFIG_IPC_CHANNELS.toggleFavoriteWorkspace,
          workspacePath,
          name
        ) as Promise<AppConfig>,
      removeFavoriteWorkspace: (workspacePath) =>
        ipcRenderer.invoke(
          CONFIG_IPC_CHANNELS.removeFavoriteWorkspace,
          workspacePath
        ) as Promise<AppConfig>,
      onChanged: (listener) => subscribeChannel(ipcRenderer, CONFIG_IPC_CHANNELS.changed, listener)
    },
    workspace: {
      selectFolder: () =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.selectFolder) as Promise<string | null>,
      open: (rootPath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.open, rootPath) as Promise<WorkspaceInfo>,
      readDir: (dirPath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.readDir, dirPath) as Promise<WorkspaceEntry[]>,
      readFile: (filePath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.readFile, filePath) as Promise<string>,
      writeFile: (filePath, content) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.writeFile, filePath, content) as Promise<void>,
      createEntry: (parentDirPath, name, kind, initialContent) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.createEntry,
          parentDirPath,
          name,
          kind,
          initialContent
        ) as Promise<WorkspaceEntry>,
      renameEntry: (targetPath, newName) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.renameEntry,
          targetPath,
          newName
        ) as Promise<WorkspaceEntry>,
      deleteEntry: (targetPath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.deleteEntry, targetPath) as Promise<void>,
      watch: () => ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.watch) as Promise<void>,
      unwatch: () => ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.unwatch) as Promise<void>,
      onChanged: (listener) =>
        subscribeChannel<WorkspaceChangeEvent>(
          ipcRenderer,
          WORKSPACE_IPC_CHANNELS.changed,
          listener
        )
    }
  }
}
