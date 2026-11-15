import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import type { IpcMainLike } from './ipcHelpers'
import { registerClipboardIpc } from './registerClipboardIpc'

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

describe('registerClipboardIpc', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-clipboard-ipc-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes text via callback, logs only textLength in IPC audit logs, rejects non-strings, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const writeClipboardText = vi.fn()
    const dispose = registerClipboardIpc({
      ipcMain,
      writeClipboardText,
      logService
    })

    const secretText = 'C:\\wiki\\private-folder\\secret-note.md'
    await ipcMain.invoke(CLIPBOARD_IPC_CHANNELS.writeText, secretText)
    expect(writeClipboardText).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(secretText)

    await expect(ipcMain.invoke(CLIPBOARD_IPC_CHANNELS.writeText, null)).rejects.toThrow(
      '클립보드에 복사할 텍스트가 올바르지 않습니다.'
    )
    await expect(ipcMain.invoke(CLIPBOARD_IPC_CHANNELS.writeText, 123)).rejects.toThrow(
      '클립보드에 복사할 텍스트가 올바르지 않습니다.'
    )
    expect(writeClipboardText).toHaveBeenCalledTimes(1)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(3)
    expect(JSON.stringify(entries)).not.toContain(secretText)
    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: CLIPBOARD_IPC_CHANNELS.writeText,
        success: true,
        textLength: secretText.length
      }
    })
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: CLIPBOARD_IPC_CHANNELS.writeText,
        success: false,
        textLength: 0
      }
    })
    expect(entries[2]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: CLIPBOARD_IPC_CHANNELS.writeText,
        success: false,
        textLength: 0
      }
    })

    dispose()
    expect(ipcMain.hasHandler(CLIPBOARD_IPC_CHANNELS.writeText)).toBe(false)
  })
})
