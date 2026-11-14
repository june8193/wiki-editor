import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_IPC_CHANNELS, GIT_IPC_CHANNELS, WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import { LogService } from '../logging/LogService'
import { type IpcMainLike, registerIpcHandlers } from './ipcHelpers'

type Handler = (_event: unknown, ...args: unknown[]) => unknown

function createFakeIpcMain(): IpcMainLike & {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
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
    }
  }
}

describe('registerIpcHandlers logging wrapper', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-ipc-log-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('logs durationMs, success status, and error details while redacting writeFile, createEntry, and saveRaw contents', async () => {
    const ipcMain = createFakeIpcMain()
    const secretContent = 'SUPER_SECRET_MARKDOWN_BODY'
    const secretInitial = 'SECRET_INITIAL_NOTE'
    const secretRawConfig = '{"version":1,"theme":"dark","secretToken":"abc"}'

    const dispose = registerIpcHandlers(
      ipcMain,
      [
        [
          WORKSPACE_IPC_CHANNELS.writeFile,
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        ],
        [
          WORKSPACE_IPC_CHANNELS.createEntry,
          async (_event, _parent, name) => ({
            name,
            path: `C:\\wiki\\${String(name)}`,
            relativePath: String(name),
            kind: 'file'
          })
        ],
        [CONFIG_IPC_CHANNELS.saveRaw, async () => ({ version: 1, theme: 'dark' })],
        [
          GIT_IPC_CHANNELS.push,
          async () => {
            throw Object.assign(new Error('Push failed from handler'), { code: 'ERR_GIT_PUSH' })
          }
        ]
      ],
      { logService }
    )

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.writeFile, 'C:\\wiki\\note.md', secretContent)
    await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.createEntry,
      'C:\\wiki',
      'new.md',
      'file',
      secretInitial
    )
    await ipcMain.invoke(CONFIG_IPC_CHANNELS.saveRaw, secretRawConfig)
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.push, 'C:\\wiki')).rejects.toThrow(
      'Push failed from handler'
    )

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(4)

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain(secretContent)
    expect(serialized).not.toContain(secretInitial)
    expect(serialized).not.toContain(secretRawConfig)

    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: WORKSPACE_IPC_CHANNELS.writeFile,
        success: true,
        filePath: 'C:\\wiki\\note.md',
        contentLength: secretContent.length
      }
    })
    expect(typeof entries[0].data?.durationMs).toBe('number')
    expect((entries[0].data?.durationMs as number) >= 0).toBe(true)

    expect(entries[1]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: WORKSPACE_IPC_CHANNELS.createEntry,
        success: true,
        parentDirPath: 'C:\\wiki',
        name: 'new.md',
        kind: 'file',
        contentLength: secretInitial.length
      }
    })

    expect(entries[2]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: CONFIG_IPC_CHANNELS.saveRaw,
        success: true,
        contentLength: secretRawConfig.length
      }
    })

    expect(entries[3]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: GIT_IPC_CHANNELS.push,
        success: false
      },
      error: {
        name: 'Error',
        message: 'Push failed from handler',
        code: 'ERR_GIT_PUSH'
      }
    })
    expect(entries[3].error?.stack).toContain('Push failed from handler')
    expect(typeof entries[3].data?.durationMs).toBe('number')

    dispose()
  })
})
