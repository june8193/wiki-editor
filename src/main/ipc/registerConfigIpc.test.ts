import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_IPC_CHANNELS } from '@shared/ipc'
import { ConfigService } from '../config/ConfigService'
import { IpcMainLike, registerConfigIpc, WebContentsLike } from './registerConfigIpc'

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

describe('registerConfigIpc', () => {
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-ipc-'))
    configPath = join(tempDir, 'config.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('serves config get, update, getConfigPath, readRaw and broadcasts updates to live targets', async () => {
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const liveMessages: Array<{ channel: string; payload: unknown }> = []
    const destroyedMessages: Array<{ channel: string; payload: unknown }> = []

    const targets: WebContentsLike[] = [
      {
        isDestroyed: () => false,
        send: (channel, payload) => liveMessages.push({ channel, payload })
      },
      {
        isDestroyed: () => true,
        send: (channel, payload) => destroyedMessages.push({ channel, payload })
      }
    ]

    const dispose = registerConfigIpc(ipcMain, configService, () => targets)

    expect(await ipcMain.invoke(CONFIG_IPC_CHANNELS.getPath)).toBe(configPath)
    const initial = await ipcMain.invoke(CONFIG_IPC_CHANNELS.get)
    expect(initial).toMatchObject({ theme: 'light', version: 1 })

    const updated = await ipcMain.invoke(CONFIG_IPC_CHANNELS.update, { theme: 'dark' })
    expect(updated).toMatchObject({ theme: 'dark' })

    const raw = await ipcMain.invoke(CONFIG_IPC_CHANNELS.readRaw)
    expect(JSON.parse(raw as string).theme).toBe('dark')

    expect(liveMessages).toHaveLength(1)
    expect(liveMessages[0].channel).toBe(CONFIG_IPC_CHANNELS.changed)
    expect(liveMessages[0].payload).toMatchObject({ theme: 'dark' })
    expect(destroyedMessages).toHaveLength(0)

    dispose()
    expect(ipcMain.hasHandler(CONFIG_IPC_CHANNELS.get)).toBe(false)
    await configService.update({ theme: 'light' })
    expect(liveMessages).toHaveLength(1)
  })
})
