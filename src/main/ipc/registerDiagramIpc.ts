import { types } from 'node:util'
import { normalizeDiagramSuggestedFileName } from '@shared/diagram'
import {
  DIAGRAM_IPC_CHANNELS,
  type DiagramExportFormat,
  type DiagramSaveRequest,
  type DiagramSaveResult
} from '@shared/ipc'
import type { LogService } from '../logging/LogService'
import { type IpcHandlerTuple, type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

export interface NativeImageLike {
  isEmpty(): boolean
}

export interface SaveDiagramDialogFilter {
  name: string
  extensions: string[]
}

export interface SaveDiagramDialogOptions {
  defaultPath: string
  filters: SaveDiagramDialogFilter[]
}

export interface SaveDiagramDialogResult {
  canceled: boolean
  filePath?: string
}

export interface RegisterDiagramIpcOptions<TImage extends NativeImageLike = NativeImageLike> {
  ipcMain: IpcMainLike
  writeClipboardText: (text: string) => void | Promise<void>
  createImageFromBuffer: (buffer: Buffer) => TImage
  writeClipboardImage: (image: TImage) => void | Promise<void>
  showSaveDialog: (options: SaveDiagramDialogOptions) => Promise<SaveDiagramDialogResult>
  writeFile: (filePath: string, data: Buffer | string) => Promise<void>
  logService?: LogService
}

const SAVE_DIALOG_FILTERS: Record<DiagramExportFormat, SaveDiagramDialogFilter[]> = {
  png: [{ name: 'PNG Image', extensions: ['png'] }],
  svg: [{ name: 'SVG Image', extensions: ['svg'] }]
}

function toNonEmptyBuffer(value: unknown, targetDescription: string): Buffer {
  if (!types.isUint8Array(value)) {
    throw new TypeError(`${targetDescription}는 Uint8Array여야 합니다.`)
  }
  if (value.byteLength === 0) {
    throw new Error(`${targetDescription} 버퍼가 비어 있습니다.`)
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * Registers diagram:* IPC handlers for clipboard text/PNG writes and native file export with strict input validation.
 */
export function registerDiagramIpc<TImage extends NativeImageLike = NativeImageLike>({
  ipcMain,
  writeClipboardText,
  createImageFromBuffer,
  writeClipboardImage,
  showSaveDialog,
  writeFile,
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
        const buffer = toNonEmptyBuffer(pngBytes, '클립보드에 복사할 다이어그램 이미지')
        const image = createImageFromBuffer(buffer)
        if (!image || image.isEmpty()) {
          throw new Error('유효한 다이어그램 PNG 이미지를 생성할 수 없습니다.')
        }
        await writeClipboardImage(image)
      }
    ],
    [
      DIAGRAM_IPC_CHANNELS.saveFile,
      async (_event, request): Promise<DiagramSaveResult> => {
        if (!request || typeof request !== 'object') {
          throw new TypeError('다이어그램 저장 요청 형식이 올바르지 않습니다.')
        }

        const { format, suggestedName, data } = request as Partial<DiagramSaveRequest>
        if (format !== 'png' && format !== 'svg') {
          throw new TypeError('지원하지 않는 다이어그램 저장 포맷입니다.')
        }

        let writePayload: Buffer | string
        if (format === 'png') {
          writePayload = toNonEmptyBuffer(data, '저장할 PNG 다이어그램 데이터')
        } else {
          if (typeof data !== 'string') {
            throw new TypeError('저장할 SVG 다이어그램 데이터는 문자열이어야 합니다.')
          }
          if (data.trim().length === 0) {
            throw new Error('저장할 SVG 다이어그램 마크업이 비어 있습니다.')
          }
          writePayload = data
        }

        const defaultPath = normalizeDiagramSuggestedFileName(suggestedName, format)
        const dialogResult = await showSaveDialog({
          defaultPath,
          filters: SAVE_DIALOG_FILTERS[format]
        })

        if (dialogResult.canceled || !dialogResult.filePath) {
          return { canceled: true }
        }

        await writeFile(dialogResult.filePath, writePayload)
        return {
          canceled: false,
          filePath: dialogResult.filePath
        }
      }
    ]
  ]

  return registerIpcHandlers(ipcMain, handlers, { logService })
}
