import type {
  WorkspaceImageIngestInput,
  WorkspaceImageIngestResult
} from './assets'
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
  GitBranchList,
  GitCommitDetail,
  GitDiffRequest,
  GitFileDiff,
  GitLogOptions,
  GitLogResult,
  GitStashCreateOptions,
  GitStashDetail,
  GitStashEntry,
  GitStatus,
  GitSyncResult
} from './git'
import type {
  AcceptTabDragDropInput,
  AcceptTabDragDropResult,
  ActiveTabDragSession,
  DetachTabToNewWindowResult,
  TabDragEndInput,
  TabDragEndResult,
  TabDragResolution,
  TabDragStartInput,
  TabTransferPayload,
  WindowInitContext,
  WindowRole
} from './window'
import type { RendererLogPayload } from './logging'
import type { WorkspaceSearchRequest, WorkspaceSearchResponse } from './search'
import type {
  ActivateOrOpenWorkspaceResult,
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult,
  WorkspaceChangeEvent,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceInfo,
  WorkspaceMovedEntry
} from './workspace'
export type {
  ActivateOrOpenWorkspaceResult,
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult
} from './workspace'
import type {
  PersistedWorkspaceState,
  WorkspaceStateUpdate
} from './workspaceState'

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
  openInNewWindow: 'workspace:open-in-new-window',
  activateOrOpen: 'workspace:activate-or-open',
  focusIfOpen: 'workspace:focus-if-open',
  readDir: 'workspace:read-dir',
  listMarkdownFiles: 'workspace:list-markdown-files',
  search: 'workspace:search',
  readFile: 'workspace:read-file',
  writeFile: 'workspace:write-file',
  createEntry: 'workspace:create-entry',
  renameEntry: 'workspace:rename-entry',
  moveEntries: 'workspace:move-entries',
  deleteEntry: 'workspace:delete-entry',
  ingestImage: 'workspace:ingest-image',
  watch: 'workspace:watch',
  unwatch: 'workspace:unwatch',
  changed: 'workspace:changed'
} as const

export const WORKSPACE_STATE_IPC_CHANNELS = {
  get: 'workspace-state:get',
  save: 'workspace-state:save'
} as const

export const GIT_IPC_CHANNELS = {
  status: 'git:status',
  init: 'git:init',
  stage: 'git:stage',
  stageAll: 'git:stage-all',
  unstage: 'git:unstage',
  unstageAll: 'git:unstage-all',
  discard: 'git:discard',
  discardAll: 'git:discard-all',
  commit: 'git:commit',
  branches: 'git:branches',
  checkout: 'git:checkout',
  pull: 'git:pull',
  push: 'git:push',
  fetch: 'git:fetch',
  sync: 'git:sync',
  log: 'git:log',
  commitDetail: 'git:commit-detail',
  diff: 'git:diff',
  stashList: 'git:stash-list',
  stashDetail: 'git:stash-detail',
  stashCreate: 'git:stash-create',
  stashApply: 'git:stash-apply',
  stashPop: 'git:stash-pop',
  stashDrop: 'git:stash-drop',
  stashClear: 'git:stash-clear'
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
  prepareDiscardPaths: 'buffer:prepare-discard-paths',
  finishDiscardPaths: 'buffer:finish-discard-paths',
  clearWorkspaceBuffers: 'buffer:clear-workspace-buffers',
  event: 'buffer:event'
} as const

export const LOG_IPC_CHANNELS = {
  write: 'log:write'
} as const

export const CLIPBOARD_IPC_CHANNELS = {
  writeText: 'clipboard:write-text'
} as const

export const DIAGRAM_IPC_CHANNELS = {
  copyText: 'diagram:copy-text',
  copyImage: 'diagram:copy-image',
  saveFile: 'diagram:save-file'
} as const

export type DiagramExportFormat = 'png' | 'svg'

export interface DiagramSaveRequest {
  format: DiagramExportFormat
  suggestedName: string
  data: Uint8Array | string
}

export interface DiagramSaveResult {
  canceled: boolean
  filePath?: string
}

