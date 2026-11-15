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
})
