import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIG_IPC_CHANNELS,
  DIAGRAM_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS
} from '@shared/ipc'
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

  it('does not generate an IPC audit log for log:write even when logService is passed', async () => {
    const ipcMain = createFakeIpcMain()
    const dispose = registerIpcHandlers(
      ipcMain,
      [[LOG_IPC_CHANNELS.write, async () => undefined]],
      { logService }
    )

    await ipcMain.invoke(LOG_IPC_CHANNELS.write, {
      level: 'info',
      category: 'ui',
      message: 'test'
    })

    expect(await logService.readEntries()).toHaveLength(0)
    dispose()
  })

  it('logs git:diff request metadata without exposing rawPatch or file contents', async () => {
    const ipcMain = createFakeIpcMain()
    const secretPatchBody = 'SUPER_SECRET_DIFF_PATCH_CONTENT'
    const dispose = registerIpcHandlers(
      ipcMain,
      [
        [
          GIT_IPC_CHANNELS.diff,
          async () => ({
            path: 'docs/secret.md',
            status: 'M',
            isBinary: false,
            isTruncated: false,
            existsInWorkspace: true,
            rawPatch: `@@ -1 +1 @@\n-${secretPatchBody}\n+updated\n`
          })
        ]
      ],
      { logService }
    )

    await ipcMain.invoke(GIT_IPC_CHANNELS.diff, 'C:\\wiki', {
      kind: 'staged',
      path: 'docs/secret.md',
      origPath: 'docs/old.md',
      status: 'R'
    })

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain(secretPatchBody)
    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: GIT_IPC_CHANNELS.diff,
        success: true,
        workspacePath: 'C:\\wiki',
        kind: 'staged',
        path: 'docs/secret.md'
      }
    })
    dispose()
  })

  it('logs diagram:copy-text metadata with textLength only and redacts raw Mermaid source', async () => {
    const ipcMain = createFakeIpcMain()
    const secretMermaidCode = 'flowchart TD\n  SECRET_SOURCE --> SECRET_TARGET'
    const dispose = registerIpcHandlers(
      ipcMain,
      [
        [
          DIAGRAM_IPC_CHANNELS.copyText,
          async (_event, text) => {
            if (typeof text !== 'string') {
              throw new TypeError('Invalid clipboard text')
            }
          }
        ]
      ],
      { logService }
    )

    await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyText, secretMermaidCode)
    await expect(ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyText, 12345)).rejects.toThrow(
      'Invalid clipboard text'
    )

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(2)
    expect(JSON.stringify(entries)).not.toContain('SECRET_SOURCE')
    expect(JSON.stringify(entries)).not.toContain('SECRET_TARGET')

    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyText,
        success: true,
        textLength: secretMermaidCode.length
      }
    })
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyText,
        success: false,
        textLength: 0
      },
      error: {
        name: 'TypeError',
        message: 'Invalid clipboard text'
      }
    })

    dispose()
  })

  it('logs diagram:copy-image metadata with byteLength only and redacts raw PNG bytes', async () => {
    const ipcMain = createFakeIpcMain()
    const secretPngBytes = new Uint8Array([137, 80, 78, 71, 222, 173, 190, 239])
    const dispose = registerIpcHandlers(
      ipcMain,
      [
        [
          DIAGRAM_IPC_CHANNELS.copyImage,
          async (_event, pngBytes) => {
            if (!(pngBytes instanceof Uint8Array)) {
              throw new TypeError('Invalid clipboard image bytes')
            }
          }
        ]
      ],
      { logService }
    )

    await ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyImage, secretPngBytes)
    await expect(ipcMain.invoke(DIAGRAM_IPC_CHANNELS.copyImage, 'not-bytes')).rejects.toThrow(
      'Invalid clipboard image bytes'
    )

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(2)
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('222')
    expect(serialized).not.toContain('173')
    expect(serialized).not.toContain('190')
    expect(serialized).not.toContain('239')
    expect(serialized).not.toContain('not-bytes')

    expect(entries[0]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyImage,
        success: true,
        byteLength: secretPngBytes.byteLength
      }
    })
    expect(entries[1]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: DIAGRAM_IPC_CHANNELS.copyImage,
        success: false,
        byteLength: 0
      },
      error: {
        name: 'TypeError',
        message: 'Invalid clipboard image bytes'
      }
    })

    dispose()
  })
})
