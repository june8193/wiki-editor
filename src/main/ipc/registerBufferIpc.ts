import type { AutoSaveConfig } from '@shared/bufferAutoSaveScheduler'
import { BUFFER_IPC_CHANNELS } from '@shared/ipc'
import {
  EMPTY_SHARED_BUFFER_SNAPSHOT,
  type SharedBufferStateSnapshot,
  type SyncWindowTabsOptions
} from '@shared/documentBuffer'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type { WorkspaceChangeEvent } from '@shared/workspace'
import type { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  type IpcMainLike,
  type IpcSessionSource,
  registerIpcHandlers,
  resolveSenderWebContents,
  subscribeIpcSessions,
  type WebContentsLike
} from './ipcHelpers'

export interface BufferWebContentsLike extends WebContentsLike {
  id?: number
  once?: (eventName: 'destroyed', listener: () => void) => void
}

export interface CreateSharedDocumentBufferHubDependencies {
  workspaceService: WorkspaceFsService
  configService: ConfigService
  logService?: LogService
  initialAutoSaveConfig?: AutoSaveConfig
}

export interface BufferIpcSession {
  hub: SharedDocumentBufferHub
  getTargets: () => BufferWebContentsLike[]
  resolveWindowId?: (sender: BufferWebContentsLike | undefined) => number | undefined
  syncWindowTabs?: (
    windowId: number,
    bufferKeys: readonly string[],
    options?: SyncWindowTabsOptions
  ) => SharedBufferStateSnapshot
}

export type BufferIpcSessionSource = IpcSessionSource<BufferIpcSession, BufferWebContentsLike>

export interface RegisterBufferIpcDependencies {
  ipcMain: IpcMainLike
  configService: ConfigService
  sessionSource: BufferIpcSessionSource
  logService?: LogService
}

let nextFallbackHubWindowId = 1
const assignedHubWindowIds = new WeakMap<object, number>()
const registeredHubTeardowns = new WeakMap<SharedDocumentBufferHub, WeakSet<object>>()

/**
 * Resolves a stable hub window identifier for a BrowserWindow WebContents and binds
 * automatic hub cleanup when that WebContents is destroyed.
 */
export function trackHubWindowWebContents(
  hub: SharedDocumentBufferHub,
  webContents: BufferWebContentsLike,
  fallbackId?: number
): number {
  let windowId = assignedHubWindowIds.get(webContents)
  if (windowId === undefined) {
    windowId =
      typeof webContents.id === 'number'
        ? webContents.id
        : typeof fallbackId === 'number'
          ? fallbackId
          : nextFallbackHubWindowId++
    assignedHubWindowIds.set(webContents, windowId)
  }

  let hubSenders = registeredHubTeardowns.get(hub)
  if (!hubSenders) {
    hubSenders = new WeakSet<object>()
    registeredHubTeardowns.set(hub, hubSenders)
  }
  if (!hubSenders.has(webContents)) {
    hubSenders.add(webContents)
    const trackedWindowId = windowId
    webContents.once?.('destroyed', () => {
      hub.unregisterWindow(trackedWindowId)
    })
  }

  return windowId
}

/**
 * Creates the main-process SharedDocumentBufferHub backed by workspace and config storage.
 */
export function createSharedDocumentBufferHub({
  workspaceService,
  configService,
  logService,
  initialAutoSaveConfig
}: CreateSharedDocumentBufferHubDependencies): SharedDocumentBufferHub {
  return new SharedDocumentBufferHub({
    initialAutoSaveConfig,
    storage: {
      readWorkspaceFile: (filePath) => workspaceService.readFile(filePath),
      writeWorkspaceFile: (filePath, content) => workspaceService.writeFile(filePath, content),
      readWorkspaceDirectory: (dirPath) => workspaceService.readDir(dirPath),
      getConfigPath: () => Promise.resolve(configService.getConfigPath()),
      readConfigRaw: () => configService.readRaw(),
      saveConfigRaw: (raw) => configService.saveRaw(raw)
    },
    logError: (message, details) => {
      void logService?.error('ipc', message, { data: details })
    }
  })
}

/**
 * Registers main-process IPC handlers for shared document buffers and broadcasts hub updates
 * to each session's active renderer BrowserWindow targets.
 */
