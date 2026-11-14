import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_IPC_CHANNELS } from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
import { LogService } from '../logging/LogService'
import type { IpcMainLike } from './ipcHelpers'
import { registerLogIpc } from './registerLogIpc'

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

describe('registerLogIpc', () => {
  let tempDir: string
  let logService: LogService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-log-ipc-'))
    logService = new LogService(join(tempDir, 'logs'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('persists renderer logs with process=renderer, avoids IPC audit log duplication, and redacts sensitive fields', async () => {
    const ipcMain = createFakeIpcMain()
    const dispose = registerLogIpc(ipcMain, logService)

    const payload: RendererLogPayload & { process?: string } = {
      level: 'error',
      category: 'ui',
      message: 'Save failed in editor',
      process: 'main', // Spoof attempt must be overridden to 'renderer'
      data: {
        filePath: 'C:\\wiki\\secret-note.md',
        content: 'PRIVATE_MARKDOWN_CONTENT',
        nested: {
          raw: '{"secretToken":"xyz"}'
        }
      },
      error: {
        name: 'TypeError',
        message: 'Cannot read property',
        stack: 'TypeError: Cannot read property\n    at App.tsx:42:10'
      }
    }

    await ipcMain.invoke(LOG_IPC_CHANNELS.write, payload)
    // Invalid payloads are safely ignored without throwing
    await expect(ipcMain.invoke(LOG_IPC_CHANNELS.write, null)).resolves.toBeUndefined()
    await expect(
      ipcMain.invoke(LOG_IPC_CHANNELS.write, { level: 'info', category: 'ui', message: '' })
    ).resolves.toBeUndefined()

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(1)

    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('PRIVATE_MARKDOWN_CONTENT')
    expect(serialized).not.toContain('secretToken')

    expect(entries[0]).toMatchObject({
      level: 'error',
      process: 'renderer',
      category: 'ui',
      message: 'Save failed in editor',
      data: {
        filePath: 'C:\\wiki\\secret-note.md',
        contentLength: 'PRIVATE_MARKDOWN_CONTENT'.length,
        nested: {
          contentLength: '{"secretToken":"xyz"}'.length
        }
      },
      error: {
        name: 'TypeError',
        message: 'Cannot read property',
        stack: 'TypeError: Cannot read property\n    at App.tsx:42:10'
      }
    })

    dispose()
    expect(ipcMain.hasHandler(LOG_IPC_CHANNELS.write)).toBe(false)
  })
})