export const WINDOW_IPC_CHANNELS = {
  getInitContext: 'window:get-init-context',
  detachTabToNewWindow: 'window:detach-tab-to-new-window',
  startTabDrag: 'window:start-tab-drag',
  updateTabDragOutcome: 'window:update-tab-drag-outcome',
  acceptTabDragDrop: 'window:accept-tab-drag-drop',
  endTabDrag: 'window:end-tab-drag',
  dragStateChanged: 'window:drag-state-changed',
  closeCurrent: 'window:close-current',
  closeRequested: 'window:close-requested',
  resolveCloseRequest: 'window:resolve-close-request',
  setCloseFlushEnabled: 'window:set-close-flush-enabled'
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
  openInNewWindow?(rootPath: string): Promise<OpenWorkspaceInNewWindowResult>
  activateOrOpen?(rootPath: string): Promise<ActivateOrOpenWorkspaceResult>
  focusIfOpen?(rootPath: string): Promise<FocusOpenWorkspaceResult>
  readDir(dirPath?: string): Promise<WorkspaceEntry[]>
  listMarkdownFiles(): Promise<WorkspaceEntry[]>
  search?(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResponse>
  readFile(filePath: string): Promise<string>
  writeFile(filePath: string, content: string): Promise<void>
  createEntry(
    parentDirPath: string,
    name: string,
    kind: WorkspaceEntryKind,
    initialContent?: string
  ): Promise<WorkspaceEntry>
  renameEntry(targetPath: string, newName: string): Promise<WorkspaceEntry>
  moveEntries(sourcePaths: string[], targetDirPath: string): Promise<WorkspaceMovedEntry[]>
  deleteEntry(targetPath: string): Promise<void>
  ingestImage(input: WorkspaceImageIngestInput): Promise<WorkspaceImageIngestResult>
  getPathForFile(file: File): string
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
  discard(workspacePath: string, paths: string[]): Promise<GitStatus>
  discardAll(workspacePath: string): Promise<GitStatus>
  commit(workspacePath: string, message: string): Promise<GitStatus>
  branches(workspacePath: string): Promise<GitBranchList>
  checkout(workspacePath: string, branchName: string): Promise<GitStatus>
  pull(workspacePath: string): Promise<GitStatus>
  push(workspacePath: string): Promise<GitStatus>
  fetch(workspacePath: string): Promise<GitStatus>
  sync(workspacePath: string): Promise<GitSyncResult>
  log(workspacePath: string, options?: GitLogOptions): Promise<GitLogResult>
  commitDetail(workspacePath: string, commitHash: string): Promise<GitCommitDetail>
  diff(workspacePath: string, request: GitDiffRequest): Promise<GitFileDiff>
  stashList(workspacePath: string): Promise<GitStashEntry[]>
  stashDetail(workspacePath: string, stashRef: string): Promise<GitStashDetail>
  stashCreate(workspacePath: string, options: GitStashCreateOptions): Promise<GitStatus>
  stashApply(workspacePath: string, stashRef: string): Promise<GitStatus>
  stashPop(workspacePath: string, stashRef: string): Promise<GitStatus>
  stashDrop(workspacePath: string, stashRef: string): Promise<GitStashEntry[]>
  stashClear(workspacePath: string): Promise<GitStashEntry[]>
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
  reconcileWorkspaceBuffersWithDisk(
    changeEvent?: WorkspaceChangeEvent
  ): Promise<ReconcileBuffersResult>
  prepareDiscardPaths(targetPaths: readonly string[]): Promise<void>
  finishDiscardPaths(targetPaths: readonly string[], forceSync: boolean): Promise<string[]>
  clearWorkspaceBuffers(): Promise<string[]>
  onEvent(listener: (event: SharedBufferHubEvent) => void): () => void
}

export interface WikiLogApi {
  write(payload: RendererLogPayload): Promise<void>
}

export interface WikiClipboardApi {
  writeText(text: string): Promise<void>
}

export interface WikiDiagramApi {
  copyText(text: string): Promise<void>
  copyImage(pngBytes: Uint8Array): Promise<void>
  saveFile(request: DiagramSaveRequest): Promise<DiagramSaveResult>
}

export interface WikiWindowApi {
  readonly role: WindowRole
  getInitContext(): Promise<WindowInitContext>
  detachTabToNewWindow(payload: TabTransferPayload): Promise<DetachTabToNewWindowResult>
  startTabDrag(input: TabDragStartInput): Promise<ActiveTabDragSession>
  updateTabDragOutcome(
    dragSessionId: string,
    outcome: TabDragResolution
  ): Promise<ActiveTabDragSession | null>
  acceptTabDragDrop(input?: AcceptTabDragDropInput): Promise<AcceptTabDragDropResult>
  endTabDrag(input: TabDragEndInput): Promise<TabDragEndResult>
  onTabDragStateChanged(listener: (session: ActiveTabDragSession | null) => void): () => void
  closeCurrent(): Promise<void>
  onCloseRequested(listener: () => void): () => void
  resolveCloseRequest(approved: boolean): Promise<void>
  setCloseFlushEnabled?(enabled: boolean): Promise<void>
}

export interface WikiWorkspaceStateApi {
  get(rootPath: string): Promise<PersistedWorkspaceState | null>
  save(rootPath: string, update: WorkspaceStateUpdate): Promise<PersistedWorkspaceState>
}

export interface WikiApi {
  config: WikiConfigApi
  workspace: WikiWorkspaceApi
  workspaceState?: WikiWorkspaceStateApi
  git: WikiGitApi
  menu: WikiMenuApi
  buffer: WikiBufferApi
  log?: WikiLogApi
  clipboard?: WikiClipboardApi
  window?: WikiWindowApi
  diagram?: WikiDiagramApi
}
