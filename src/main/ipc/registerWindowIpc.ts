import { WINDOW_IPC_CHANNELS, type WindowCloseResponse } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import type { WindowCloseCoordinator } from '../window'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface RegisterWindowIpcOptions {
  ipcMain: IpcMainLike
  coordinator: Pick<WindowCloseCoordinator, 'handleCloseResponse'>
  logService?: LogService
}

function isWindowCloseResponse(value: unknown): value is WindowCloseResponse {
  return value === 'confirming' || value === 'close' || value === 'cancel'
}

/**
 * Registers the window:close-response IPC handler to forward close confirmation decisions
 * back to the main-process window close coordinator.
 */
export function registerWindowIpc({
  ipcMain,
  coordinator,
  logService
}: RegisterWindowIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      WINDOW_IPC_CHANNELS.closeResponse,
      (event, response) => {
        if (!isWindowCloseResponse(response)) {
          throw new Error('창 종료 응답 형식이 올바르지 않습니다.')
        }
        const sender =
          typeof event === 'object' && event !== null && 'sender' in event
            ? (event as { sender?: unknown }).sender
            : undefined
        coordinator.handleCloseResponse(sender, response)
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
