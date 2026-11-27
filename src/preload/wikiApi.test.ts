import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/config'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import {
  type AppMenuCommand,
  BUFFER_IPC_CHANNELS,
  CLIPBOARD_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  DIAGRAM_IPC_CHANNELS,
  type DiagramSaveRequest,
  FRONTMATTER_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
  SHELL_IPC_CHANNELS,
  TERMINAL_IPC_CHANNELS,
  WINDOW_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS,
  WORKSPACE_STATE_IPC_CHANNELS
} from '@shared/ipc'
import type { FrontmatterSchemaLoadResult, WorkspaceFrontmatterSchema } from '@shared/frontmatter'
import type { RendererLogPayload } from '@shared/logging'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import type { ActiveTabDragSession } from '@shared/window'
import { createWikiApi, IpcRendererLike } from './wikiApi'

function createFakeIpcRenderer(): IpcRendererLike & {
  emit(channel: string, payload: unknown): void
  listenerCount(channel: string): number
  lastInvoked: Array<{ channel: string; args: unknown[] }>
} {
  const listeners = new Map<string, Set<(_event: unknown, ...args: unknown[]) => void>>()
  const lastInvoked: Array<{ channel: string; args: unknown[] }> = []

  return {
    lastInvoked,
    async invoke(channel, ...args) {
      lastInvoked.push({ channel, args })
      if (channel === CONFIG_IPC_CHANNELS.getPath) {
        return 'C:\\temp\\config.json'
      }
      if (channel === CONFIG_IPC_CHANNELS.readRaw) {
        return '{"version":1}'
      }
      if (channel === CONFIG_IPC_CHANNELS.update) {
        return { ...DEFAULT_APP_CONFIG, ...(args[0] as object) }
      }
      if (channel === DIAGRAM_IPC_CHANNELS.saveFile) {
        return { canceled: false, filePath: 'C:\\exports\\guide-diagram.png' }
      }
      return DEFAULT_APP_CONFIG
    },
    on(channel, listener) {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener)
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) {
        listener({}, payload)
      }
    },
    listenerCount(channel) {
      return listeners.get(channel)?.size ?? 0
    }
  }
}

