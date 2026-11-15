import { BUFFER_IPC_CHANNELS } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type { ConfigService } from '../config/ConfigService'
import type { LogService } from '../logging/LogService'
import type { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import {
  broadcastIpcEvent,
  type IpcMainLike,
  registerIpcHandlers,
  type WebContentsLike
} from './ipcHelpers'

export interface BufferWebContentsLike extends WebContentsLike {
  id?: number
  once?: (eventName: 'destroyed', listener: () => void) => void
}

export interface RegisterBufferIpcDependencies {
  ipcMain: IpcMainLike
  workspaceService: WorkspaceFsService
  configService: ConfigService
  getTargets: () => BufferWebContentsLike[]
  logService?: LogService
  initialAutoSave?: boolean
  initialAutoSaveDelayMs?: number
}

interface IpcEventWithSender {
  sender?: BufferWebContentsLike
}

function resolveSenderWebContents(event: unknown): BufferWebContentsLike | undefined {
  if (!event || typeof event !== 'object') return undefined
  const sender = (event as IpcEventWithSender).sender
  if (!sender || typeof sender !== 'object') return undefined
  return sender
}

/**
 * Registers main-process IPC handlers for shared document buffers and broadcasts hub updates
 * to all active renderer BrowserWindow targets.
 */
export function registerBufferIpc({
  ipcMain,
  workspaceService,
  configService,
  getTargets,
  logService,
  initialAutoSave,
  initialAutoSaveDelayMs
}: RegisterBufferIpcDependencies): () => void {
  let disposed = false
  let fallbackWindowId = 1
  const trackedSenders = new WeakMap<object, number>()

  const hub = new SharedDocumentBufferHub({
    initialAutoSave,
    initialAutoSaveDelayMs,
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

  const resolveWindowId = (event: unknown): number | undefined => {
    const sender = resolveSenderWebContents(event)
    if (!sender) return undefined

    const existingId = trackedSenders.get(sender)
    if (existingId !== undefined) {
      return existingId
    }

    const windowId = typeof sender.id === 'number' ? sender.id : fallbackWindowId++
    trackedSenders.set(sender, windowId)
    sender.once?.('destroyed', () => {
      hub.unregisterWindow(windowId)
    })
    return windowId
  }

  let hasConfigUpdate = false
  const unsubscribeConfig = configService.onChanged((config) => {
    hasConfigUpdate = true
    hub.setAutoSaveConfig({
      autoSave: config.autoSave,
      autoSaveDelayMs: config.autoSaveDelayMs
    })
  })

  if (initialAutoSave === undefined || initialAutoSaveDelayMs === undefined) {
    void configService.get().then(
      (config) => {
        if (!disposed && !hasConfigUpdate) {
          hub.setAutoSaveConfig({
            autoSave: initialAutoSave ?? config.autoSave,
            autoSaveDelayMs: initialAutoSaveDelayMs ?? config.autoSaveDelayMs
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
        (event, bufferKeys) => {
          const windowId = resolveWindowId(event)
          return windowId !== undefined
            ? hub.syncWindowTabs(
                windowId,
                Array.isArray(bufferKeys) ? (bufferKeys as string[]) : []
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
