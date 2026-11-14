import { LOG_IPC_CHANNELS } from '@shared/ipc'
import {
  LOG_CATEGORIES,
  LOG_LEVELS,
  type LogCategory,
  type LogLevel,
  sanitizeLogData
} from '@shared/logging'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function isLogCategory(value: unknown): value is LogCategory {
  return typeof value === 'string' && (LOG_CATEGORIES as readonly string[]).includes(value)
}

function parseRendererPayload(
  payload: unknown
): {
  level: LogLevel
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  error?: unknown
} | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null
  }
  const candidate = payload as Record<string, unknown>
  if (typeof candidate.message !== 'string' || candidate.message.trim().length === 0) {
    return null
  }

  return {
    level: isLogLevel(candidate.level) ? candidate.level : 'info',
    category: isLogCategory(candidate.category) ? candidate.category : 'ui',
    message: candidate.message,
    data: sanitizeLogData(candidate.data),
    ...(candidate.error !== undefined ? { error: candidate.error } : {})
  }
}

/**
 * Registers the log:write IPC handler for forwarding sanitized renderer logs into LogService.
 */
export function registerLogIpc(ipcMain: IpcMainLike, logService: LogService): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      LOG_IPC_CHANNELS.write,
      async (_event, payload) => {
        const parsed = parseRendererPayload(payload)
        if (!parsed) return
        await logService.write({
          ...parsed,
          process: 'renderer'
        })
      }
    ]
  ]

  // Intentionally omit logService from registerIpcHandlers to avoid recursive IPC audit logs on log:write.
  return registerIpcHandlers(ipcMain, handlers)
}
