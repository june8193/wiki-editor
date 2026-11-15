import { DIAGRAM_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface RegisterDiagramIpcOptions {
  ipcMain: IpcMainLike
  writeClipboardText: (text: string) => void | Promise<void>
  logService?: LogService
}

/**
 * Registers diagram:* IPC handlers for clipboard text writes with strict input validation.
 */
export function registerDiagramIpc({
  ipcMain,
  writeClipboardText,
  logService
}: RegisterDiagramIpcOptions): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      DIAGRAM_IPC_CHANNELS.copyText,
      async (_event, text) => {
        if (typeof text !== 'string') {
          throw new TypeError('클립보드에 복사할 다이어그램 코드는 문자열이어야 합니다.')
        }
        await writeClipboardText(text)
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
