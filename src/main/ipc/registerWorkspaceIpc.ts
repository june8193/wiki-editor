import type { WorkspaceImageIngestInput } from '@shared/assets'
import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceSearchRequest } from '@shared/search'
import type {
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult,
  WorkspaceEntryKind,
  WorkspaceInfo
} from '@shared/workspace'
import type { WorkspaceQueryAndSchemaHub } from '@shared/workspaceQueryAndSchema'
import { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  IpcHandlerTuple,
  IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
  WebContentsLike
} from './ipcHelpers'

export interface WorkspaceIpcSession {
  workspaceService: WorkspaceFsService
  queryAndSchemaHub: WorkspaceQueryAndSchemaHub
  getTargets: () => WebContentsLike[]
  isMainWindow: (sender: WebContentsLike | undefined) => boolean
}

export interface WorkspaceIpcCoordinator {
  resolveSession: (sender: WebContentsLike | undefined) => WorkspaceIpcSession | undefined
  openWorkspaceInSession: (
    sender: WebContentsLike | undefined,
    rootPath: string
  ) => Promise<WorkspaceInfo>
  openWorkspaceInNewWindow?: (
    sender: WebContentsLike | undefined,
    rootPath: string
  ) => Promise<OpenWorkspaceInNewWindowResult>
  focusWorkspaceIfOpen?: (
    sender: WebContentsLike | undefined,
    rootPath: string
  ) => Promise<FocusOpenWorkspaceResult>
  onSessionDisposed?: (listener: (session: WorkspaceIpcSession) => void) => () => void
}

export interface RegisterWorkspaceIpcOptions {
  ipcMain: IpcMainLike
  configService: ConfigService
  selectDirectory: (sender?: WebContentsLike) => Promise<string | null>
  coordinator: WorkspaceIpcCoordinator
  logService?: LogService
}

/**
 * Registers workspace:* IPC handlers and broadcasts filesystem watch updates to each session's live renderers.
 */
export function registerWorkspaceIpc({
  ipcMain,
  configService,
  selectDirectory,
  coordinator,
  logService
}: RegisterWorkspaceIpcOptions): () => void {
  const watchersByService = new Map<WorkspaceFsService, () => void>()

  const clearWatcher = (targetService: WorkspaceFsService): void => {
    watchersByService.get(targetService)?.()
    watchersByService.delete(targetService)
    targetService.unwatch()
  }

  const clearAllWatchers = (): void => {
    for (const service of Array.from(watchersByService.keys())) {
      clearWatcher(service)
    }
  }

  const unsubscribeSessionDisposed = coordinator.onSessionDisposed?.((session) => {
    clearWatcher(session.workspaceService)
  })

  const requireSession = (event: unknown): WorkspaceIpcSession => {
    const sender = resolveSenderWebContents(event)
    const session = coordinator.resolveSession(sender)
    if (!session) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return session
  }

  const resolveMainSession = (
    event: unknown
  ): { sender: WebContentsLike | undefined; session: WorkspaceIpcSession } | undefined => {
    const sender = resolveSenderWebContents(event)
    const session = coordinator.resolveSession(sender)
    if (!session || !session.isMainWindow(sender)) {
      return undefined
    }
    return { sender, session }
  }

  const requireMainSession = (
    event: unknown
  ): { sender: WebContentsLike | undefined; session: WorkspaceIpcSession } => {
    const resolved = resolveMainSession(event)
    if (!resolved) {
      throw new Error('Only the main window can open a workspace')
    }
    return resolved
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [WORKSPACE_IPC_CHANNELS.selectFolder, (event) => selectDirectory(resolveSenderWebContents(event))],
    [
      WORKSPACE_IPC_CHANNELS.open,
      async (event, rootPath) => {
        const { sender, session } = requireMainSession(event)
        const info = await coordinator.openWorkspaceInSession(sender, rootPath as string)
        watchersByService.delete(session.workspaceService)
        await configService.recordRecentWorkspace(info.rootPath)
        return info
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      (event, rootPath) => {
        const { sender } = requireMainSession(event)
        if (!coordinator.openWorkspaceInNewWindow) {
          throw new Error('Multi-window workspace opening is not configured')
        }
        return coordinator.openWorkspaceInNewWindow(sender, rootPath as string)
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.focusIfOpen,
      (event, rootPath) => {
        const { sender } = requireMainSession(event)
        return coordinator.focusWorkspaceIfOpen
          ? coordinator.focusWorkspaceIfOpen(sender, rootPath as string)
          : { focused: false }
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.readDir,
      (event, dirPath) => requireSession(event).workspaceService.readDir(dirPath as string | undefined)
    ],
    [
      WORKSPACE_IPC_CHANNELS.listMarkdownFiles,
      (event) => requireSession(event).workspaceService.listMarkdownFiles()
    ],
    [
      WORKSPACE_IPC_CHANNELS.search,
      (event, request) =>
        requireSession(event).queryAndSchemaHub.search(request as WorkspaceSearchRequest)
    ],
    [
      WORKSPACE_IPC_CHANNELS.readFile,
      (event, filePath) => requireSession(event).workspaceService.readFile(filePath as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.writeFile,
      (event, filePath, content) =>
        requireSession(event).workspaceService.writeFile(filePath as string, content as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.createEntry,
      (event, parentDirPath, name, kind, initialContent) =>
        requireSession(event).workspaceService.createEntry(
          parentDirPath as string,
          name as string,
          kind as WorkspaceEntryKind,
          initialContent as string | undefined
        )
    ],
    [
      WORKSPACE_IPC_CHANNELS.renameEntry,
      (event, targetPath, newName) =>
        requireSession(event).workspaceService.renameEntry(
          targetPath as string,
          newName as string
        )
    ],
    [
      WORKSPACE_IPC_CHANNELS.moveEntries,
      (event, sourcePaths, targetDirPath) =>
        requireSession(event).workspaceService.moveEntries(
          sourcePaths as string[],
          targetDirPath as string
        )
    ],
    [
      WORKSPACE_IPC_CHANNELS.deleteEntry,
      (event, targetPath) =>
        requireSession(event).workspaceService.deleteEntry(targetPath as string)
    ],
    [
      WORKSPACE_IPC_CHANNELS.ingestImage,
      (event, input) =>
        requireSession(event).workspaceService.ingestImage(input as WorkspaceImageIngestInput)
    ],
    [
      WORKSPACE_IPC_CHANNELS.watch,
      (event) => {
        const resolved = resolveMainSession(event)
        if (!resolved) {
          return
        }
        const { session } = resolved
        if (!watchersByService.has(session.workspaceService)) {
          const stop = session.workspaceService.watch((changeEvent) => {
            broadcastIpcEvent(session.getTargets, WORKSPACE_IPC_CHANNELS.changed, changeEvent)
          })
          watchersByService.set(session.workspaceService, stop)
        }
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.unwatch,
      (event) => {
        const resolved = resolveMainSession(event)
        if (!resolved) {
          return
        }
        clearWatcher(resolved.session.workspaceService)
      }
    ]
  ]

  const removeHandlers = registerIpcHandlers(ipcMain, handlers, { logService })

  return () => {
    unsubscribeSessionDisposed?.()
    clearAllWatchers()
    removeHandlers()
  }
}
