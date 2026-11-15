import type { AutoSaveConfig } from '@shared/bufferAutoSaveScheduler'
import { BUFFER_IPC_CHANNELS } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  type IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents,
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

export type RegisterBufferIpcDependencies = {
  ipcMain: IpcMainLike
  configService: ConfigService
  getTargets: () => BufferWebContentsLike[]
  logService?: LogService
} & (
  | { hub: SharedDocumentBufferHub }
  | { workspaceService: WorkspaceFsService; initialAutoSaveConfig?: AutoSaveConfig }
)

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
 * to all active renderer BrowserWindow targets.
 */
export function registerBufferIpc(deps: RegisterBufferIpcDependencies): () => void {
  const { ipcMain, configService, getTargets, logService } = deps
  let disposed = false
  const initialAutoSaveConfig = 'hub' in deps ? undefined : deps.initialAutoSaveConfig

  const hub =
    'hub' in deps
      ? deps.hub
      : createSharedDocumentBufferHub({
          workspaceService: deps.workspaceService,
          configService,
          logService,
          initialAutoSaveConfig
        })

  const resolveWindowId = (event: unknown): number | undefined => {
    const sender = resolveSenderWebContents<BufferWebContentsLike>(event)
    return sender ? trackHubWindowWebContents(hub, sender) : undefined
  }

  let hasConfigUpdate = false
  const unsubscribeConfig = configService.onChanged((config) => {
    hasConfigUpdate = true
    hub.setAutoSaveConfig({
      autoSave: config.autoSave,
      autoSaveDelayMs: config.autoSaveDelayMs
    })
  })

  if (
    !('hub' in deps) &&
    (initialAutoSaveConfig?.autoSave === undefined ||
      initialAutoSaveConfig?.autoSaveDelayMs === undefined)
  ) {
    void configService.get().then(
      (config) => {
        if (!disposed && !hasConfigUpdate) {
          hub.setAutoSaveConfig({
            autoSave: initialAutoSaveConfig?.autoSave ?? config.autoSave,
            autoSaveDelayMs: initialAutoSaveConfig?.autoSaveDelayMs ?? config.autoSaveDelayMs
          })
        }
      },
      () => undefined
    )
  }

  const unsubscribeHub = hub.subscribe((hubEvent) => {
    broadcastIpcEvent(getTargets, BUFFER_IPC_CHANNELS.event, hubEvent)
  })

  const unregisterHandlers = registerIpcHandlers(
    ipcMain,
    [
      [BUFFER_IPC_CHANNELS.getSnapshot, (event) => hub.getSnapshot(resolveWindowId(event))],
      [
        BUFFER_IPC_CHANNELS.openWorkspaceFile,
        (event, filePath, name, initialContent) =>
          hub.openWorkspaceFile(
            filePath as string,
            name as string | undefined,
            initialContent as string | undefined,
            resolveWindowId(event)
          )
      ],
      [
        BUFFER_IPC_CHANNELS.openConfigDocument,
        (event) => hub.openConfigDocument(resolveWindowId(event))
      ],
      [BUFFER_IPC_CHANNELS.refreshCleanConfig, () => hub.refreshCleanConfig()],
      [
        BUFFER_IPC_CHANNELS.updateContent,
        (_event, key, nextContent) => hub.updateContent(key as string, nextContent as string)
      ],
      [BUFFER_IPC_CHANNELS.saveBuffer, (_event, key) => hub.saveBuffer(key as string)],
      [
        BUFFER_IPC_CHANNELS.syncWindowTabs,
        (event, bufferKeys, options) => {
          const windowId = resolveWindowId(event)
          const releasePending = Boolean(
            options &&
              typeof options === 'object' &&
              (options as { releasePending?: unknown }).releasePending
          )
          return windowId !== undefined
            ? hub.syncWindowTabs(
                windowId,
                Array.isArray(bufferKeys) ? (bufferKeys as string[]) : [],
                releasePending ? { releasePending: true } : undefined
              )
            : hub.getSnapshot()
        }
      ],
      [
        BUFFER_IPC_CHANNELS.setAutoSavePaused,
        (event, paused) => {
          const windowId = resolveWindowId(event)
          if (windowId !== undefined) {
            hub.setAutoSavePaused(windowId, Boolean(paused))
          }
        }
      ],
      [
        BUFFER_IPC_CHANNELS.syncRenamedPath,
        (_event, oldPath, newPath) => hub.syncRenamedPath(oldPath as string, newPath as string)
      ],
      [
        BUFFER_IPC_CHANNELS.syncDeletedPath,
        (_event, targetPath) => hub.syncDeletedPath(targetPath as string)
      ],
      [
        BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk,
        () => hub.reconcileWorkspaceBuffersWithDisk()
      ]
    ],
    { logService }
  )

  return () => {
    disposed = true
    unsubscribeHub()
    unsubscribeConfig()
    hub.dispose()
    unregisterHandlers()
  }
}