export function registerBufferIpc({
  ipcMain,
  configService,
  sessionSource,
  logService
}: RegisterBufferIpcDependencies): () => void {
  const resolveContext = (
    event: unknown
  ): { session: BufferIpcSession; windowId: number | undefined } | undefined => {
    const sender = resolveSenderWebContents<BufferWebContentsLike>(event)
    const session = sessionSource.resolveSession(sender)
    if (!session) return undefined
    const windowId = session.resolveWindowId
      ? session.resolveWindowId(sender)
      : sender
        ? trackHubWindowWebContents(session.hub, sender)
        : undefined
    return { session, windowId }
  }

  const requireContext = (
    event: unknown
  ): { session: BufferIpcSession; windowId: number | undefined } => {
    const ctx = resolveContext(event)
    if (!ctx) {
      throw new Error('Unknown window session')
    }
    return ctx
  }

  const unsubscribeSessions = subscribeIpcSessions(
    sessionSource,
    (session) => session.hub,
    (session) =>
      session.hub.subscribe((hubEvent) => {
        broadcastIpcEvent(session.getTargets, BUFFER_IPC_CHANNELS.event, hubEvent)
      })
  )

  const unsubscribeConfig = configService.onChanged((config) => {
    sessionSource.forEachSession((session) => {
      session.hub.setAutoSaveConfig({
        autoSave: config.autoSave,
        autoSaveDelayMs: config.autoSaveDelayMs
      })
      void session.hub.refreshCleanConfig().catch(() => undefined)
    })
  })

  const unregisterHandlers = registerIpcHandlers(
    ipcMain,
    [
      [
        BUFFER_IPC_CHANNELS.getSnapshot,
        (event) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.getSnapshot(ctx.windowId) : EMPTY_SHARED_BUFFER_SNAPSHOT
        }
      ],
      [
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        (event, filePath, name, initialContent) => {
          const ctx = requireContext(event)
          return ctx.session.hub.openWorkspaceFile(
            filePath as string,
            name as string | undefined,
            initialContent as string | undefined,
            ctx.windowId
          )
        }
      ],
      [
        BUFFER_IPC_CHANNELS.openConfigDocument,
        (event) => {
          const ctx = requireContext(event)
          return ctx.session.hub.openConfigDocument(ctx.windowId)
        }
      ],
      [
        BUFFER_IPC_CHANNELS.refreshCleanConfig,
        (event) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.refreshCleanConfig() : null
        }
      ],
      [
        BUFFER_IPC_CHANNELS.updateContent,
        (event, key, nextContent) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.updateContent(key as string, nextContent as string) : null
        }
      ],
      [
        BUFFER_IPC_CHANNELS.saveBuffer,
        (event, key) => {
          const ctx = resolveContext(event)
          return ctx
            ? ctx.session.hub.saveBuffer(key as string)
            : { ok: false, buffer: null }
        }
      ],
      [
        BUFFER_IPC_CHANNELS.syncWindowTabs,
        (event, bufferKeys, options) => {
          const ctx = resolveContext(event)
          if (!ctx) {
            return EMPTY_SHARED_BUFFER_SNAPSHOT
          }
          const releasePending = Boolean(
            options &&
              typeof options === 'object' &&
              (options as { releasePending?: unknown }).releasePending
          )
          if (ctx.windowId === undefined) {
            return ctx.session.hub.getSnapshot()
          }
          const bufferKeyList = Array.isArray(bufferKeys) ? (bufferKeys as string[]) : []
          const syncOptions = releasePending ? { releasePending: true } : undefined
          return ctx.session.syncWindowTabs
            ? ctx.session.syncWindowTabs(ctx.windowId, bufferKeyList, syncOptions)
            : ctx.session.hub.syncWindowTabs(ctx.windowId, bufferKeyList, syncOptions)
        }
      ],
      [
        BUFFER_IPC_CHANNELS.setAutoSavePaused,
        (event, paused) => {
          const ctx = resolveContext(event)
          if (ctx && ctx.windowId !== undefined) {
            ctx.session.hub.setAutoSavePaused(ctx.windowId, Boolean(paused))
          }
        }
      ],
      [
        BUFFER_IPC_CHANNELS.syncRenamedPath,
        (event, oldPath, newPath) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.syncRenamedPath(oldPath as string, newPath as string) : []
        }
      ],
      [
        BUFFER_IPC_CHANNELS.syncDeletedPath,
        (event, targetPath) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.syncDeletedPath(targetPath as string) : []
        }
      ],
      [
        BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk,
        (event, changeEvent) => {
          const ctx = resolveContext(event)
          return ctx
            ? ctx.session.hub.reconcileWorkspaceBuffersWithDisk(
                changeEvent as WorkspaceChangeEvent | undefined
              )
            : { warnings: [], closedKeys: [] }
        }
      ],
      [
        BUFFER_IPC_CHANNELS.prepareDiscardPaths,
        (event, targetPaths) => {
          const ctx = resolveContext(event)
          if (!ctx) return undefined
          return ctx.session.hub.prepareWorkspacePathsForDiscard(
            Array.isArray(targetPaths) ? (targetPaths as string[]) : []
          )
        }
      ],
      [
        BUFFER_IPC_CHANNELS.finishDiscardPaths,
        (event, targetPaths, forceSync) => {
          const ctx = resolveContext(event)
          return ctx
            ? ctx.session.hub.finishWorkspacePathsDiscard(
                Array.isArray(targetPaths) ? (targetPaths as string[]) : [],
                Boolean(forceSync)
              )
            : []
        }
      ],
      [
        BUFFER_IPC_CHANNELS.clearWorkspaceBuffers,
        (event) => {
          const ctx = resolveContext(event)
          return ctx ? ctx.session.hub.clearWorkspaceBuffers() : []
        }
      ]
    ],
    { logService }
  )

  return () => {
    unsubscribeSessions()
    unsubscribeConfig()
    unregisterHandlers()
  }
}
