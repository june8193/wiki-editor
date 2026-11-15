import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAGRAM_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import type { IpcMainLike } from './ipcHelpers'
import { registerDiagramIpc } from './registerDiagramIpc'

type Handler = (_event: unknown, ...args: unknown[]) => unknown

function createFakeIpcMain(): IpcMainLike & {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  hasHandler(channel: string): boolean
} {
  const handlers = new Map<string, Handler>()
  return {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
    removeHandler(channel) {
      handlers.delete(channel)
    },
    async invoke(channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) {
        throw new Error(`No handler registered for ${channel}`)
      }
      return handler({}, ...args)
    },
    hasHandler(channel) {
      return handlers.has(channel)
    }
  }
}

describe('registerDiagramIpc', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-diagram-ipc-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes string Mermaid source via clipboard adapter, validates non-string inputs, logs length without leaking text, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const writeClipboardText = vi.fn()
    const secretSource = 'sequenceDiagram\n  Alice->>Bob: SECRET_CLIPBOARD_TOKEN'

    const dispose = registerDiagramIpc({
      ipcMain,
      writeClipboardText,
      createImageFromBuffer: () => ({ isEmpty: () => false }),
      writeClipboardImage: vi.fn(),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeFile: vi.fn(async () => {}),
      logService
    })

    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.copyText)).toBe(true)

    await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyText, secretSource)
    expect(writeClipboardText).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(secretSource)

    for (const invalidInput of [null, undefined, 42, { text: 'bad' }]) {
      await expect(
        ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyText, invalidInput)
      ).rejects.toThrow()
    }
    expect(writeClipboardText).toHaveBeenCalledTimes(1)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(5)
    expect(JSON.stringify(entries)).not.toContain('SECRET_CLIPBOARD_TOKEN')
    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyText,
        success: true,
        textLength: secretSource.length
      }
    })
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyText,
        success: false,
        textLength: 0
      }
    })

    dispose()
    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.copyText)).toBe(false)
  })

  it('decodes PNG bytes via createImageFromBuffer, rejects non-Uint8Array, empty buffers, and empty decoded images, logs byteLength only, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const fakeImage = { id: 'decoded-image', isEmpty: () => false }
    const emptyImage = { id: 'empty-image', isEmpty: () => true }
    let returnEmptyImage = false

    const createImageFromBuffer = vi.fn((buffer: Buffer) => {
      expect(Buffer.isBuffer(buffer)).toBe(true)
      return returnEmptyImage ? emptyImage : fakeImage
    })
    const writeClipboardImage = vi.fn()

    const dispose = registerDiagramIpc({
      ipcMain,
      writeClipboardText: vi.fn(),
      createImageFromBuffer,
      writeClipboardImage,
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      writeFile: vi.fn(async () => {}),
      logService
    })

    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.copyImage)).toBe(true)

    // Subarray with non-zero byteOffset preserves exact slice
    const backing = new Uint8Array([99, 137, 80, 78, 71, 222, 173, 190, 239, 88])
    const slice = backing.subarray(1, 9)
    await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyImage, slice)

    expect(createImageFromBuffer).toHaveBeenCalledTimes(1)
    expect(Array.from(createImageFromBuffer.mock.calls[0][0])).toEqual([
      137, 80, 78, 71, 222, 173, 190, 239
    ])
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)
    expect(writeClipboardImage).toHaveBeenCalledWith(fakeImage)

    // Rejects non-Uint8Array and empty buffers before nativeImage creation
    for (const invalid of [null, undefined, 'png', [137, 80], { byteLength: 4 }, new Uint8Array(0)]) {
      await expect(ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyImage, invalid)).rejects.toThrow()
    }
    expect(createImageFromBuffer).toHaveBeenCalledTimes(1)
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)

    // Rejects when nativeImage.isEmpty() is true without writing clipboard
    returnEmptyImage = true
    await expect(
      ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyImage, new Uint8Array([1, 2, 3, 4]))
    ).rejects.toThrow()
    expect(createImageFromBuffer).toHaveBeenCalledTimes(2)
    expect(writeClipboardImage).toHaveBeenCalledTimes(1)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(8)
    const serialized = JSON.stringify(entries.map(({ timestamp: _ts, ...rest }) => rest))
    expect(serialized).not.toContain('222')
    expect(serialized).not.toContain('173')
    expect(serialized).not.toContain('190')
    expect(serialized).not.toContain('239')
    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyImage,
        success: true,
        byteLength: slice.byteLength
      }
    })
    expect(entries[7]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyImage,
        success: false,
        byteLength: 4
      }
    })

    dispose()
    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.copyImage)).toBe(false)
  })

  it('saves PNG binary and UTF-8 SVG via save dialog with format filters, sanitized default names, cancel handling, validation, and redacted audit logs', async () => {
    const ipcMain = createFakeIpcMain()
    const writtenFiles: Array<{ filePath: string; data: Buffer | string }> = []
    let nextDialogResult: { canceled: boolean; filePath?: string } = {
      canceled: false,
      filePath: join(tempDir, 'exported-diagram.png')
    }

    const showSaveDialog = vi.fn(async () => nextDialogResult)
    const writeFile = vi.fn(async (filePath: string, data: Buffer | string) => {
      writtenFiles.push({ filePath, data })
    })

    const dispose = registerDiagramIpc({
      ipcMain,
      writeClipboardText: vi.fn(),
      createImageFromBuffer: () => ({ isEmpty: () => false }),
      writeClipboardImage: vi.fn(),
      showSaveDialog,
      writeFile,
      logService
    })

    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.saveFile)).toBe(true)

    // 1. Confirmed PNG save: slices Uint8Array by byteOffset/byteLength, applies PNG filter and sanitizes suggestedName
    const backing = new Uint8Array([99, 137, 80, 78, 71, 211, 212, 213, 214, 88])
    const pngSlice = backing.subarray(1, 9)
    const pngResult = await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.saveFile, {
      format: 'png',
      suggestedName: '  ..Guide: <v1>\\chart..  ',
      data: pngSlice
    })

    expect(showSaveDialog).toHaveBeenCalledTimes(1)
    expect(showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: 'Guide v1chart.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    })
    expect(pngResult).toEqual({
      canceled: false,
      filePath: join(tempDir, 'exported-diagram.png')
    })
    expect(writtenFiles).toHaveLength(1)
    expect(Buffer.isBuffer(writtenFiles[0].data)).toBe(true)
    expect(Array.from(writtenFiles[0].data as Buffer)).toEqual([
      137, 80, 78, 71, 211, 212, 213, 214
    ])

    // 2. Confirmed SVG save: applies SVG filter, fixes mismatched extension, writes UTF-8 SVG string
    const svgPath = join(tempDir, 'exported-diagram.svg')
    nextDialogResult = { canceled: false, filePath: svgPath }
    const svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg"><text>SECRET_SVG_BODY</text></svg>'
    const svgResult = await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.saveFile, {
      format: 'svg',
      suggestedName: 'architecture-diagram.png',
      data: svgMarkup
    })

    expect(showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: 'architecture-diagram.svg',
      filters: [{ name: 'SVG Image', extensions: ['svg'] }]
    })
    expect(svgResult).toEqual({ canceled: false, filePath: svgPath })
    expect(writtenFiles[1]).toEqual({ filePath: svgPath, data: svgMarkup })

    // 3. Canceled save dialog: writes nothing and returns { canceled: true }, falls back to mermaid-diagram when name empty
    nextDialogResult = { canceled: true }
    const canceledResult = await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.saveFile, {
      format: 'svg',
      suggestedName: '  ...<>:"/\\|?*...svg  ',
      data: svgMarkup
    })
    expect(showSaveDialog).toHaveBeenLastCalledWith({
      defaultPath: 'mermaid-diagram.svg',
      filters: [{ name: 'SVG Image', extensions: ['svg'] }]
    })
    expect(canceledResult).toEqual({ canceled: true })
    expect(writtenFiles).toHaveLength(2)

    // 4. Rejects malformed requests, invalid format, empty/non-Uint8Array PNG, and blank/non-string SVG without opening dialog
    for (const invalidReq of [
      null,
      'bad',
      { format: 'pdf', suggestedName: 'a.pdf', data: 'x' },
      { format: 'png', suggestedName: 'a.png', data: 'not-bytes' },
      { format: 'png', suggestedName: 'a.png', data: new Uint8Array(0) },
      { format: 'svg', suggestedName: 'a.svg', data: new Uint8Array([1, 2]) },
      { format: 'svg', suggestedName: 'a.svg', data: '   \n  ' }
    ]) {
      await expect(ipcMain.invoke(DIAGRAM_IPC_CHANNELS.saveFile, invalidReq)).rejects.toThrow()
    }
    expect(showSaveDialog).toHaveBeenCalledTimes(3)
    expect(writeFile).toHaveBeenCalledTimes(2)

    // 5. Audit log records format, byte/text length, and canceled status only (no raw bytes, SVG markup, or file paths)
    const entries = await logService.readEntries()
    expect(entries).toHaveLength(10)
    const serialized = JSON.stringify(entries.map(({ timestamp: _ts, ...rest }) => rest))
    expect(serialized).not.toContain('SECRET_SVG_BODY')
    expect(serialized).not.toContain('211')
    expect(serialized).not.toContain('214')
    expect(serialized).not.toContain('exported-diagram')
    expect(serialized).not.toContain('Guide v1chart')

    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.saveFile,
        success: true,
        format: 'png',
        byteLength: pngSlice.byteLength,
        canceled: false
      }
    })
    expect(entries[1]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.saveFile,
        success: true,
        format: 'svg',
        textLength: svgMarkup.length,
        canceled: false
      }
    })
    expect(entries[2]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.saveFile,
        success: true,
        format: 'svg',
        textLength: svgMarkup.length,
        canceled: true
      }
    })

    dispose()
    expect(ipcMain.hasHandler(DIAGRAM_IPC_CHANNELS.saveFile)).toBe(false)
  })
})
