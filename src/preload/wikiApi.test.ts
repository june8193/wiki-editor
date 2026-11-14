import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from '@shared/config'
import { CONFIG_IPC_CHANNELS } from '@shared/ipc'
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
})
