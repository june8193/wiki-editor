import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { WORKSPACE_IPC_CHANNELS } from '@shared/ipc'
import { DEFAULT_SEARCH_MATCH_OPTIONS, type WorkspaceSearchResponse } from '@shared/search'
import type { SymbolCandidateMatch } from '@shared/symbol'
import { ConfigService } from '../config/ConfigService'
import { LogService } from '../logging/LogService'
import { createDiskWorkspaceQueryAndSchemaHub } from '../workspace/diskWorkspaceQueryAndSchema'
import { WorkspaceFsService } from '../workspace/WorkspaceFsService'
import type { IpcMainLike } from './ipcHelpers'
import { createFakeIpcMain } from './ipcTestHelpers'
import { createSharedDocumentBufferHub } from './registerBufferIpc'
import type { WebContentsLike } from './registerConfigIpc'
import { registerWorkspaceIpc, type WorkspaceIpcSession } from './registerWorkspaceIpc'

function registerSingleWorkspaceIpc(params: {
  ipcMain: IpcMainLike
  workspaceService: WorkspaceFsService
  configService: ConfigService
  selectDirectory: (sender?: WebContentsLike) => Promise<string | null>
  getTargets: () => WebContentsLike[]
  bufferHub?: SharedDocumentBufferHub
  isMainWindow?: (sender: WebContentsLike | undefined) => boolean
  logService?: LogService
}): () => void {
  const queryAndSchemaHub = createDiskWorkspaceQueryAndSchemaHub({
    workspaceService: params.workspaceService,
    bufferHub: params.bufferHub,
    logService: params.logService
  })
  const session: WorkspaceIpcSession = {
    workspaceService: params.workspaceService,
    queryAndSchemaHub,
    getTargets: params.getTargets,
    isMainWindow: params.isMainWindow ?? (() => true)
  }
  const disposeIpc = registerWorkspaceIpc({
    ipcMain: params.ipcMain,
    configService: params.configService,
    selectDirectory: params.selectDirectory,
    logService: params.logService,
    coordinator: {
      resolveSession: () => session,
      openWorkspaceInSession: async (_sender, rootPath) => {
        queryAndSchemaHub.cancelActiveScans()
        return params.workspaceService.openWorkspace(rootPath)
      }
    }
  })
  return () => {
    disposeIpc()
    queryAndSchemaHub.dispose()
  }
}

