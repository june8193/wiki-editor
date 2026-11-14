import { CONFIG_IPC_CHANNELS, LOG_IPC_CHANNELS, WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export type IpcHandlerTuple = readonly [
  string,
  (event: unknown, ...args: unknown[]) => unknown
]

export interface RegisterIpcHandlersOptions {
  logService?: LogService
}

const CHANNEL_METADATA_EXTRACTORS: Record<string, (args: unknown[]) => Record<string, unknown>> = {
  [WORKSPACE_IPC_CHANNELS.writeFile]: ([filePath, content]) => ({
    filePath,
    contentLength: typeof content === 'string' ? content.length : 0
  }),
  [WORKSPACE_IPC_CHANNELS.createEntry]: ([parentDirPath, name, kind, initialContent]) => ({
    parentDirPath,
    name,
    kind,
    contentLength: typeof initialContent === 'string' ? initialContent.length : 0
  }),
  [CONFIG_IPC_CHANNELS.saveRaw]: ([raw]) => ({
    contentLength: typeof raw === 'string' ? raw.length : 0
  })
}

function extractIpcMetadata(channel: string, args: unknown[]): Record<string, unknown> {
  const extractor = CHANNEL_METADATA_EXTRACTORS[channel]
  if (extractor) {
    return extractor(args)
  }
  return args.length > 0 ? { args } : {}
}

function wrapIpcHandler(
  channel: string,
  handler: (event: unknown, ...args: unknown[]) => unknown,
  logService?: LogService
): (event: unknown, ...args: unknown[]) => unknown {
  if (!logService || channel === LOG_IPC_CHANNELS.write) {
    return handler
  }

  return async (event: unknown, ...args: unknown[]) => {
    const startedAt = performance.now()
    const metadata = extractIpcMetadata(channel, args)
    const logOutcome = (success: boolean, error?: unknown): Promise<void> => {
      const data = {
        channel,
        success,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...metadata
      }
      return success
        ? logService.info('ipc', `IPC ${channel}`, { data })
        : logService.error('ipc', `IPC ${channel} failed`, { data, error })
    }

    try {
      const result = await handler(event, ...args)
      await logOutcome(true)
      return result
    } catch (error) {
      await logOutcome(false, error)
      throw error
    }
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: readonly IpcHandlerTuple[],
  options: RegisterIpcHandlersOptions = {}
): () => void {
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, wrapIpcHandler(channel, handler, options.logService))
  }

  return () => {
    for (const [channel] of handlers) {
      ipcMain.removeHandler(channel)
    }
  }
}

export function broadcastIpcEvent(
  getTargets: () => WebContentsLike[],
  channel: string,
  payload: unknown
): void {
  for (const target of getTargets()) {
    if (!target.isDestroyed()) {
      target.send(channel, payload)
    }
  }
}
