import type { AppConfig } from './config'
import type {
  BufferKeyRemap,
  DocumentBuffer,
  ReconcileBuffersResult,
  SaveBufferResult,
  SharedBufferHubEvent,
  SharedBufferStateSnapshot,
  SyncWindowTabsOptions
} from './documentBuffer'
import type {
  DetachTabToNewWindowResult,
  TabTransferPayload,
  WindowInitContext,
  WindowRole
} from './window'
import type { GitBranchList, GitStatus, GitSyncResult } from './git'
import type { RendererLogPayload } from './logging'
import type {
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceInfo
} from './workspace'

export const CONFIG_IPC_CHANNELS = {
  get: 'config:get',
  update: 'config:update',
  getPath: 'config:get-path',
  readRaw: 'config:read-raw',
  saveRaw: 'config:save-raw',
  toggleFavoriteWorkspace: 'config:toggle-favorite-workspace',
  removeFavoriteWorkspace: 'config:remove-favorite-workspace',
  changed: 'config:changed'
} as const

export const WORKSPACE_IPC_CHANNELS = {
  selectFolder: 'workspace:select-folder',
  open: 'workspace:open',
  readDir: 'workspace:read-dir',
  readFile: 'workspace:read-file',
  writeFile: 'workspace:write-file',
  createEntry: 'workspace:create-entry',
  renameEntry: 'workspace:rename-entry',
  deleteEntry: 'workspace:delete-entry',
  watch: 'workspace:watch',
  unwatch: 'workspace:unwatch',
  changed: 'workspace:changed'
} as const

export const GIT_IPC_CHANNELS = {
  status: 'git:status',
  init: 'git:init',
  stage: 'git:stage',
  stageAll: 'git:stage-all',
  unstage: 'git:unstage',
  unstageAll: 'git:unstage-all',
  commit: 'git:commit',
  branches: 'git:branches',
  checkout: 'git:checkout',
  pull: 'git:pull',
  push: 'git:push',
  sync: 'git:sync'
} as const

export type AppMenuCommand = 'open-folder' | 'toggle-theme' | 'toggle-settings'

export const MENU_IPC_CHANNELS = {
  command: 'menu:command'
} as const

export const BUFFER_IPC_CHANNELS = {
  getSnapshot: 'buffer:get-snapshot',
  openWorkspaceFile: 'buffer:open-workspace-file',
  openConfigDocument: 'buffer:open-config-document',
  refreshCleanConfig: 'buffer:refresh-clean-config',
  updateContent: 'buffer:update-content',
  saveBuffer: 'buffer:save-buffer',
  syncWindowTabs: 'buffer:sync-window-tabs',
  setAutoSavePaused: 'buffer:set-auto-save-paused',
  syncRenamedPath: 'buffer:sync-renamed-path',
  syncDeletedPath: 'buffer:sync-deleted-path',
  reconcileWorkspaceBuffersWithDisk: 'buffer:reconcile-workspace-buffers-with-disk',
  event: 'buffer:event'
} as const

export const LOG_IPC_CHANNELS = {
  write: 'log:write'
} as const

export const WINDOW_IPC_CHANNELS = {
  getInitContext: 'window:get-init-context',
  detachTabToNewWindow: 'window:detach-tab-to-new-window',
  closeCurrent: 'window:close-current'
} as const

export interface WikiConfigApi {
  get(): Promise<AppConfig>
  update(patch: Partial<AppConfig>): Promise<AppConfig>
  getConfigPath(): Promise<string>
  readRaw(): Promise<string>
  saveRaw(raw: string): Promise<AppConfig>
  toggleFavoriteWorkspace(workspacePath: string, name?: string): Promise<AppConfig>
  removeFavoriteWorkspace(workspacePath: string): Promise<AppConfig>
  onChanged(listener: (config: AppConfig) => void): () => void
}

export interface WikiWorkspaceApi {
  selectFolder(): Promise<string | null>
  open(rootPath: string): Promise<WorkspaceInfo>
  readDir(dirPath?: string): Promise<WorkspaceEntry[]>
  readFile(filePath: string): Promise<string>
  writeFile(filePath: string, content: string): Promise<void>
  createEntry(
    parentDirPath: string,
    name: string,
    kind: WorkspaceEntryKind,
    initialContent?: string
  ): Promise<WorkspaceEntry>
  renameEntry(targetPath: string, newName: string): Promise<WorkspaceEntry>
  deleteEntry(targetPath: string): Promise<void>
  watch(): Promise<void>
  unwatch(): Promise<void>
  onChanged(listener: (event: WorkspaceChangeEvent) => void): () => void
}

export interface WikiGitApi {
  status(workspacePath: string): Promise<GitStatus>
  init(workspacePath: string): Promise<GitStatus>
  stage(workspacePath: string, paths: string[]): Promise<GitStatus>
  stageAll(workspacePath: string): Promise<GitStatus>
  unstage(workspacePath: string, paths: string[]): Promise<GitStatus>
  unstageAll(workspacePath: string): Promise<GitStatus>
  commit(workspacePath: string, message: string): Promise<GitStatus>
  branches(workspacePath: string): Promise<GitBranchList>
  checkout(workspacePath: string, branchName: string): Promise<GitStatus>
  pull(workspacePath: string): Promise<GitStatus>
  push(workspacePath: string): Promise<GitStatus>
  sync(workspacePath: string): Promise<GitSyncResult>
}

export interface WikiMenuApi {
  onCommand(listener: (command: AppMenuCommand) => void): () => void
}

export interface WikiBufferApi {
  getSnapshot(): Promise<SharedBufferStateSnapshot>
  openWorkspaceFile(
    filePath: string,
    name?: string,
    initialContent?: string
  ): Promise<DocumentBuffer>
  openConfigDocument(): Promise<DocumentBuffer>
  refreshCleanConfig(): Promise<DocumentBuffer | null>
  updateContent(key: string, nextContent: string): Promise<DocumentBuffer | null>
  saveBuffer(key: string): Promise<SaveBufferResult>
  syncWindowTabs(
    bufferKeys: string[],
    options?: SyncWindowTabsOptions
  ): Promise<SharedBufferStateSnapshot>
  setAutoSavePaused(paused: boolean): Promise<void>
  syncRenamedPath(oldPath: string, newPath: string): Promise<BufferKeyRemap[]>
  syncDeletedPath(targetPath: string): Promise<string[]>
  reconcileWorkspaceBuffersWithDisk(): Promise<ReconcileBuffersResult>
  onEvent(listener: (event: SharedBufferHubEvent) => void): () => void
}

export interface WikiLogApi {
  write(payload: RendererLogPayload): Promise<void>
}

export interface WikiWindowApi {
  readonly role: WindowRole
  getInitContext(): Promise<WindowInitContext>
  detachTabToNewWindow(payload: TabTransferPayload): Promise<DetachTabToNewWindowResult>
  closeCurrent(): Promise<void>
}

export interface WikiApi {
  config: WikiConfigApi
  workspace: WikiWorkspaceApi
  git: WikiGitApi
  menu: WikiMenuApi
  buffer: WikiBufferApi
  window?: WikiWindowApi
  log?: WikiLogApi
}
