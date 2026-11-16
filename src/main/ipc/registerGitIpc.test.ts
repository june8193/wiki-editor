import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyGitStatus } from '@shared/git'
import { GIT_IPC_CHANNELS } from '@shared/ipc'
import type { GitService } from '../git/GitService'
import { LogService } from '../logging/LogService'
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
    const sampleLog = { commits: [], hasMore: false }
    const sampleCommitDetail = {
      hash: 'abc1234def567890123456789012345678901234',
      shortHash: 'abc1234',
      parents: [],
      subject: 'init',
      body: '',
      authorName: 'Tester',
      authorEmail: 'tester@example.com',
      committedAt: '2026-11-15T12:00:00+09:00',
      files: [{ path: 'README.md', status: 'A' as const }]
    }
    const sampleDiff = {
      path: 'README.md',
      status: 'M' as const,
      isBinary: false,
      isTruncated: false,
      existsInWorkspace: true,
      rawPatch: '@@ -1 +1 @@\n-old\n+new\n'
    }
    const fakeGitService: Pick<
      GitService,
      | 'status'
      | 'init'
      | 'stage'
      | 'stageAll'
      | 'unstage'
      | 'unstageAll'
      | 'discard'
      | 'commit'
      | 'branches'
      | 'checkout'
      | 'pull'
      | 'push'
      | 'sync'
      | 'log'
      | 'commitDetail'
      | 'diff'
    > = {
      status: vi.fn(async () => sampleStatus),
      init: vi.fn(async () => sampleStatus),
      stage: vi.fn(async () => sampleStatus),
      stageAll: vi.fn(async () => sampleStatus),
      unstage: vi.fn(async () => sampleStatus),
      unstageAll: vi.fn(async () => sampleStatus),
      discard: vi.fn(async () => sampleStatus),
      commit: vi.fn(async () => sampleStatus),
      branches: vi.fn(async () => ({
        current: 'main',
        isDetached: false,
        branches: [{ name: 'main', current: true, upstream: null }]
      })),
      checkout: vi.fn(async () => sampleStatus),
      pull: vi.fn(async () => sampleStatus),
      push: vi.fn(async () => sampleStatus),
      sync: vi.fn(async () => ({ status: sampleStatus, pulled: true, pushed: true, summary: 'done' })),
      log: vi.fn(async () => sampleLog),
      commitDetail: vi.fn(async () => sampleCommitDetail),
      diff: vi.fn(async () => sampleDiff)
    }

    const ipcMain = createFakeIpcMain()
    const dispose = registerGitIpc({
      ipcMain,
      gitService: fakeGitService as GitService,
      workspaceService
    })

    const diffRequest = { kind: 'staged' as const, path: 'README.md', status: 'M' as const }

    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.status, workspaceDir)).rejects.toThrow(/열린 워크스페이스/)
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.discard, workspaceDir, ['a.md'])).rejects.toThrow(
      /열린 워크스페이스/
    )
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.log, workspaceDir)).rejects.toThrow(/열린 워크스페이스/)
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.commitDetail, workspaceDir, 'abc1234')).rejects.toThrow(
      /열린 워크스페이스/
    )
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.diff, workspaceDir, diffRequest)).rejects.toThrow(
      /열린 워크스페이스/
    )

    const opened = await workspaceService.openWorkspace(workspaceDir)

    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.status, otherDir)).rejects.toThrow(/일치하지 않습니다/)
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.discard, otherDir, ['a.md'])).rejects.toThrow(
      /일치하지 않습니다/
    )
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.log, otherDir)).rejects.toThrow(/일치하지 않습니다/)
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.commitDetail, otherDir, 'abc1234')).rejects.toThrow(
      /일치하지 않습니다/
    )
    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.diff, otherDir, diffRequest)).rejects.toThrow(
      /일치하지 않습니다/
    )

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

    await ipcMain.invoke(GIT_IPC_CHANNELS.discard, workspaceDir, ['a.md', 'b.md'])
    expect(fakeGitService.discard).toHaveBeenCalledWith(opened.rootPath, ['a.md', 'b.md'])

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

    expect(
      await ipcMain.invoke(GIT_IPC_CHANNELS.log, workspaceDir, { scope: 'current', limit: 50, skip: 10 })
    ).toEqual(sampleLog)
    expect(fakeGitService.log).toHaveBeenCalledWith(opened.rootPath, {
      scope: 'current',
      limit: 50,
      skip: 10
    })

    expect(await ipcMain.invoke(GIT_IPC_CHANNELS.commitDetail, workspaceDir, 'abc1234')).toEqual(
      sampleCommitDetail
    )
    expect(fakeGitService.commitDetail).toHaveBeenCalledWith(opened.rootPath, 'abc1234')

    expect(await ipcMain.invoke(GIT_IPC_CHANNELS.diff, workspaceDir, diffRequest)).toEqual(sampleDiff)
    expect(fakeGitService.diff).toHaveBeenCalledWith(opened.rootPath, diffRequest)

    dispose()
    for (const channel of Object.values(GIT_IPC_CHANNELS)) {
      expect(ipcMain.hasHandler(channel)).toBe(false)
    }
  })

  it('logs git:* IPC successes and failures with durationMs and error metadata', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const sampleStatus = createEmptyGitStatus(true, workspaceDir)
    const fakeGitService: Pick<
      GitService,
      | 'status'
      | 'init'
      | 'stage'
      | 'stageAll'
      | 'unstage'
      | 'unstageAll'
      | 'discard'
      | 'commit'
      | 'branches'
      | 'checkout'
      | 'pull'
      | 'push'
      | 'sync'
      | 'log'
      | 'commitDetail'
      | 'diff'
    > = {
      status: vi.fn(async () => sampleStatus),
      init: vi.fn(async () => sampleStatus),
      stage: vi.fn(async () => sampleStatus),
      stageAll: vi.fn(async () => sampleStatus),
      unstage: vi.fn(async () => sampleStatus),
      unstageAll: vi.fn(async () => sampleStatus),
      discard: vi.fn(async () => sampleStatus),
      commit: vi.fn(async () => sampleStatus),
      branches: vi.fn(async () => ({ current: 'main', isDetached: false, branches: [] })),
      checkout: vi.fn(async () => sampleStatus),
      pull: vi.fn(async () => sampleStatus),
      push: vi.fn(async () => sampleStatus),
      sync: vi.fn(async () => ({ status: sampleStatus, pulled: true, pushed: true, summary: 'done' })),
      log: vi.fn(async () => ({ commits: [], hasMore: false })),
      commitDetail: vi.fn(async () => ({
        hash: 'abc1234',
        shortHash: 'abc1234',
        parents: [],
        subject: '',
        body: '',
        authorName: '',
        authorEmail: '',
        committedAt: '',
        files: []
      })),
      diff: vi.fn(async () => ({
        path: 'README.md',
        status: 'M' as const,
        isBinary: false,
        isTruncated: false,
        existsInWorkspace: true,
        rawPatch: ''
      }))
    }

    const ipcMain = createFakeIpcMain()
    const dispose = registerGitIpc({
      ipcMain,
      gitService: fakeGitService as GitService,
      workspaceService,
      logService
    })

    await expect(ipcMain.invoke(GIT_IPC_CHANNELS.status, workspaceDir)).rejects.toThrow(
      /열린 워크스페이스/
    )
    await workspaceService.openWorkspace(workspaceDir)
    await ipcMain.invoke(GIT_IPC_CHANNELS.status, workspaceDir)

    const entries = await logService.readEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      level: 'error',
      category: 'ipc',
      data: { channel: GIT_IPC_CHANNELS.status, success: false }
    })
    expect(entries[0].error?.message).toMatch(/열린 워크스페이스/)
    expect(entries[1]).toMatchObject({
      level: 'info',
      category: 'ipc',
      data: { channel: GIT_IPC_CHANNELS.status, success: true }
    })
    expect(typeof entries[1].data?.durationMs).toBe('number')

    dispose()
  })
})