describe('createWikiApi', () => {
  it('routes config get, update, getConfigPath, and readRaw through expected IPC channels', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    expect(await api.config.get()).toEqual(DEFAULT_APP_CONFIG)
    expect(await api.config.update({ theme: 'dark' })).toMatchObject({ theme: 'dark' })
    expect(await api.config.getConfigPath()).toBe('C:\\temp\\config.json')
    expect(await api.config.readRaw()).toBe('{"version":1}')

    expect(ipc.lastInvoked).toEqual([
      { channel: CONFIG_IPC_CHANNELS.get, args: [] },
      { channel: CONFIG_IPC_CHANNELS.update, args: [{ theme: 'dark' }] },
      { channel: CONFIG_IPC_CHANNELS.getPath, args: [] },
      { channel: CONFIG_IPC_CHANNELS.readRaw, args: [] }
    ])
  })

  it('subscribes to config:changed without exposing Electron event and cleans up on unsubscribe', () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const received: unknown[] = []

    const unsubscribe = api.config.onChanged((cfg) => {
      received.push(cfg)
    })

    expect(ipc.listenerCount(CONFIG_IPC_CHANNELS.changed)).toBe(1)

    const updated = { ...DEFAULT_APP_CONFIG, theme: 'dark' as const }
    ipc.emit(CONFIG_IPC_CHANNELS.changed, updated)
    expect(received).toEqual([updated])

    unsubscribe()
    expect(ipc.listenerCount(CONFIG_IPC_CHANNELS.changed)).toBe(0)

    ipc.emit(CONFIG_IPC_CHANNELS.changed, DEFAULT_APP_CONFIG)
    expect(received).toHaveLength(1)
  })

  it('routes config saveRaw/favorites and workspace:* methods through expected IPC channels', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const wsEvents: unknown[] = []

    await api.config.saveRaw('{"version":1}')
    await api.config.toggleFavoriteWorkspace('C:\\wiki', 'Wiki')
    await api.config.removeFavoriteWorkspace('C:\\wiki')

    await api.workspace.selectFolder()
    await api.workspace.open('C:\\wiki')
    await api.workspace.openInNewWindow?.('C:\\wiki-other')
    expect('activateOrOpen' in api.workspace).toBe(false)
    expect('activateOrOpen' in WORKSPACE_IPC_CHANNELS).toBe(false)
    await api.workspace.focusIfOpen?.('C:\\wiki-other')
    await api.workspace.readDir('C:\\wiki\\docs')
    await api.workspace.listMarkdownFiles()
    const searchRequest = { query: 'needle', options: DEFAULT_SEARCH_MATCH_OPTIONS }
    await api.workspace.search?.(searchRequest)
    await api.workspace.searchSymbols?.({
      symbolName: 'needle',
      scope: { kind: 'working-tree' }
    })
    await api.workspace.readFile('C:\\wiki\\readme.md')
    await api.workspace.writeFile('C:\\wiki\\readme.md', '# Hi')
    await api.workspace.createEntry('C:\\wiki', 'note.md', 'file', '')
    await api.workspace.renameEntry('C:\\wiki\\note.md', 'guide.md')
    await api.workspace.moveEntries(['C:\\wiki\\guide.md'], 'C:\\wiki\\docs')
    await api.workspace.deleteEntry('C:\\wiki\\docs\\guide.md')
    await api.workspace.watch()
    const unsubWs = api.workspace.onChanged((event) => wsEvents.push(event))
    ipc.emit(WORKSPACE_IPC_CHANNELS.changed, {
      rootPath: 'C:\\wiki',
      eventType: 'change',
      relativePath: 'guide.md'
    })
    expect(wsEvents).toHaveLength(1)
    unsubWs()
    expect(ipc.listenerCount(WORKSPACE_IPC_CHANNELS.changed)).toBe(0)
    await api.workspace.unwatch()

    expect(ipc.lastInvoked.map((item) => item.channel)).toEqual([
      CONFIG_IPC_CHANNELS.saveRaw,
      CONFIG_IPC_CHANNELS.toggleFavoriteWorkspace,
      CONFIG_IPC_CHANNELS.removeFavoriteWorkspace,
      WORKSPACE_IPC_CHANNELS.selectFolder,
      WORKSPACE_IPC_CHANNELS.open,
      WORKSPACE_IPC_CHANNELS.openInNewWindow,
      WORKSPACE_IPC_CHANNELS.focusIfOpen,
      WORKSPACE_IPC_CHANNELS.readDir,
      WORKSPACE_IPC_CHANNELS.listMarkdownFiles,
      WORKSPACE_IPC_CHANNELS.search,
      WORKSPACE_IPC_CHANNELS.searchSymbols,
      WORKSPACE_IPC_CHANNELS.readFile,
      WORKSPACE_IPC_CHANNELS.writeFile,
      WORKSPACE_IPC_CHANNELS.createEntry,
      WORKSPACE_IPC_CHANNELS.renameEntry,
      WORKSPACE_IPC_CHANNELS.moveEntries,
      WORKSPACE_IPC_CHANNELS.deleteEntry,
      WORKSPACE_IPC_CHANNELS.watch,
      WORKSPACE_IPC_CHANNELS.unwatch
    ])
  })

  it('routes all git:* methods through expected IPC channels with exact arguments', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.git.status('C:\\wiki')
    await api.git.init('C:\\wiki')
    await api.git.stage('C:\\wiki', ['a.md'])
    await api.git.stageAll('C:\\wiki')
    await api.git.unstage('C:\\wiki', ['a.md'])
    await api.git.unstageAll('C:\\wiki')
    await api.git.discard('C:\\wiki', ['a.md'])
    await api.git.discardAll('C:\\wiki')
    await api.git.commit('C:\\wiki', 'feat: add note')
    await api.git.branches('C:\\wiki')
    await api.git.checkout('C:\\wiki', 'main')
    await api.git.pull('C:\\wiki')
    await api.git.push('C:\\wiki')
    await api.git.fetch('C:\\wiki')
    await api.git.sync('C:\\wiki')
    await api.git.log('C:\\wiki')
    await api.git.log('C:\\wiki', { scope: 'current', limit: 50, skip: 20 })
    await api.git.commitDetail('C:\\wiki', 'abc1234')
    await api.git.diff('C:\\wiki', { kind: 'staged', path: 'a.md', status: 'M' })
    await api.git.diff('C:\\wiki', {
      kind: 'stash',
      stashRef: 'stash@{0}',
      stashHash: '1234567890abcdef1234567890abcdef12345678',
      path: 'draft.md',
      status: '?'
    })
    await api.git.readBlobSnapshot('C:\\wiki', {
      path: 'src/app.ts',
      scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
    })
    await api.git.stashList('C:\\wiki')
    await api.git.stashDetail('C:\\wiki', 'stash@{0}')
    await api.git.stashCreate('C:\\wiki', {
      scope: 'unstaged',
      message: 'wip draft',
      includeUntracked: true
    })
    await api.git.stashApply('C:\\wiki', 'stash@{0}')
    await api.git.stashPop('C:\\wiki', 'stash@{0}')
    await api.git.stashDrop('C:\\wiki', 'stash@{0}')
    await api.git.stashClear('C:\\wiki')

    expect(ipc.lastInvoked).toEqual([
      { channel: GIT_IPC_CHANNELS.status, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.init, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.stage, args: ['C:\\wiki', ['a.md']] },
      { channel: GIT_IPC_CHANNELS.stageAll, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.unstage, args: ['C:\\wiki', ['a.md']] },
      { channel: GIT_IPC_CHANNELS.unstageAll, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.discard, args: ['C:\\wiki', ['a.md']] },
      { channel: GIT_IPC_CHANNELS.discardAll, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.commit, args: ['C:\\wiki', 'feat: add note'] },
      { channel: GIT_IPC_CHANNELS.branches, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.checkout, args: ['C:\\wiki', 'main'] },
      { channel: GIT_IPC_CHANNELS.pull, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.push, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.fetch, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.sync, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.log, args: ['C:\\wiki', undefined] },
      {
        channel: GIT_IPC_CHANNELS.log,
        args: ['C:\\wiki', { scope: 'current', limit: 50, skip: 20 }]
      },
      { channel: GIT_IPC_CHANNELS.commitDetail, args: ['C:\\wiki', 'abc1234'] },
      {
        channel: GIT_IPC_CHANNELS.diff,
        args: ['C:\\wiki', { kind: 'staged', path: 'a.md', status: 'M' }]
      },
      {
        channel: GIT_IPC_CHANNELS.diff,
        args: [
          'C:\\wiki',
          {
            kind: 'stash',
            stashRef: 'stash@{0}',
            stashHash: '1234567890abcdef1234567890abcdef12345678',
            path: 'draft.md',
            status: '?'
          }
        ]
      },
      {
        channel: GIT_IPC_CHANNELS.readBlobSnapshot,
        args: [
          'C:\\wiki',
          {
            path: 'src/app.ts',
            scope: { kind: 'git-ref', ref: 'HEAD', displayRef: 'HEAD' }
          }
        ]
      },
      { channel: GIT_IPC_CHANNELS.stashList, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.stashDetail, args: ['C:\\wiki', 'stash@{0}'] },
      {
        channel: GIT_IPC_CHANNELS.stashCreate,
        args: [
          'C:\\wiki',
          { scope: 'unstaged', message: 'wip draft', includeUntracked: true }
        ]
      },
      { channel: GIT_IPC_CHANNELS.stashApply, args: ['C:\\wiki', 'stash@{0}'] },
      { channel: GIT_IPC_CHANNELS.stashPop, args: ['C:\\wiki', 'stash@{0}'] },
      { channel: GIT_IPC_CHANNELS.stashDrop, args: ['C:\\wiki', 'stash@{0}'] },
      { channel: GIT_IPC_CHANNELS.stashClear, args: ['C:\\wiki'] }
    ])
  })

  it('routes log.write through log:write IPC channel with exact RendererLogPayload', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const payload: RendererLogPayload = {
      level: 'warn',
      category: 'ui',
      message: 'Mermaid diagram rendering failed',
      data: { codeLength: 42 },
      error: { name: 'SyntaxError', message: 'Parse error' }
    }

    await api.log.write(payload)

    expect(ipc.lastInvoked).toEqual([{ channel: LOG_IPC_CHANNELS.write, args: [payload] }])
  })

  it('routes clipboard.writeText through clipboard:write-text IPC channel with exact text', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.clipboard.writeText('guides/setup.md')

    expect(ipc.lastInvoked).toEqual([
      { channel: CLIPBOARD_IPC_CHANNELS.writeText, args: ['guides/setup.md'] }
    ])
  })

  it('routes diagram.copyText, diagram.copyImage, and diagram.saveFile through expected IPC channels with exact payloads', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const diagramSource = 'flowchart LR\n  A --> B'
    const pngBytes = new Uint8Array([137, 80, 78, 71])
    const saveRequest: DiagramSaveRequest = {
      format: 'png',
      suggestedName: 'guide-diagram.png',
      data: pngBytes
    }

    await api.diagram.copyText(diagramSource)
    await api.diagram.copyImage(pngBytes)
    const saveResult = await api.diagram.saveFile(saveRequest)

    expect(saveResult).toEqual({
      canceled: false,
      filePath: 'C:\\exports\\guide-diagram.png'
    })
    expect(ipc.lastInvoked).toEqual([
      { channel: DIAGRAM_IPC_CHANNELS.copyText, args: [diagramSource] },
      { channel: DIAGRAM_IPC_CHANNELS.copyImage, args: [pngBytes] },
      { channel: DIAGRAM_IPC_CHANNELS.saveFile, args: [saveRequest] }
    ])
  })

  it('subscribes to menu:command without exposing Electron event and cleans up on unsubscribe', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const commands: AppMenuCommand[] = []

    const unsubscribe = api.menu.onCommand((command) => {
      commands.push(command)
    })

    expect(ipc.listenerCount(MENU_IPC_CHANNELS.command)).toBe(1)

    ipc.emit(MENU_IPC_CHANNELS.command, 'open-folder')
    ipc.emit(MENU_IPC_CHANNELS.command, 'toggle-theme')
    ipc.emit(MENU_IPC_CHANNELS.command, 'toggle-settings')
    expect(commands).toEqual(['open-folder', 'toggle-theme', 'toggle-settings'])

    unsubscribe()
    expect(ipc.listenerCount(MENU_IPC_CHANNELS.command)).toBe(0)

    ipc.emit(MENU_IPC_CHANNELS.command, 'open-folder')
    expect(commands).toHaveLength(3)

    await api.menu.runAction?.('show-version')
    expect(ipc.lastInvoked).toEqual([
      { channel: MENU_IPC_CHANNELS.runAction, args: ['show-version'] }
    ])
  })

  it('exposes workspace.ingestImage via IPC and workspace.getPathForFile via injected resolver', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc, {
      getPathForFile: (file) => `C:\\drops\\${file.name}`
    })

    const ingestInput = {
      documentPath: 'C:\\wiki\\note.md',
      source: { kind: 'filePath' as const, filePath: 'C:\\drops\\pic.png' }
    }
    await api.workspace.ingestImage(ingestInput)

    expect(ipc.lastInvoked).toEqual([
      { channel: WORKSPACE_IPC_CHANNELS.ingestImage, args: [ingestInput] }
    ])
    expect(api.workspace.getPathForFile({ name: 'pic.png' } as File)).toBe('C:\\drops\\pic.png')

    const fallbackApi = createWikiApi(ipc)
    expect(fallbackApi.workspace.getPathForFile({ name: 'pic.png' } as File)).toBe('')
  })

  it('routes all buffer:* methods through expected IPC channels and unsubscribes buffer:event', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.buffer.getSnapshot()
    await api.buffer.openWorkspaceFile('C:\\wiki\\note.md', 'note.md', '')
    await api.buffer.openConfigDocument()
    await api.buffer.refreshCleanConfig()
    await api.buffer.updateContent('c:/wiki/note.md', '# Updated')
    await api.buffer.setEncoding('c:/wiki/note.md', 'euc-kr')
    await api.buffer.reopenWithEncoding('c:/wiki/note.md', 'utf-8')
    await api.buffer.saveBuffer('c:/wiki/note.md')
    await api.buffer.saveBuffer('c:/wiki/note.md', { allowLossy: true })
    await api.buffer.syncWindowTabs(['c:/wiki/note.md'])
    await api.buffer.setAutoSavePaused(true)
    await api.buffer.syncRenamedPath('C:\\wiki\\note.md', 'C:\\wiki\\renamed.md')
    await api.buffer.syncDeletedPath('C:\\wiki\\renamed.md')
    await api.buffer.reconcileWorkspaceBuffersWithDisk()
    await api.buffer.prepareDiscardPaths(['C:\\wiki\\renamed.md'])
    await api.buffer.finishDiscardPaths(['C:\\wiki\\renamed.md'], true)
    await api.buffer.clearWorkspaceBuffers()

    expect(ipc.lastInvoked).toEqual([
      { channel: BUFFER_IPC_CHANNELS.getSnapshot, args: [] },
      {
        channel: BUFFER_IPC_CHANNELS.openWorkspaceFile,
        args: ['C:\\wiki\\note.md', 'note.md', '']
      },
      { channel: BUFFER_IPC_CHANNELS.openConfigDocument, args: [] },
      { channel: BUFFER_IPC_CHANNELS.refreshCleanConfig, args: [] },
      { channel: BUFFER_IPC_CHANNELS.updateContent, args: ['c:/wiki/note.md', '# Updated'] },
      { channel: BUFFER_IPC_CHANNELS.setEncoding, args: ['c:/wiki/note.md', 'euc-kr'] },
      { channel: BUFFER_IPC_CHANNELS.reopenWithEncoding, args: ['c:/wiki/note.md', 'utf-8'] },
      { channel: BUFFER_IPC_CHANNELS.saveBuffer, args: ['c:/wiki/note.md'] },
      { channel: BUFFER_IPC_CHANNELS.saveBuffer, args: ['c:/wiki/note.md', { allowLossy: true }] },
      { channel: BUFFER_IPC_CHANNELS.syncWindowTabs, args: [['c:/wiki/note.md']] },
      { channel: BUFFER_IPC_CHANNELS.setAutoSavePaused, args: [true] },
      {
        channel: BUFFER_IPC_CHANNELS.syncRenamedPath,
        args: ['C:\\wiki\\note.md', 'C:\\wiki\\renamed.md']
      },
      { channel: BUFFER_IPC_CHANNELS.syncDeletedPath, args: ['C:\\wiki\\renamed.md'] },
      { channel: BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk, args: [] },
      { channel: BUFFER_IPC_CHANNELS.prepareDiscardPaths, args: [['C:\\wiki\\renamed.md']] },
      { channel: BUFFER_IPC_CHANNELS.finishDiscardPaths, args: [['C:\\wiki\\renamed.md'], true] },
      { channel: BUFFER_IPC_CHANNELS.clearWorkspaceBuffers, args: [] }
    ])

    const received: SharedBufferHubEvent[] = []
    const unsubscribe = api.buffer.onEvent((event) => {
      received.push(event)
    })
    expect(ipc.listenerCount(BUFFER_IPC_CHANNELS.event)).toBe(1)

    const sampleEvent: SharedBufferHubEvent = {
      type: 'state-changed',
      snapshot: { buffers: {}, tabCounts: {} }
    }
    ipc.emit(BUFFER_IPC_CHANNELS.event, sampleEvent)
    expect(received).toEqual([sampleEvent])

    unsubscribe()
    expect(ipc.listenerCount(BUFFER_IPC_CHANNELS.event)).toBe(0)
  })

  it('derives window.role synchronously from query string and routes window:* IPC calls', async () => {
    const mainApi = createWikiApi(createFakeIpcRenderer())
    expect(mainApi.window.role).toBe('main')

    const auxIpc = createFakeIpcRenderer()
    const auxApi = createWikiApi(auxIpc, '?foo=1&windowRole=auxiliary')
    expect(auxApi.window.role).toBe('auxiliary')

    const transferPayload = {
      bufferKey: 'c:/wiki/note.md',
      mode: 'wysiwyg' as const,
      cursor: { selectionStart: 3, selectionEnd: 7 },
      scrollTop: 140
    }
    await auxApi.window.getInitContext()
    await auxApi.window.detachTabToNewWindow(transferPayload)
    await auxApi.window.startTabDrag({
      paneId: 'primary',
      tabId: 'tab-1',
      payload: transferPayload
    })
    await auxApi.window.updateTabDragOutcome('drag-1', 'cancelled')
    await auxApi.window.acceptTabDragDrop({ dragSessionId: 'drag-1' })
    await auxApi.window.endTabDrag({
      dragSessionId: 'drag-1',
      screenPoint: { x: 1500, y: 300 },
      payload: transferPayload
    })
    await auxApi.window.closeCurrent()
    await auxApi.window.resolveCloseRequest(false)
    await auxApi.window.setCloseFlushEnabled?.(true)

    let closeRequestCount = 0
    const unsubscribeCloseRequested = auxApi.window.onCloseRequested(() => {
      closeRequestCount += 1
    })
    expect(auxIpc.listenerCount(WINDOW_IPC_CHANNELS.closeRequested)).toBe(1)
    auxIpc.emit(WINDOW_IPC_CHANNELS.closeRequested, undefined)
    expect(closeRequestCount).toBe(1)
    unsubscribeCloseRequested()
    expect(auxIpc.listenerCount(WINDOW_IPC_CHANNELS.closeRequested)).toBe(0)

    const dragEvents: Array<ActiveTabDragSession | null> = []
    const unsubscribeDrag = auxApi.window.onTabDragStateChanged((session) => {
      dragEvents.push(session)
    })
    expect(auxIpc.listenerCount(WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(1)
    const sampleSession: ActiveTabDragSession = {
      dragSessionId: 'drag-1',
      sourceWindowId: 100,
      paneId: 'primary',
      tabId: 'tab-1',
      payload: transferPayload,
      outcome: 'pending'
    }
    auxIpc.emit(WINDOW_IPC_CHANNELS.dragStateChanged, sampleSession)
    auxIpc.emit(WINDOW_IPC_CHANNELS.dragStateChanged, null)
    expect(dragEvents).toEqual([sampleSession, null])
    unsubscribeDrag()
    expect(auxIpc.listenerCount(WINDOW_IPC_CHANNELS.dragStateChanged)).toBe(0)

    expect(auxIpc.lastInvoked).toEqual([
      { channel: WINDOW_IPC_CHANNELS.getInitContext, args: [] },
      { channel: WINDOW_IPC_CHANNELS.detachTabToNewWindow, args: [transferPayload] },
      {
        channel: WINDOW_IPC_CHANNELS.startTabDrag,
        args: [{ paneId: 'primary', tabId: 'tab-1', payload: transferPayload }]
      },
      {
        channel: WINDOW_IPC_CHANNELS.updateTabDragOutcome,
        args: ['drag-1', 'cancelled']
      },
      {
        channel: WINDOW_IPC_CHANNELS.acceptTabDragDrop,
        args: [{ dragSessionId: 'drag-1' }]
      },
      {
        channel: WINDOW_IPC_CHANNELS.endTabDrag,
        args: [
          {
            dragSessionId: 'drag-1',
            screenPoint: { x: 1500, y: 300 },
            payload: transferPayload
          }
        ]
      },
      { channel: WINDOW_IPC_CHANNELS.closeCurrent, args: [] },
      { channel: WINDOW_IPC_CHANNELS.resolveCloseRequest, args: [false] },
      { channel: WINDOW_IPC_CHANNELS.setCloseFlushEnabled, args: [true] }
    ])
  })

  it('routes workspaceState.get and workspaceState.save through expected IPC channels', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const update = { expandedDirs: ['C:\\wiki\\docs'] }

    await api.workspaceState.get('C:\\wiki')
    await api.workspaceState.save('C:\\wiki', update)

    expect(ipc.lastInvoked).toEqual([
      { channel: WORKSPACE_STATE_IPC_CHANNELS.get, args: ['C:\\wiki'] },
      { channel: WORKSPACE_STATE_IPC_CHANNELS.save, args: ['C:\\wiki', update] }
    ])
  })

  it('routes frontmatter schema methods through expected IPC channels and unsubscribes schemaChanged', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const sampleSchema: WorkspaceFrontmatterSchema = {
      version: 1,
      fields: [{ key: 'status', label: '상태', type: 'text' }]
    }

    await api.frontmatter.getSchema()
    await api.frontmatter.createDefaultSchema()
    await api.frontmatter.saveSchema(sampleSchema)
    expect(api.frontmatter.getFieldValues).toBeDefined()
    await api.frontmatter.getFieldValues?.()
    await api.frontmatter.getFieldValues?.(['labels'])

    expect(ipc.lastInvoked).toEqual([
      { channel: FRONTMATTER_IPC_CHANNELS.getSchema, args: [] },
      { channel: FRONTMATTER_IPC_CHANNELS.createDefaultSchema, args: [] },
      { channel: FRONTMATTER_IPC_CHANNELS.saveSchema, args: [sampleSchema] },
      { channel: FRONTMATTER_IPC_CHANNELS.getFieldValues, args: [] },
      { channel: FRONTMATTER_IPC_CHANNELS.getFieldValues, args: [['labels']] }
    ])

    const received: FrontmatterSchemaLoadResult[] = []
    const unsubscribe = api.frontmatter.onSchemaChanged((result) => received.push(result))
    expect(ipc.listenerCount(FRONTMATTER_IPC_CHANNELS.schemaChanged)).toBe(1)

    const sampleEvent: FrontmatterSchemaLoadResult = {
      exists: true,
      path: 'C:\\wiki\\.wiki-editor\\frontmatter.json',
      schema: sampleSchema
    }
    ipc.emit(FRONTMATTER_IPC_CHANNELS.schemaChanged, sampleEvent)
    expect(received).toEqual([sampleEvent])

    unsubscribe()
    expect(ipc.listenerCount(FRONTMATTER_IPC_CHANNELS.schemaChanged)).toBe(0)
  })

  it('routes terminal.* methods through expected IPC channels and unsubscribes data/exit listeners', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.terminal.listProfiles()
    await api.terminal.createSession({ profileId: 'pwsh', cols: 100, rows: 30 })
    await api.terminal.write('term-1', 'echo hi\r')
    await api.terminal.resize('term-1', 120, 40)
    await api.terminal.closeSession('term-1')
    await api.terminal.openExternalUrl('https://example.com')

    expect(ipc.lastInvoked).toEqual([
      { channel: TERMINAL_IPC_CHANNELS.listProfiles, args: [] },
      {
        channel: TERMINAL_IPC_CHANNELS.createSession,
        args: [{ profileId: 'pwsh', cols: 100, rows: 30 }]
      },
      { channel: TERMINAL_IPC_CHANNELS.write, args: ['term-1', 'echo hi\r'] },
      { channel: TERMINAL_IPC_CHANNELS.resize, args: ['term-1', 120, 40] },
      { channel: TERMINAL_IPC_CHANNELS.closeSession, args: ['term-1'] },
      { channel: TERMINAL_IPC_CHANNELS.openExternalUrl, args: ['https://example.com'] }
    ])

    const dataEvents: unknown[] = []
    const exitEvents: unknown[] = []
    const unsubData = api.terminal.onData((event) => dataEvents.push(event))
    const unsubExit = api.terminal.onExit((event) => exitEvents.push(event))

    ipc.emit(TERMINAL_IPC_CHANNELS.data, { sessionId: 'term-1', data: 'hi\r\n' })
    ipc.emit(TERMINAL_IPC_CHANNELS.exit, { sessionId: 'term-1', exitCode: 0 })
    expect(dataEvents).toEqual([{ sessionId: 'term-1', data: 'hi\r\n' }])
    expect(exitEvents).toEqual([{ sessionId: 'term-1', exitCode: 0 }])

    unsubData()
    unsubExit()
    expect(ipc.listenerCount(TERMINAL_IPC_CHANNELS.data)).toBe(0)
    expect(ipc.listenerCount(TERMINAL_IPC_CHANNELS.exit)).toBe(0)
  })

  it('routes shell.openExternalUrl through SHELL_IPC_CHANNELS.openExternalUrl', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.shell?.openExternalUrl('https://example.com/docs')
    expect(ipc.lastInvoked).toEqual([
      { channel: SHELL_IPC_CHANNELS.openExternalUrl, args: ['https://example.com/docs'] }
    ])
  })
})
