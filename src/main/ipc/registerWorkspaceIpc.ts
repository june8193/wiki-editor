import type { WorkspaceImageIngestInput } from '@shared/assets'
import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { WorkspaceSearchRequest } from '@shared/search'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type {
  ActivateOrOpenWorkspaceResult,
  FocusOpenWorkspaceResult,
  OpenWorkspaceInNewWindowResult,
  WorkspaceEntryKind,
  WorkspaceInfo
} from '@shared/workspace'
import { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import { FrontmatterSchemaService } from '../workspace/FrontmatterSchemaService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import { WorkspaceSearchService } from '../workspace/WorkspaceSearchService'
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
  searchService: WorkspaceSearchService
  getTargets: () => WebContentsLike[]
  isMainWindow: (sender: WebContentsLike | undefined) => boolean
}

export interface WorkspaceIpcCoordinator {
  resolveSession: (sender: WebContentsLike | undefined) => WorkspaceIpcSession | undefined
  openWorkspaceInSession?: (
    sender: WebContentsLike | undefined,
    rootPath: string
  ) => Promise<WorkspaceInfo>
  activateOrOpenWorkspace?: (
    sender: WebContentsLike | undefined,
    rootPath: string
  ) => Promise<ActivateOrOpenWorkspaceResult>
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
  coordinator?: WorkspaceIpcCoordinator
  workspaceService?: WorkspaceFsService
  frontmatterSchemaService?: FrontmatterSchemaService
  bufferHub?: SharedDocumentBufferHub
  getTargets?: () => WebContentsLike[]
  isMainWindowSender?: (sender: WebContentsLike | undefined) => boolean
  logService?: LogService
}

/**
 * Registers workspace:* IPC handlers and broadcasts filesystem watch updates to each session's live renderers.
 */
export function registerWorkspaceIpc({
  ipcMain,
  workspaceService,
  frontmatterSchemaService,
  bufferHub,
  configService,
  selectDirectory,
  coordinator,
  getTargets,
  isMainWindowSender = () => true,
  logService
}: RegisterWorkspaceIpcOptions): () => void {
  const watchersByService = new Map<WorkspaceFsService, () => void>()
  let ownedSearchService: WorkspaceSearchService | undefined
  let ownedSchemaService: FrontmatterSchemaService | undefined

  let activeCoordinator: WorkspaceIpcCoordinator
  if (coordinator) {
    activeCoordinator = coordinator
  } else {
    if (!workspaceService || !getTargets) {
      throw new Error(
        'registerWorkspaceIpc requires either coordinator or workspaceService and getTargets'
      )
    }
    const effectiveSchemaService =
      frontmatterSchemaService ??
      (ownedSchemaService = new FrontmatterSchemaService({ workspaceService, logService }))
    ownedSearchService = new WorkspaceSearchService({
      workspaceService,
      frontmatterSchemaService: effectiveSchemaService,
      getOpenBuffers: bufferHub ? () => Object.values(bufferHub.getSnapshot().buffers) : () => []
    })
    const singleSession: WorkspaceIpcSession = {
      workspaceService,
      searchService: ownedSearchService,
      getTargets,
      isMainWindow: isMainWindowSender
    }
    activeCoordinator = {
      resolveSession: () => singleSession
    }
  }

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

  const unsubscribeSessionDisposed = activeCoordinator.onSessionDisposed?.((session) => {
    clearWatcher(session.workspaceService)
  })

  const requireSession = (event: unknown): WorkspaceIpcSession => {
    const sender = resolveSenderWebContents(event)
    const session = activeCoordinator.resolveSession(sender)
    if (!session) {
      throw new Error('열린 워크스페이스가 없습니다.')
    }
    return session
  }

  const resolveMainSession = (
    event: unknown
  ): { sender: WebContentsLike | undefined; session: WorkspaceIpcSession } | undefined => {
    const sender = resolveSenderWebContents(event)
    const session = activeCoordinator.resolveSession(sender)
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

  const finalizeOpenedWorkspace = async (
    session: WorkspaceIpcSession,
    info: WorkspaceInfo
  ): Promise<void> => {
    watchersByService.delete(session.workspaceService)
    await configService.recordRecentWorkspace(info.rootPath)
  }

  const openWorkspaceInFallbackSession = async (
    session: WorkspaceIpcSession,
    rootPath: string
  ): Promise<WorkspaceInfo> => {
    session.searchService.cancelAllScans()
    return session.workspaceService.openWorkspace(rootPath)
  }

  const handlers: readonly IpcHandlerTuple[] = [
    [WORKSPACE_IPC_CHANNELS.selectFolder, (event) => selectDirectory(resolveSenderWebContents(event))],
    [
      WORKSPACE_IPC_CHANNELS.open,
      async (event, rootPath) => {
        const { sender, session } = requireMainSession(event)
        const info = activeCoordinator.openWorkspaceInSession
          ? await activeCoordinator.openWorkspaceInSession(sender, rootPath as string)
          : await openWorkspaceInFallbackSession(session, rootPath as string)
        await finalizeOpenedWorkspace(session, info)
        return info
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.activateOrOpen,
      async (event, rootPath) => {
        const { sender, session } = requireMainSession(event)
        const result: ActivateOrOpenWorkspaceResult = activeCoordinator.activateOrOpenWorkspace
          ? await activeCoordinator.activateOrOpenWorkspace(sender, rootPath as string)
          : {
              status: 'opened',
              info: await openWorkspaceInFallbackSession(session, rootPath as string)
            }
        if (result.status === 'opened') {
          await finalizeOpenedWorkspace(session, result.info)
        }
        return result
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      (event, rootPath) => {
        const { sender } = requireMainSession(event)
        if (!activeCoordinator.openWorkspaceInNewWindow) {
          throw new Error('Multi-window workspace opening is not configured')
        }
        return activeCoordinator.openWorkspaceInNewWindow(sender, rootPath as string)
      }
    ],
    [
      WORKSPACE_IPC_CHANNELS.focusIfOpen,
      (event, rootPath) => {
        const { sender } = requireMainSession(event)
        return activeCoordinator.focusWorkspaceIfOpen
          ? activeCoordinator.focusWorkspaceIfOpen(sender, rootPath as string)
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
        requireSession(event).searchService.search(request as WorkspaceSearchRequest)
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
    ownedSearchService?.dispose()
    ownedSchemaService?.dispose()
    removeHandlers()
  }
}
