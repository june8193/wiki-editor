import type { AppConfig } from './config'
import type {
  GitBranchList,
  GitCommitDetail,
  GitDiffRequest,
  GitFileDiff,
  GitLogOptions,
  GitLogResult,
  GitStatus,
  GitSyncResult
} from './git'
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
  listMarkdownFiles: 'workspace:list-markdown-files',
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
  sync: 'git:sync',
  log: 'git:log',
  commitDetail: 'git:commit-detail',
  diff: 'git:diff'
} as const

export type AppMenuCommand = 'open-folder' | 'toggle-theme' | 'toggle-settings'

export const MENU_IPC_CHANNELS = {
  command: 'menu:command'
} as const

export const LOG_IPC_CHANNELS = {
  write: 'log:write'
} as const

export const CLIPBOARD_IPC_CHANNELS = {
  writeText: 'clipboard:write-text'
} as const

export const WINDOW_IPC_CHANNELS = {
  closeRequested: 'window:close-requested',
  closeResponse: 'window:close-response'
} as const

export type WindowCloseResponse = 'confirming' | 'close' | 'cancel'

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
  listMarkdownFiles(): Promise<WorkspaceEntry[]>
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
  log(workspacePath: string, options?: GitLogOptions): Promise<GitLogResult>
  commitDetail(workspacePath: string, commitHash: string): Promise<GitCommitDetail>
  diff(workspacePath: string, request: GitDiffRequest): Promise<GitFileDiff>
}

export interface WikiMenuApi {
  onCommand(listener: (command: AppMenuCommand) => void): () => void
}

export interface WikiLogApi {
  write(payload: RendererLogPayload): Promise<void>
}

export interface WikiClipboardApi {
  writeText(text: string): Promise<void>
}

export interface WikiWindowApi {
  onCloseRequested(listener: () => void): () => void
  respondClose(response: WindowCloseResponse): Promise<void>
}

export interface WikiApi {
  config: WikiConfigApi
  workspace: WikiWorkspaceApi
  git: WikiGitApi
  menu: WikiMenuApi
  log?: WikiLogApi
  clipboard?: WikiClipboardApi
  window?: WikiWindowApi
}
