import type { AppConfig } from './config'
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
  getRoot: 'workspace:get-root',
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
  getRoot(): Promise<string | null>
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

export interface WikiApi {
  config: WikiConfigApi
  workspace: WikiWorkspaceApi
}
