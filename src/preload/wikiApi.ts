import type {
  WorkspaceImageIngestInput,
  WorkspaceImageIngestResult
} from '@shared/assets'
import type { AppConfig } from '@shared/config'
import type {
  BufferKeyRemap,
  DocumentBuffer,
  ReconcileBuffersResult,
  SaveBufferResult,
  SharedBufferHubEvent,
  SharedBufferStateSnapshot
} from '@shared/documentBuffer'
import type {
  GitBranchList,
  GitCommitDetail,
  GitDiffRequest,
  GitFileDiff,
  GitLogResult,
  GitStashCreateOptions,
  GitStashDetail,
  GitStashEntry,
  GitStatus,
  GitSyncResult
} from '@shared/git'
import {
  type AppMenuCommand,
  BUFFER_IPC_CHANNELS,
  CLIPBOARD_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  DIAGRAM_IPC_CHANNELS,
  type DiagramSaveResult,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
  WikiApi,
  WINDOW_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS,
  WORKSPACE_STATE_IPC_CHANNELS
} from '@shared/ipc'
import {
  resolveWindowRole,
  WINDOW_ROLE_QUERY_PARAM,
  type AcceptTabDragDropResult,
  type ActiveTabDragSession,
  type DetachTabToNewWindowResult,
  type TabDragEndResult,
  type WindowInitContext,
  type WindowRole
} from '@shared/window'
import type {
  ActivateOrOpenWorkspaceResult,
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceInfo,
  WorkspaceMovedEntry
} from '@shared/workspace'
import type {
  PersistedWorkspaceState,
  WorkspaceStateUpdate
} from '@shared/workspaceState'
import type { WorkspaceSearchRequest, WorkspaceSearchResponse } from '@shared/search'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

