import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import type { TabTransferPayload } from '@shared/window'
import type { LogService } from '../logging/LogService'
import type { WindowManager } from '../windowManager'
import {
  type IpcHandlerTuple,
  type IpcMainLike,
  registerIpcHandlers,
  resolveSenderWebContents
} from './ipcHelpers'

export interface RegisterWindowIpcOptions {
  ipcMain: IpcMainLike
  windowManager: WindowManager
  logService?: LogService
}

/**
 * Registers window:* IPC handlers for role discovery, auxiliary detachment, and zero-tab auto-closing.
 */
export function registerWindowIpc({
  ipcMain,
  windowManager,
  logService
}: RegisterWindowIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      WINDOW_IPC_CHANNELS.getInitContext,
      (event) => windowManager.getWindowInitContext(resolveSenderWebContents(event))
    ],
    [
      WINDOW_IPC_CHANNELS.detachTabToNewWindow,
      (event, payload) =>
        windowManager.detachTabToNewWindow(
          resolveSenderWebContents(event),
          payload as TabTransferPayload
        )
    ],
    [
      WINDOW_IPC_CHANNELS.closeCurrent,
      (event) => {
        windowManager.closeCurrentWindow(resolveSenderWebContents(event))
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
