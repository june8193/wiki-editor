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
    const serialized = JSON.stringify(entries)
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
})
