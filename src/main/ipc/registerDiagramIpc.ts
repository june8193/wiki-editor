import { types } from 'node:util'
import { DIAGRAM_IPC_CHANNELS } from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface NativeImageLike {
  isEmpty(): boolean
}

export interface RegisterDiagramIpcOptions<TImage extends NativeImageLike = NativeImageLike> {
  ipcMain: IpcMainLike
  writeClipboardText: (text: string) => void | Promise<void>
  createImageFromBuffer: (buffer: Buffer) => TImage
  writeClipboardImage: (image: TImage) => void | Promise<void>
  logService?: LogService
}

/**
 * Registers diagram:* IPC handlers for clipboard text and PNG image writes with strict input validation.
 */
export function registerDiagramIpc<TImage extends NativeImageLike = NativeImageLike>({
  ipcMain,
  writeClipboardText,
  createImageFromBuffer,
  writeClipboardImage,
  logService
}: RegisterDiagramIpcOptions<TImage>): () => void {
  const handlers: readonly IpcHandlerTuple[] = [
    [
      DIAGRAM_IPC_CHANNELS.copyText,
      async (_event, text) => {
        if (typeof text !== 'string') {
          throw new TypeError('클립보드에 복사할 다이어그램 코드는 문자열이어야 합니다.')
        }
        await writeClipboardText(text)
      }
    ],
    [
      DIAGRAM_IPC_CHANNELS.copyImage,
      async (_event, pngBytes) => {
        if (!types.isUint8Array(pngBytes)) {
          throw new TypeError('클립보드에 복사할 다이어그램 이미지는 Uint8Array여야 합니다.')
        }
        if (pngBytes.byteLength === 0) {
          throw new Error('클립보드에 복사할 다이어그램 이미지 버퍼가 비어 있습니다.')
        }

        const buffer = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength)
        const image = createImageFromBuffer(buffer)
        if (!image || image.isEmpty()) {
          throw new Error('유효한 다이어그램 PNG 이미지를 생성할 수 없습니다.')
        }
        await writeClipboardImage(image)
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
