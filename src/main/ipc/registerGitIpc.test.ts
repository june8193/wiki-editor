import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus } from '@shared/git'
import { GIT_IPC_CHANNELS } from '@shared/ipc'
import type { GitService } from '../git/GitService'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import type { IpcMainLike } from './ipcHelpers'
import { registerGitIpc } from './registerGitIpc'

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

describe('registerGitIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let otherDir: string
  let workspaceService: WorkspaceFsService

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiki-editor-git-ipc-'))
    workspaceDir = join(tempDir, 'docs')
    otherDir = join(tempDir, 'other')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    workspaceService = new WorkspaceFsService()
  })

  afterEach(async () => {
    workspaceService.dispose()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('rejects git IPC calls when no workspace is open or path mismatches the open workspace, routes all channels, and disposes handlers', async () => {
    const sampleStatus = createEmptyGitStatus(true, workspaceDir)
    const fakeGitService: Pick<
      GitService,
      | 'status'
      | 'init'
      | 'stage'
      | 'stageAll'
      | 'unstage'
      | 'unstageAll'
      | 'commit'
      | 'branches'
      | 'checkout'
      | 'pull'
      | 'push'
      | 'sync'
    > = {
      status: vi.fn(async () => sampleStatus),
      init: vi.fn(async () => sampleStatus),
      stage: vi.fn(async () => sampleStatus),
      stageAll: vi.fn(async () => sampleStatus),
      unstage: vi.fn(async () => sampleStatus),
      unstageAll: vi.fn(async () => sampleStatus),
      commit: vi.fn(async () => sampleStatus),
      branches: vi.fn(async () => ({
        current: 'main',
        isDetached: false,
        branches: [{ name: 'main', current: true, upstream: null }]
      })),
      checkout: vi.fn(async () => sampleStatus),
      pull: vi.fn(async () => sampleStatus),
      push: vi.fn(async () => sampleStatus),
      sync: vi.fn(async () => ({ status: sampleStatus, pulled: true, pushed: true, summary: 'done' }))
    }

    const ipcMain = createFakeIpcMain()
    const dispose = registerGitIpc({
      ipcMain,
      gitService: fakeGitService as GitService,
      workspaceService
    })

    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.status, workspaceDir)).rejects.toThrow(/열린 워크스페이스/)

    const opened = await workspaceService.openWorkspace(workspaceDir)

    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.status, otherDir)).rejects.toThrow(/일치하지 않습니다/)

    expect(await ipcMain.invoke(GIT_IPC_CHANNELS.status, workspaceDir)).toEqual(sampleStatus)
    expect(fakeGitService.status).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.init, workspaceDir)
    expect(fakeGitService.init).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.stage, workspaceDir, ['a.md'])
    expect(fakeGitService.stage).toHaveBeenCalledWith(opened.rootPath, ['a.md'])

    await ipcMain.invoke(GIT_IPC_CHANNELS.stageAll, workspaceDir)
    expect(fakeGitService.stageAll).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.unstage, workspaceDir, ['a.md'])
    expect(fakeGitService.unstage).toHaveBeenCalledWith(opened.rootPath, ['a.md'])

    await ipcMain.invoke(GIT_IPC_CHANNELS.unstageAll, workspaceDir)
    expect(fakeGitService.unstageAll).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.commit, workspaceDir, 'init commit')
    expect(fakeGitService.commit).toHaveBeenCalledWith(opened.rootPath, 'init commit')

    await ipcMain.invoke(GIT_IPC_CHANNELS.branches, workspaceDir)
    expect(fakeGitService.branches).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.checkout, workspaceDir, 'feature')
    expect(fakeGitService.checkout).toHaveBeenCalledWith(opened.rootPath, 'feature')

    await ipcMain.invoke(GIT_IPC_CHANNELS.pull, workspaceDir)
    expect(fakeGitService.pull).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.push, workspaceDir)
    expect(fakeGitService.push).toHaveBeenCalledWith(opened.rootPath)

    await ipcMain.invoke(GIT_IPC_CHANNELS.sync, workspaceDir)
    expect(fakeGitService.sync).toHaveBeenCalledWith(opened.rootPath)

    dispose()
    for (const channel of Object.values(GIT_IPC_CHANNELS)) {
      expect(ipcMain.hasHandler(channel)).toBe(false)
    }
  })
})
