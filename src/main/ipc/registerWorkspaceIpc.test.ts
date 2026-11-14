import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import { ConfigService } from '../config/ConfigService'
import { LogService } from '../logging/LogService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import type { IpcMainLike, WebContentsLike } from './registerConfigIpc'
import { registerWorkspaceIpc } from './registerWorkspaceIpc'

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

describe('registerWorkspaceIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-ws-ipc-'))
    workspaceDir = join(tempDir, 'docs')
    configPath = join(tempDir, 'config.json')
    await mkdir(workspaceDir, { recursive: true })
    workspaceService = new WorkspaceFsService({ watchDebounceMs: 30 })
  })

  afterEach(async () => {
    workspaceService.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('handles folder selection, workspace opening, recentWorkspaces recording, CRUD, watching, and disposal', async () => {
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const selectDirectory = vi.fn(async () => workspaceDir)
    const messages: Array<{ channel: string; payload: unknown }> = []
    const targets: WebContentsLike[] = [
      {
        isDestroyed: () => false,
        send: (channel, payload) => messages.push({ channel, payload })
      }
    ]

    const dispose = registerWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory,
      getTargets: () => targets
    })

    expect(await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.selectFolder)).toBe(workspaceDir)

    const opened = await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    expect(opened).toMatchObject({ name: 'docs', entries: [] })
    expect((await configService.get()).recentWorkspaces).toHaveLength(1)

    const folder = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.createEntry,
      '.',
      'guides',
      'directory'
    )) as { path: string }
    const created = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.createEntry,
      folder.path,
      'intro.md',
      'file',
      '# Intro'
    )) as { path: string }

    expect(await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readFile, created.path)).toBe('# Intro')
    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.writeFile, created.path, '# Edited')
    expect(await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readFile, created.path)).toBe('# Edited')

    const entries = (await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readDir, folder.path)) as Array<{
      name: string
    }>
    expect(entries.map((item) => item.name)).toEqual(['intro.md'])

    const renamed = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.renameEntry,
      created.path,
      'start.md'
    )) as { path: string; name: string }
    expect(renamed.name).toBe('start.md')

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.watch)
    await writeFile(join(workspaceDir, 'external.md'), 'hi', 'utf8')
    await vi.waitFor(() => {
      expect(messages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
    })

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.unwatch)
    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.deleteEntry, renamed.path)
    expect(await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readDir, folder.path)).toEqual([])

    dispose()
    expect(ipcMain.hasHandler(WORKSPACE_IPC_CHANNELS.open)).toBe(false)
  })

  it('logs workspace:* IPC calls while redacting createEntry and writeFile contents', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const dispose = registerWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory: async () => workspaceDir,
      getTargets: () => [],
      logService
    })

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const created = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.createEntry,
      '.',
      'secret-doc.md',
      'file',
      'PRIVATE_INITIAL_TEXT'
    )) as { path: string }
    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.writeFile, created.path, 'PRIVATE_UPDATED_TEXT')
    await expect(
      ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readFile, join(workspaceDir, 'missing.md'))
    ).rejects.toThrow()

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(4)
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('PRIVATE_INITIAL_TEXT')
    expect(serialized).not.toContain('PRIVATE_UPDATED_TEXT')

    expect(entries[1]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: WORKSPACE_IPC_CHANNELS.createEntry,
        success: true,
        contentLength: 'PRIVATE_INITIAL_TEXT'.length
      }
    })
    expect(entries[2]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: {
        channel: WORKSPACE_IPC_CHANNELS.writeFile,
        success: true,
        contentLength: 'PRIVATE_UPDATED_TEXT'.length
      }
    })
    expect(entries[3]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: {
        channel: WORKSPACE_IPC_CHANNELS.readFile,
        success: false
      }
    })

    dispose()
  })
})