export interface CreateWikiApiOptions {
  getPathForFile?: (file: File) => string
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

function resolveWindowRoleFromSearch(search: string | undefined): WindowRole {
  if (!search) return 'main'
  return resolveWindowRole(new URLSearchParams(search).get(WINDOW_ROLE_QUERY_PARAM))
}

/**
 * Builds the type-safe window.wikiApi bridge exposed through Electron's contextBridge.
 */
export function createWikiApi(
  ipcRenderer: IpcRendererLike,
  optionsOrSearch: CreateWikiApiOptions | string = {},
  locationSearch?: string
): Required<WikiApi> {
  const options = typeof optionsOrSearch === 'string' ? {} : optionsOrSearch
  const effectiveSearch =
    typeof optionsOrSearch === 'string'
      ? optionsOrSearch
      : locationSearch ?? (typeof window !== 'undefined' ? window.location?.search : undefined)
  const windowRole = resolveWindowRoleFromSearch(effectiveSearch)
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
      openInNewWindow: (rootPath) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.openInNewWindow,
          rootPath
        ) as Promise<OpenWorkspaceInNewWindowResult>,
      activateOrOpen: (rootPath) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.activateOrOpen,
          rootPath
        ) as Promise<ActivateOrOpenWorkspaceResult>,
      focusIfOpen: (rootPath) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.focusIfOpen,
          rootPath
        ) as Promise<FocusOpenWorkspaceResult>,
      readDir: (dirPath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.readDir, dirPath) as Promise<WorkspaceEntry[]>,
      listMarkdownFiles: () =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.listMarkdownFiles) as Promise<WorkspaceEntry[]>,
      search: (request: WorkspaceSearchRequest) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.search,
          request
        ) as Promise<WorkspaceSearchResponse>,
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
      moveEntries: (sourcePaths, targetDirPath) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.moveEntries,
          sourcePaths,
          targetDirPath
        ) as Promise<WorkspaceMovedEntry[]>,
      deleteEntry: (targetPath) =>
        ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.deleteEntry, targetPath) as Promise<void>,
      ingestImage: (input) =>
        ipcRenderer.invoke(
          WORKSPACE_IPC_CHANNELS.ingestImage,
          input
        ) as Promise<WorkspaceImageIngestResult>,
      getPathForFile: (file) => {
        try {
          return options.getPathForFile?.(file) ?? ''
        } catch {
          return ''
        }
      },
      watch: () => ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.watch) as Promise<void>,
      unwatch: () => ipcRenderer.invoke(WORKSPACE_IPC_CHANNELS.unwatch) as Promise<void>,
      onChanged: (listener) =>
        subscribeChannel<WorkspaceChangeEvent>(
          ipcRenderer,
          WORKSPACE_IPC_CHANNELS.changed,
          listener
        )
    },
    workspaceState: {
      get: (rootPath) =>
        ipcRenderer.invoke(
          WORKSPACE_STATE_IPC_CHANNELS.get,
          rootPath
        ) as Promise<PersistedWorkspaceState | null>,
      save: (rootPath, update: WorkspaceStateUpdate) =>
        ipcRenderer.invoke(
          WORKSPACE_STATE_IPC_CHANNELS.save,
          rootPath,
          update
        ) as Promise<PersistedWorkspaceState>
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
      discard: (workspacePath, paths) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.discard, workspacePath, paths) as Promise<GitStatus>,
      discardAll: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.discardAll, workspacePath) as Promise<GitStatus>,
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
      fetch: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.fetch, workspacePath) as Promise<GitStatus>,
      sync: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.sync, workspacePath) as Promise<GitSyncResult>,
      log: (workspacePath, options) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.log, workspacePath, options) as Promise<GitLogResult>,
      commitDetail: (workspacePath, commitHash) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.commitDetail,
          workspacePath,
          commitHash
        ) as Promise<GitCommitDetail>,
      diff: (workspacePath, request: GitDiffRequest) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.diff, workspacePath, request) as Promise<GitFileDiff>,
      stashList: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.stashList, workspacePath) as Promise<GitStashEntry[]>,
      stashDetail: (workspacePath, stashRef) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.stashDetail,
          workspacePath,
          stashRef
        ) as Promise<GitStashDetail>,
      stashCreate: (workspacePath, options: GitStashCreateOptions) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.stashCreate,
          workspacePath,
          options
        ) as Promise<GitStatus>,
      stashApply: (workspacePath, stashRef) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.stashApply,
          workspacePath,
          stashRef
        ) as Promise<GitStatus>,
      stashPop: (workspacePath, stashRef) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.stashPop, workspacePath, stashRef) as Promise<GitStatus>,
      stashDrop: (workspacePath, stashRef) =>
        ipcRenderer.invoke(
          GIT_IPC_CHANNELS.stashDrop,
          workspacePath,
          stashRef
        ) as Promise<GitStashEntry[]>,
      stashClear: (workspacePath) =>
        ipcRenderer.invoke(GIT_IPC_CHANNELS.stashClear, workspacePath) as Promise<GitStashEntry[]>
    },
    menu: {
      onCommand: (listener) =>
        subscribeChannel<AppMenuCommand>(ipcRenderer, MENU_IPC_CHANNELS.command, listener)
    },
    buffer: {
      getSnapshot: () =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.getSnapshot) as Promise<SharedBufferStateSnapshot>,
      openWorkspaceFile: (filePath, name, initialContent) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.openWorkspaceFile,
          filePath,
          name,
          initialContent
        ) as Promise<DocumentBuffer>,
      openConfigDocument: () =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.openConfigDocument) as Promise<DocumentBuffer>,
      refreshCleanConfig: () =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.refreshCleanConfig) as Promise<DocumentBuffer | null>,
      updateContent: (key, nextContent) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.updateContent,
          key,
          nextContent
        ) as Promise<DocumentBuffer | null>,
      saveBuffer: (key) =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.saveBuffer, key) as Promise<SaveBufferResult>,
      syncWindowTabs: (bufferKeys, options) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.syncWindowTabs,
          bufferKeys,
          ...(options ? [options] : [])
        ) as Promise<SharedBufferStateSnapshot>,
      setAutoSavePaused: (paused) =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.setAutoSavePaused, paused) as Promise<void>,
      syncRenamedPath: (oldPath, newPath) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.syncRenamedPath,
          oldPath,
          newPath
        ) as Promise<BufferKeyRemap[]>,
      syncDeletedPath: (targetPath) =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.syncDeletedPath, targetPath) as Promise<string[]>,
      reconcileWorkspaceBuffersWithDisk: (changeEvent) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk,
          ...(changeEvent !== undefined ? [changeEvent] : [])
        ) as Promise<ReconcileBuffersResult>,
      prepareDiscardPaths: (targetPaths) =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.prepareDiscardPaths, targetPaths) as Promise<void>,
      finishDiscardPaths: (targetPaths, forceSync) =>
        ipcRenderer.invoke(
          BUFFER_IPC_CHANNELS.finishDiscardPaths,
          targetPaths,
          forceSync
        ) as Promise<string[]>,
      clearWorkspaceBuffers: () =>
        ipcRenderer.invoke(BUFFER_IPC_CHANNELS.clearWorkspaceBuffers) as Promise<string[]>,
      onEvent: (listener) =>
        subscribeChannel<SharedBufferHubEvent>(ipcRenderer, BUFFER_IPC_CHANNELS.event, listener)
    },
    window: {
      role: windowRole,
      getInitContext: () =>
        ipcRenderer.invoke(WINDOW_IPC_CHANNELS.getInitContext) as Promise<WindowInitContext>,
      detachTabToNewWindow: (payload) =>
        ipcRenderer.invoke(
          WINDOW_IPC_CHANNELS.detachTabToNewWindow,
          payload
        ) as Promise<DetachTabToNewWindowResult>,
      startTabDrag: (input) =>
        ipcRenderer.invoke(
          WINDOW_IPC_CHANNELS.startTabDrag,
          input
        ) as Promise<ActiveTabDragSession>,
      updateTabDragOutcome: (dragSessionId, outcome) =>
        ipcRenderer.invoke(
          WINDOW_IPC_CHANNELS.updateTabDragOutcome,
          dragSessionId,
          outcome
        ) as Promise<ActiveTabDragSession | null>,
      acceptTabDragDrop: (input) =>
        ipcRenderer.invoke(
          WINDOW_IPC_CHANNELS.acceptTabDragDrop,
          input
        ) as Promise<AcceptTabDragDropResult>,
      endTabDrag: (input) =>
        ipcRenderer.invoke(WINDOW_IPC_CHANNELS.endTabDrag, input) as Promise<TabDragEndResult>,
      onTabDragStateChanged: (listener) =>
        subscribeChannel<ActiveTabDragSession | null>(
          ipcRenderer,
          WINDOW_IPC_CHANNELS.dragStateChanged,
          listener
        ),
      closeCurrent: () => ipcRenderer.invoke(WINDOW_IPC_CHANNELS.closeCurrent) as Promise<void>,
      onCloseRequested: (listener) =>
        subscribeChannel<unknown>(ipcRenderer, WINDOW_IPC_CHANNELS.closeRequested, () =>
          listener()
        ),
      resolveCloseRequest: (approved) =>
        ipcRenderer.invoke(WINDOW_IPC_CHANNELS.resolveCloseRequest, approved) as Promise<void>,
      setCloseFlushEnabled: (enabled) =>
        ipcRenderer.invoke(WINDOW_IPC_CHANNELS.setCloseFlushEnabled, enabled) as Promise<void>
    },
    log: {
      write: (payload) => ipcRenderer.invoke(LOG_IPC_CHANNELS.write, payload) as Promise<void>
    },
    clipboard: {
      writeText: (text) =>
        ipcRenderer.invoke(CLIPBOARD_IPC_CHANNELS.writeText, text) as Promise<void>
    },
    diagram: {
      copyText: (text) => ipcRenderer.invoke(DIAGRAM_IPC_CHANNELS.copyText, text) as Promise<void>,
      copyImage: (pngBytes) =>
        ipcRenderer.invoke(DIAGRAM_IPC_CHANNELS.copyImage, pngBytes) as Promise<void>,
      saveFile: (request) =>
        ipcRenderer.invoke(DIAGRAM_IPC_CHANNELS.saveFile, request) as Promise<DiagramSaveResult>
    }
  }
}
