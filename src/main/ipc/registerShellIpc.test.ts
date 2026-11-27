import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHELL_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import type { IpcMainLike } from './ipcHelpers'
import { registerShellIpc } from './registerShellIpc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function createFakeIpcMain(): IpcMainLike & {
  invokeFrom(sender: unknown, channel: string, ...args: unknown[]): Promise<unknown>
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
    async invokeFrom(sender, channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) {
        throw new Error(`No handler registered for ${channel}`)
      }
      return handler({ sender }, ...args)
    },
    hasHandler(channel) {
      return handlers.has(channel)
    }
  }
}

describe('registerShellIpc', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-shell-ipc-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('opens validated http/https URLs from any window role, rejects unsafe/invalid URLs, propagates errors, and cleans up on dispose', async () => {
    const ipcMain = createFakeIpcMain()
    const openExternal = vi.fn(async () => undefined)
    const dispose = registerShellIpc({
      ipcMain,
      openExternal,
      logService
    })

    const mainSender = { id: 1, role: 'main' }
    const auxSender = { id: 2, role: 'auxiliary' }

    expect(
      await ipcMain.invokeFrom(mainSender, SHELL_IPC_CHANNELS.openExternalUrl, 'https://example.com/docs?q=1#top')
    ).toBe(true)
    expect(
      await ipcMain.invokeFrom(auxSender, SHELL_IPC_CHANNELS.openExternalUrl, '  http://localhost:8080/guide  ')
    ).toBe(true)

    expect(openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/docs?q=1#top')
    expect(openExternal).toHaveBeenNthCalledWith(2, 'http://localhost:8080/guide')

    for (const badUrl of [
      'mailto:team@example.com',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'ftp://example.com/archive.zip',
      'https://',
      'https://example.com\n--evil',
      null,
      123
    ]) {
      expect(
        await ipcMain.invokeFrom(auxSender, SHELL_IPC_CHANNELS.openExternalUrl, badUrl)
      ).toBe(false)
    }
    expect(openExternal).toHaveBeenCalledTimes(2)

    openExternal.mockRejectedValueOnce(new Error('OS browser launch failed'))
    await expect(
      ipcMain.invokeFrom(mainSender, SHELL_IPC_CHANNELS.openExternalUrl, 'https://example.com/fail')
    ).rejects.toThrow('OS browser launch failed')

    dispose()
    expect(ipcMain.hasHandler(SHELL_IPC_CHANNELS.openExternalUrl)).toBe(false)
  })
})