describe('registerWorkspaceIpc', () => {
  let tempDir: string
  let workspaceDir: string
  let configPath: string
  let workspaceService: WorkspaceFsService

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'wiki-editor-ws-ipc-')))
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

    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory,
      getTargets: () => targets
    })

    expect(ipcMain.hasHandler('workspace:activate-or-open')).toBe(false)
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

    const markdownFiles = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.listMarkdownFiles
    )) as Array<{ relativePath: string }>
    expect(markdownFiles.map((item) => item.relativePath)).toEqual(['guides/intro.md'])

    const symbolMatches = (await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.searchSymbols, {
      symbolName: 'Edited',
      scope: { kind: 'working-tree' }
    })) as Array<{ path: string; lineNumber: number }>
    expect(symbolMatches).toEqual([expect.objectContaining({ path: 'guides/intro.md', lineNumber: 1 })])

    const renamed = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.renameEntry,
      created.path,
      'start.md'
    )) as { path: string; name: string }
    expect(renamed.name).toBe('start.md')

    const destFolder = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.createEntry,
      '.',
      'archive',
      'directory'
    )) as { path: string }
    const moved = (await ipcMain.invoke(
      WORKSPACE_IPC_CHANNELS.moveEntries,
      [renamed.path],
      destFolder.path
    )) as Array<{ oldPath: string; entry: { path: string; relativePath: string } }>
    expect(moved).toHaveLength(1)
    expect(moved[0].oldPath).toBe(renamed.path)
    expect(moved[0].entry.relativePath).toBe('archive/start.md')

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.watch)
    await writeFile(join(workspaceDir, 'external.md'), 'hi', 'utf8')
    await vi.waitFor(() => {
      expect(messages.some((msg) => msg.channel === WORKSPACE_IPC_CHANNELS.changed)).toBe(true)
    })

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.unwatch)
    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.deleteEntry, moved[0].entry.path)
    expect(await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.readDir, destFolder.path)).toEqual([])

    dispose()
    expect(ipcMain.hasHandler(WORKSPACE_IPC_CHANNELS.open)).toBe(false)
  })

  it('logs workspace:* IPC calls while redacting createEntry and writeFile contents', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const dispose = registerSingleWorkspaceIpc({
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

  it('routes workspace:ingest-image to WorkspaceFsService.ingestImage and redacts binary bytes from logs', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory: async () => workspaceDir,
      getTargets: () => [],
      logService
    })

    await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    const docPath = join(workspaceDir, 'guide.md')
    await writeFile(docPath, '# Guide\n', 'utf8')

    const secretBytes = new Uint8Array([137, 80, 78, 71, 201, 202, 203])
    const result = await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.ingestImage, {
      documentPath: docPath,
      source: {
        kind: 'fileBytes',
        fileName: 'dropped chart.png',
        bytes: secretBytes
      }
    })

    expect(result).toEqual({
      markdownPath: './assets/dropped%20chart.png',
      altText: 'dropped chart',
      savedPath: join(workspaceDir, 'assets', 'dropped chart.png')
    })

    const entries = await logService.readEntries()
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('201')
    expect(serialized).not.toContain('"bytes"')

    dispose()
  })

  it('keeps workspace open/watch/unwatch restricted to the main window while broadcasting changes to all targets', async () => {
    const configService = new ConfigService(configPath)
    const ipcMain = createFakeIpcMain()
    const mainEvents: unknown[] = []
    const auxEvents: unknown[] = []
    const mainTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => mainEvents.push({ channel, payload })
    }
    const auxTarget: WebContentsLike = {
      isDestroyed: () => false,
      send: (channel, payload) => auxEvents.push({ channel, payload })
    }

    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory: async () => workspaceDir,
      getTargets: () => [mainTarget, auxTarget],
      isMainWindow: (sender) => sender === mainTarget
    })

    await expect(
      ipcMain.invokeFrom(auxTarget, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    ).rejects.toThrow()
    await ipcMain.invokeFrom(auxTarget, WORKSPACE_IPC_CHANNELS.watch)
    await writeFile(join(workspaceDir, 'ignored-before-main-watch.md'), 'hi', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(mainEvents).toHaveLength(0)

    await ipcMain.invokeFrom(mainTarget, WORKSPACE_IPC_CHANNELS.open, workspaceDir)
    await ipcMain.invokeFrom(mainTarget, WORKSPACE_IPC_CHANNELS.watch)
    await writeFile(join(workspaceDir, 'from-main-watch.md'), 'hi', 'utf8')
    await vi.waitFor(() => {
      expect(mainEvents.length).toBeGreaterThan(0)
      expect(auxEvents.length).toBeGreaterThan(0)
    })

    const countBeforeAuxUnwatch = mainEvents.length
    await ipcMain.invokeFrom(auxTarget, WORKSPACE_IPC_CHANNELS.unwatch)
    await writeFile(join(workspaceDir, 'still-watched.md'), 'hi', 'utf8')
    await vi.waitFor(() => {
      expect(mainEvents.length).toBeGreaterThan(countBeforeAuxUnwatch)
    })

    await ipcMain.invokeFrom(mainTarget, WORKSPACE_IPC_CHANNELS.unwatch)
    const countAfterMainUnwatch = mainEvents.length
    await writeFile(join(workspaceDir, 'after-main-unwatch.md'), 'hi', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(mainEvents.length).toBe(countAfterMainUnwatch)

    dispose()
  })

  it('routes workspace:search with shared buffer hub priority and redacts raw query in audit logs', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const configService = new ConfigService(configPath)
    await configService.get()
    const bufferHub = createSharedDocumentBufferHub({ workspaceService, configService })
    const ipcMain = createFakeIpcMain()

    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      bufferHub,
      selectDirectory: async () => workspaceDir,
      getTargets: () => [],
      logService
    })

    const opened = (await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)) as {
      rootPath: string
    }
    const docPath = join(opened.rootPath, 'secret.md')
    await writeFile(docPath, 'disk content only', 'utf8')
    const buf = await bufferHub.openWorkspaceFile(docPath, 'secret.md')
    bufferHub.syncWindowTabs(1, [buf.key])
    bufferHub.updateContent(buf.key, 'PRIVATE_QUERY_MATCH_IN_BUFFER')

    const result = await ipcMain.invoke<WorkspaceSearchResponse>(WORKSPACE_IPC_CHANNELS.search, {
      query: 'PRIVATE_QUERY_MATCH',
      options: DEFAULT_SEARCH_MATCH_OPTIONS
    })

    expect(result.totalFileCount).toBe(1)
    expect(result.totalMatchCount).toBe(1)
    expect(result.files[0].relativePath).toBe('secret.md')

    const serializedLogs = JSON.stringify(await logService.readEntries())
    expect(serializedLogs).not.toContain('PRIVATE_QUERY_MATCH')

    dispose()
    bufferHub.dispose()
  })

  it('supports frontmatter filter, sort, and summary on workspace:search while redacting filter values from logs', async () => {
    const logService = new LogService(join(tempDir, 'logs'))
    const configService = new ConfigService(configPath)
    await configService.get()
    const bufferHub = createSharedDocumentBufferHub({ workspaceService, configService })
    const ipcMain = createFakeIpcMain()

    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      bufferHub,
      selectDirectory: async () => workspaceDir,
      getTargets: () => [],
      logService
    })

    const opened = (await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)) as {
      rootPath: string
    }
    await mkdir(join(opened.rootPath, '.wiki-editor'), { recursive: true })
    await writeFile(
      join(opened.rootPath, '.wiki-editor', 'frontmatter.json'),
      JSON.stringify({
        version: 1,
        fields: [
          {
            key: 'status',
            label: '상태',
            type: 'select',
            showInSearchBadge: true,
            options: [{ value: 'todo' }, { value: 'done' }]
          },
          { key: 'owner', label: '담당자', type: 'text' }
        ]
      }),
      'utf8'
    )
    await writeFile(
      join(opened.rootPath, 'b-todo.md'),
      '---\nstatus: todo\nowner: SECRET_FILTER_OWNER\n---\nBody',
      'utf8'
    )
    await writeFile(
      join(opened.rootPath, 'a-done.md'),
      '---\nstatus: done\nowner: SECRET_FILTER_OWNER\n---\nBody',
      'utf8'
    )

    const result = await ipcMain.invoke<WorkspaceSearchResponse>(WORKSPACE_IPC_CHANNELS.search, {
      query: '',
      options: DEFAULT_SEARCH_MATCH_OPTIONS,
      frontmatter: {
        conditions: [{ fieldKey: 'owner', operator: 'contains', value: 'SECRET_FILTER_OWNER' }],
        sort: { by: 'frontmatter', fieldKey: 'status', direction: 'asc' }
      }
    })

    expect(result.files.map((f) => f.relativePath)).toEqual(['b-todo.md', 'a-done.md'])
    expect(result.files[0].frontmatterSummary).toEqual({ status: 'todo' })

    const serializedLogs = JSON.stringify(await logService.readEntries())
    expect(serializedLogs).not.toContain('SECRET_FILTER_OWNER')

    dispose()
    bufferHub.dispose()
  })

  it('routes workspace:search-symbols through the active session queryAndSchemaHub', async () => {
    const configService = new ConfigService(configPath)
    await configService.get()
    const ipcMain = createFakeIpcMain()

    const dispose = registerSingleWorkspaceIpc({
      ipcMain,
      workspaceService,
      configService,
      selectDirectory: async () => workspaceDir,
      getTargets: () => []
    })

    const opened = (await ipcMain.invoke(WORKSPACE_IPC_CHANNELS.open, workspaceDir)) as {
      rootPath: string
    }
    await writeFile(
      join(opened.rootPath, 'math.ts'),
      'export function sumValues(a: number, b: number) { return a + b }\n',
      'utf8'
    )

    const matches = await ipcMain.invoke<SymbolCandidateMatch[]>(
      WORKSPACE_IPC_CHANNELS.searchSymbols,
      {
        symbolName: 'sumValues',
        scope: { kind: 'working-tree' }
      }
    )
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      path: 'math.ts',
      lineNumber: 1,
      columnStart: 16,
      columnEnd: 25
    })

    dispose()
  })
})
