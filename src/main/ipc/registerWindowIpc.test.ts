import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOW_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import type { WindowCloseCoordinator } from '../window'
import type { IpcMainLike } from './ipcHelpers'
import { registerWindowIpc } from './registerWindowIpc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createFakeIpcMain(): IpcMainLike & {
  invoke(event: unknown, channel: string, ...args: unknown[]): Promise<unknown>
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
    async invoke(event, channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) {
        throw new Error(`No handler registered for ${channel}`)
      }
      return handler(event, ...args)
    },
    hasHandler(channel) {
      return handlers.has(channel)
    }
  }
}

describe('registerWindowIpc', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-window-ipc-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('routes valid window:close-response messages with sender, rejects invalid payloads, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const coordinator: Pick<WindowCloseCoordinator, 'handleCloseResponse'> = {
      handleCloseResponse: vi.fn()
    }
    const dispose = registerWindowIpc({
      ipcMain,
      coordinator,
      logService
    })

    const fakeSender = { id: 'sender-1' }
    await ipcMain.invoke({ sender: fakeSender }, WINDOW_IPC_CHANNELS.closeResponse, 'confirming')
    await ipcMain.invoke({ sender: fakeSender }, WINDOW_IPC_CHANNELS.closeResponse, 'close')
    await ipcMain.invoke({ sender: undefined }, WINDOW_IPC_CHANNELS.closeResponse, 'cancel')

    expect(coordinator.handleCloseResponse).toHaveBeenNthCalledWith(1, fakeSender, 'confirming')
    expect(coordinator.handleCloseResponse).toHaveBeenNthCalledWith(2, fakeSender, 'close')
    expect(coordinator.handleCloseResponse).toHaveBeenNthCalledWith(3, undefined, 'cancel')

    await expect(
      ipcMain.invoke({ sender: fakeSender }, WINDOW_IPC_CHANNELS.closeResponse, 'invalid')
    ).rejects.toThrow()
    await expect(
      ipcMain.invoke({ sender: fakeSender }, WINDOW_IPC_CHANNELS.closeResponse, null)
    ).rejects.toThrow()
    expect(coordinator.handleCloseResponse).toHaveBeenCalledTimes(3)

    dispose()
    expect(ipcMain.hasHandler(WINDOW_IPC_CHANNELS.closeResponse)).toBe(false)
  })
})
