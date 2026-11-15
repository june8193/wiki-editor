import { CLIPBOARD_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface RegisterClipboardIpcOptions {
  ipcMain: IpcMainLike
  writeClipboardText: (text: string) => void
  logService?: LogService
}

/**
 * Registers the clipboard:write-text IPC handler for writing text to the OS clipboard.
 */
export function registerClipboardIpc({
  ipcMain,
  writeClipboardText,
  logService
}: RegisterClipboardIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      CLIPBOARD_IPC_CHANNELS.writeText,
      (_event, text) => {
        if (typeof text !== 'string') {
          throw new Error('클립보드에 복사할 텍스트가 올바르지 않습니다.')
        }
        writeClipboardText(text)
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
