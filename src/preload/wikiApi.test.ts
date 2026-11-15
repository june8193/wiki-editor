import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/config'
import {
  type AppMenuCommand,
  CLIPBOARD_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  DIAGRAM_IPC_CHANNELS,
  type DiagramSaveRequest,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
  WINDOW_IPC_CHANNELS,
  WORKSPACE_IPC_CHANNELS
} from '@shared/ipc'
import type { RendererLogPayload } from '@shared/logging'
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
    await api.workspace.readDir('C:\\wiki\\docs')
    await api.workspace.listMarkdownFiles()
    await api.workspace.readFile('C:\\wiki\\readme.md')
    await api.workspace.writeFile('C:\\wiki\\readme.md', '# Hi')
    await api.workspace.createEntry('C:\\wiki', 'note.md', 'file', '')
    await api.workspace.renameEntry('C:\\wiki\\note.md', 'guide.md')
    await api.workspace.deleteEntry('C:\\wiki\\guide.md')
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
      WORKSPACE_IPC_CHANNELS.readDir,
      WORKSPACE_IPC_CHANNELS.listMarkdownFiles,
      WORKSPACE_IPC_CHANNELS.readFile,
      WORKSPACE_IPC_CHANNELS.writeFile,
      WORKSPACE_IPC_CHANNELS.createEntry,
      WORKSPACE_IPC_CHANNELS.renameEntry,
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
    await api.git.commit('C:\\wiki', 'feat: add note')
    await api.git.branches('C:\\wiki')
    await api.git.checkout('C:\\wiki', 'main')
    await api.git.pull('C:\\wiki')
    await api.git.push('C:\\wiki')
    await api.git.sync('C:\\wiki')
    await api.git.log('C:\\wiki')
    await api.git.log('C:\\wiki', { scope: 'current', limit: 50, skip: 20 })
    await api.git.commitDetail('C:\\wiki', 'abc1234')
    await api.git.diff('C:\\wiki', { kind: 'staged', path: 'a.md', status: 'M' })

    expect(ipc.lastInvoked).toEqual([
      { channel: GIT_IPC_CHANNELS.status, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.init, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.stage, args: ['C:\\wiki', ['a.md']] },
      { channel: GIT_IPC_CHANNELS.stageAll, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.unstage, args: ['C:\\wiki', ['a.md']] },
      { channel: GIT_IPC_CHANNELS.unstageAll, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.commit, args: ['C:\\wiki', 'feat: add note'] },
      { channel: GIT_IPC_CHANNELS.branches, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.checkout, args: ['C:\\wiki', 'main'] },
      { channel: GIT_IPC_CHANNELS.pull, args: ['C:\\wiki'] },
      { channel: GIT_IPC_CHANNELS.push, args: ['C:\\wiki'] },
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
      }
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

  it('subscribes to menu:command without exposing Electron event and cleans up on unsubscribe', () => {
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
  })

  it('subscribes to window:close-requested without exposing Electron event and sends window:close-response', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)
    const receivedArgs: unknown[][] = []

    const unsubscribe = api.window.onCloseRequested((...args: unknown[]) => {
      receivedArgs.push(args)
    })

    expect(ipc.listenerCount(WINDOW_IPC_CHANNELS.closeRequested)).toBe(1)

    ipc.emit(WINDOW_IPC_CHANNELS.closeRequested, { secret: 'should-not-leak' })
    expect(receivedArgs).toEqual([[]])

    await api.window.respondClose('confirming')
    await api.window.respondClose('close')
    await api.window.respondClose('cancel')

    expect(ipc.lastInvoked).toEqual([
      { channel: WINDOW_IPC_CHANNELS.closeResponse, args: ['confirming'] },
      { channel: WINDOW_IPC_CHANNELS.closeResponse, args: ['close'] },
      { channel: WINDOW_IPC_CHANNELS.closeResponse, args: ['cancel'] }
    ])

    unsubscribe()
    expect(ipc.listenerCount(WINDOW_IPC_CHANNELS.closeRequested)).toBe(0)

    ipc.emit(WINDOW_IPC_CHANNELS.closeRequested, undefined)
    expect(receivedArgs).toHaveLength(1)
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
})
