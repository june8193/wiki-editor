import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/config'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import {
  type AppMenuCommand,
  BUFFER_IPC_CHANNELS,
  CONFIG_IPC_CHANNELS,
  GIT_IPC_CHANNELS,
  LOG_IPC_CHANNELS,
  MENU_IPC_CHANNELS,
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
      { channel: GIT_IPC_CHANNELS.sync, args: ['C:\\wiki'] }
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

  it('routes all buffer:* methods through expected IPC channels and unsubscribes buffer:event', async () => {
    const ipc = createFakeIpcRenderer()
    const api = createWikiApi(ipc)

    await api.buffer.getSnapshot()
    await api.buffer.openWorkspaceFile('C:\\wiki\\note.md', 'note.md', '')
    await api.buffer.openConfigDocument()
    await api.buffer.refreshCleanConfig()
    await api.buffer.updateContent('c:/wiki/note.md', '# Updated')
    await api.buffer.saveBuffer('c:/wiki/note.md')
    await api.buffer.syncWindowTabs(['c:/wiki/note.md'])
    await api.buffer.setAutoSavePaused(true)
    await api.buffer.syncRenamedPath('C:\\wiki\\note.md', 'C:\\wiki\\renamed.md')
    await api.buffer.syncDeletedPath('C:\\wiki\\renamed.md')
    await api.buffer.reconcileWorkspaceBuffersWithDisk()

    expect(ipc.lastInvoked).toEqual([
      { channel: BUFFER_IPC_CHANNELS.getSnapshot, args: [] },
      {
        channel: BUFFER_IPC_CHANNELS.openWorkspaceFile,
        args: ['C:\\wiki\\note.md', 'note.md', '']
      },
      { channel: BUFFER_IPC_CHANNELS.openConfigDocument, args: [] },
      { channel: BUFFER_IPC_CHANNELS.refreshCleanConfig, args: [] },
      { channel: BUFFER_IPC_CHANNELS.updateContent, args: ['c:/wiki/note.md', '# Updated'] },
      { channel: BUFFER_IPC_CHANNELS.saveBuffer, args: ['c:/wiki/note.md'] },
      { channel: BUFFER_IPC_CHANNELS.syncWindowTabs, args: [['c:/wiki/note.md']] },
      { channel: BUFFER_IPC_CHANNELS.setAutoSavePaused, args: [true] },
      {
        channel: BUFFER_IPC_CHANNELS.syncRenamedPath,
        args: ['C:\\wiki\\note.md', 'C:\\wiki\\renamed.md']
      },
      { channel: BUFFER_IPC_CHANNELS.syncDeletedPath, args: ['C:\\wiki\\renamed.md'] },
      { channel: BUFFER_IPC_CHANNELS.reconcileWorkspaceBuffersWithDisk, args: [] }
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
})
