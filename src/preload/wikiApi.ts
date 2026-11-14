import type { AppConfig } from '@shared/config'
import type { GitBranchList, GitStatus, GitSyncResult } from '@shared/git'
import {
  type AppMenuCommand,
  CONFIG_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
  WikiApi,
  WORKSPACE_IPC_CHANNELS
} from '@shared/ipc'
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
    },
    git: {
      status: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.status, workspacePath) as Promise<GitStatus>,
      init: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.init, workspacePath) as Promise<GitStatus>,
      stage: (workspacePath, paths) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.stage, workspacePath, paths) as Promise<GitStatus>,
      stageAll: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.stageAll, workspacePath) as Promise<GitStatus>,
      unstage: (workspacePath, paths) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.unstage, workspacePath, paths) as Promise<GitStatus>,
      unstageAll: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.unstageAll, workspacePath) as Promise<GitStatus>,
      commit: (workspacePath, message) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.commit, workspacePath, message) as Promise<GitStatus>,
      branches: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.branches, workspacePath) as Promise<GitBranchList>,
      checkout: (workspacePath, branchName) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.checkout,
          workspacePath,
          branchName
        ) as Promise<GitStatus>,
      pull: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.pull, workspacePath) as Promise<GitStatus>,
      push: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.push, workspacePath) as Promise<GitStatus>,
      sync: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.sync, workspacePath) as Promise<GitSyncResult>
    },
    menu: {
      onCommand: (listener) =>
        subscribeChannel<AppMenuCommand>(ipcRenderer, MENU_IPC_CHANNELS.command, listener)
    }
  }
}
