import { describe, expect, it, vi } from 'vitest'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import type { WikiBufferApi, WikiWindowApi } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { createHubBufferApi } from '../test/inMemoryWikiHarness'
import { PaneTabStore } from './PaneTabStore'
import { RendererBufferSyncClient } from './RendererBufferSyncClient'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function attachWindowClient(
  hub: SharedDocumentBufferHub,
  windowId: number,
  windowApi?: WikiWindowApi
) {
  const listeners = new Set<(event: SharedBufferHubEvent) => void>()
  const unsubscribeHub = hub.subscribe((event) => {
    for (const listener of listeners) {
      listener(event)
    }
  })
  const bufferApi = createHubBufferApi(hub, windowId, listeners)
  const bufferStore = new DocumentBufferStore()
  const tabStore = new PaneTabStore()
  const onError = vi.fn()
  const client = new RendererBufferSyncClient({
    bufferStore,
    tabStore,
    bufferApi,
    windowApi,
    onError,
    onConfirmCloseDirtyTab: vi.fn()
  })

  return {
    bufferApi,
    bufferStore,
    tabStore,
    client,
    onError,
    detach: unsubscribeHub
  }
}

function createHubClientHarness(windowId = 1, windowApi?: WikiWindowApi) {
  const files = new Map<string, string>([['C:/wiki/shared.md', '# Shared']])
  const hub = new SharedDocumentBufferHub({
    initialAutoSaveConfig: { autoSave: false },
    storage: {
      readWorkspaceFile: async (filePath) => files.get(filePath) ?? '',
      writeWorkspaceFile: async (filePath, content) => {
        files.set(filePath, content)
      },
      getConfigPath: async () => 'C:/Users/test/config.json',
      readConfigRaw: async () => '{}',
      saveConfigRaw: async () => ({})
    }
  })
  return { hub, files, ...attachWindowClient(hub, windowId, windowApi) }
}

describe('RendererBufferSyncClient race guards', () => {
  it('does not re-insert a closed buffer into local bufferStore when an in-flight updateContent settles', async () => {
    const { hub, bufferApi, bufferStore, tabStore, client } = createHubClientHarness(1)
    const stop = client.start()

    try {
      await client.openWorkspaceFile({
        name: 'shared.md',
        path: 'C:/wiki/shared.md',
        relativePath: 'shared.md',
        kind: 'file'
      })
      // Keep a remote window open on shared.md so latestHubBuffers keeps the entry after Win1 closes
      await hub.openWorkspaceFile('C:/wiki/shared.md', 'shared.md', undefined, 2)
      hub.syncWindowTabs(2, ['c:/wiki/shared.md'])
      hub.syncWindowTabs(1, ['c:/wiki/shared.md'])

      const deferredUpdate = createDeferred<void>()
      const origUpdate = bufferApi.updateContent.bind(bufferApi)
      bufferApi.updateContent = async (key, nextContent) => {
        await deferredUpdate.promise
        return origUpdate(key, nextContent)
      }

      client.updateBufferContent('c:/wiki/shared.md', '# Edited before close')
      const tab = tabStore.getSnapshot().panes.primary.tabs[0]
      client.forceCloseTab('primary', tab.id)
      expect(bufferStore.hasBuffer('c:/wiki/shared.md')).toBe(false)

      deferredUpdate.resolve()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(bufferStore.hasBuffer('c:/wiki/shared.md')).toBe(false)
    } finally {
      stop()
      hub.dispose()
    }
  })

  it('orders immediate updateBufferContent and save behind async openCreatedFile IPC', async () => {
    const { hub, files, bufferApi, tabStore, client } = createHubClientHarness(1)
    const stop = client.start()

    try {
      const openGate = createDeferred()
      const origOpen = bufferApi.openWorkspaceFile.bind(bufferApi)
      bufferApi.openWorkspaceFile = async (filePath, name, initialContent) => {
        await openGate.promise
        return origOpen(filePath, name, initialContent)
      }

      const createdEntry = {
        name: 'fresh.md',
        path: 'C:/wiki/fresh.md',
        relativePath: 'fresh.md',
        kind: 'file' as const
      }
      client.openCreatedFile(createdEntry)
      client.updateBufferContent('c:/wiki/fresh.md', '# First line on new file')
      const createdTab = tabStore.getSnapshot().panes.primary.tabs[0]
      const savePromise = client.saveAndCloseTab('primary', createdTab.id)

      openGate.resolve()
      const saved = await savePromise

      expect(saved).toBe(true)
      expect(files.get('C:/wiki/fresh.md')).toBe('# First line on new file')
    } finally {
      stop()
      hub.dispose()
    }
  })

  it('redirects in-flight openWorkspaceFile to the remapped key when another window renames concurrently', async () => {
    const win1 = createHubClientHarness(1)
    const { hub, files } = win1
    files.set('C:/wiki/a.md', '# Original A')

    const stop1 = win1.client.start()
    const win2 = attachWindowClient(hub, 2)
    const stop2 = win2.client.start()

    try {
      await win1.client.openWorkspaceFile({
        name: 'a.md',
        path: 'C:/wiki/a.md',
        relativePath: 'a.md',
        kind: 'file'
      })
      hub.syncWindowTabs(1, ['c:/wiki/a.md'])

      const openGate = createDeferred<Awaited<ReturnType<WikiBufferApi['openWorkspaceFile']>>>()
      win2.bufferApi.openWorkspaceFile = async () => openGate.promise

      const preRenameBuf = await hub.openWorkspaceFile('C:/wiki/a.md', 'a.md', undefined, 2)
      const openWin2Promise = win2.client.openWorkspaceFile({
        name: 'a.md',
        path: 'C:/wiki/a.md',
        relativePath: 'a.md',
        kind: 'file'
      })

      files.delete('C:/wiki/a.md')
      files.set('C:/wiki/b.md', '# Original A')
      hub.syncRenamedPath('C:/wiki/a.md', 'C:/wiki/b.md')

      openGate.resolve(preRenameBuf)
      await openWin2Promise
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(win2.tabStore.getBufferKeys()).toEqual(['c:/wiki/b.md'])
      expect(win2.bufferStore.hasBuffer('c:/wiki/b.md')).toBe(true)
      expect(win2.bufferStore.hasBuffer('c:/wiki/a.md')).toBe(false)
    } finally {
      stop1()
      stop2()
      win1.detach()
      win2.detach()
      hub.dispose()
    }
  })

  it('preserves unsynced local edits, surfaces onError, and retries updateContent before save when IPC fails', async () => {
    const { hub, files, bufferApi, bufferStore, tabStore, client, onError } =
      createHubClientHarness(1)
    const stop = client.start()

    try {
      await client.openWorkspaceFile({
        name: 'shared.md',
        path: 'C:/wiki/shared.md',
        relativePath: 'shared.md',
        kind: 'file'
      })
      hub.syncWindowTabs(1, ['c:/wiki/shared.md'])

      const origUpdate = bufferApi.updateContent.bind(bufferApi)
      bufferApi.updateContent = async () => {
        throw new Error('IPC update failed')
      }

      client.updateBufferContent('c:/wiki/shared.md', '# Unsynced edit')
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(onError).toHaveBeenCalled()
      expect(bufferStore.getBuffer('c:/wiki/shared.md')?.content).toBe('# Unsynced edit')
      expect(bufferStore.getBuffer('c:/wiki/shared.md')?.isDirty).toBe(true)

      const tab = tabStore.getSnapshot().panes.primary.tabs[0]
      expect(await client.saveAndCloseTab('primary', tab.id)).toBe(false)
      expect(tabStore.getBufferKeys()).toEqual(['c:/wiki/shared.md'])

      bufferApi.updateContent = origUpdate
      expect(await client.saveAndCloseTab('primary', tab.id)).toBe(true)
      expect(files.get('C:/wiki/shared.md')).toBe('# Unsynced edit')
    } finally {
      stop()
      hub.dispose()
    }
  })

  it('re-pushes unsynced local edits after an earlier updateContent failure before detaching a tab', async () => {
    const detachTabCalls: unknown[] = []
    let hubRef!: SharedDocumentBufferHub
    const windowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async (payload) => {
        detachTabCalls.push(payload)
        hubRef.registerPendingTransfer(2, payload.bufferKey)
        return { windowId: 2 }
      },
      startTabDrag: async (input) => ({
        dragSessionId: 'drag-1',
        sourceWindowId: 1,
        paneId: input.paneId,
        tabId: input.tabId,
        payload: input.payload,
        outcome: 'pending'
      }),
      updateTabDragOutcome: async () => null,
      endTabDrag: async () => ({ detached: false, outcome: 'cancelled' }),
      onTabDragStateChanged: () => () => undefined,
      closeCurrent: async () => undefined
    }
    const { hub, bufferApi, bufferStore, tabStore, client, onError } = createHubClientHarness(
      1,
      windowApi
    )
    hubRef = hub
    const stop = client.start()

    try {
      await client.openWorkspaceFile({
        name: 'shared.md',
        path: 'C:/wiki/shared.md',
        relativePath: 'shared.md',
        kind: 'file'
      })
      hub.syncWindowTabs(1, ['c:/wiki/shared.md'])

      const origUpdate = bufferApi.updateContent.bind(bufferApi)
      bufferApi.updateContent = async () => {
        throw new Error('IPC update failed')
      }

      client.updateBufferContent('c:/wiki/shared.md', '# Unsynced detach edit')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(onError).toHaveBeenCalled()
      expect(hub.getSnapshot().buffers['c:/wiki/shared.md']?.content).toBe('# Shared')

      const tab = tabStore.getSnapshot().panes.primary.tabs[0]

      // While updateContent continues failing, detach must abort and preserve the source tab
      await client.detachTabToNewWindow('primary', tab.id)
      expect(detachTabCalls).toHaveLength(0)
      expect(tabStore.getBufferKeys()).toEqual(['c:/wiki/shared.md'])

      // Once IPC recovers, detach flushes the unsynced local edit to the hub before detaching
      bufferApi.updateContent = origUpdate
      await client.detachTabToNewWindow('primary', tab.id)
      expect(detachTabCalls).toHaveLength(1)
      expect(hub.getSnapshot().buffers['c:/wiki/shared.md']?.content).toBe('# Unsynced detach edit')
      expect(hub.getSnapshot().buffers['c:/wiki/shared.md']?.isDirty).toBe(true)
      expect(bufferStore.hasBuffer('c:/wiki/shared.md')).toBe(false)
      expect(tabStore.getBufferKeys()).toEqual([])
    } finally {
      stop()
      hub.dispose()
    }
  })

  it('releases pending-open owner claims when renderer unmounts mid-open before webContents destroys', async () => {
    const { hub, files, detach } = createHubClientHarness(1)
    const win2 = attachWindowClient(hub, 2)
    const stop2 = win2.client.start()

    try {
      files.set('C:/wiki/solo.md', '# Solo')
      const replyGate = createDeferred<Awaited<ReturnType<WikiBufferApi['openWorkspaceFile']>>>()
      const origOpen2 = win2.bufferApi.openWorkspaceFile.bind(win2.bufferApi)
      win2.bufferApi.openWorkspaceFile = async (filePath, name, initialContent) => {
        await origOpen2(filePath, name, initialContent)
        return replyGate.promise
      }

      const openPromise = win2.client.openWorkspaceFile({
        name: 'solo.md',
        path: 'C:/wiki/solo.md',
        relativePath: 'solo.md',
        kind: 'file'
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(hub.getSnapshot().buffers['c:/wiki/solo.md']).toBeDefined()

      // Unmount win2 mid-open (without destroying BrowserWindow); orphan buffer should clear
      stop2()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(hub.getSnapshot().buffers['c:/wiki/solo.md']).toBeUndefined()

      replyGate.resolve({
        key: 'c:/wiki/solo.md',
        kind: 'workspace',
        path: 'C:/wiki/solo.md',
        name: 'solo.md',
        content: '# Solo',
        savedContent: '# Solo',
        isDirty: false,
        version: 1,
        isSaving: false
      })
      await openPromise
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(hub.getSnapshot().buffers['c:/wiki/solo.md']).toBeUndefined()
    } finally {
      detach()
      win2.detach()
      hub.dispose()
    }
  })

  it('skips opening a dangling tab when buffers-closed arrives while openWorkspaceFile reply is in flight', async () => {
    const win1 = createHubClientHarness(1)
    const { hub, files } = win1
    files.set('C:/wiki/doomed.md', '# Doomed')
    const stop1 = win1.client.start()
    const win2 = attachWindowClient(hub, 2)
    const stop2 = win2.client.start()

    try {
      await win1.client.openWorkspaceFile({
        name: 'doomed.md',
        path: 'C:/wiki/doomed.md',
        relativePath: 'doomed.md',
        kind: 'file'
      })
      hub.syncWindowTabs(1, ['c:/wiki/doomed.md'])

      const replyGate = createDeferred<Awaited<ReturnType<WikiBufferApi['openWorkspaceFile']>>>()
      const origOpen2 = win2.bufferApi.openWorkspaceFile.bind(win2.bufferApi)
      win2.bufferApi.openWorkspaceFile = async (filePath, name, initialContent) => {
        const opened = await origOpen2(filePath, name, initialContent)
        await replyGate.promise
        return opened
      }

      const openWin2Promise = win2.client.openWorkspaceFile({
        name: 'doomed.md',
        path: 'C:/wiki/doomed.md',
        relativePath: 'doomed.md',
        kind: 'file'
      })
      await new Promise((resolve) => setTimeout(resolve, 10))

      // While Win2 is still awaiting its open reply, Win1 deletes doomed.md (broadcasting buffers-closed)
      files.delete('C:/wiki/doomed.md')
      hub.syncDeletedPath('C:/wiki/doomed.md')
      await new Promise((resolve) => setTimeout(resolve, 10))

      replyGate.resolve({
        key: 'c:/wiki/doomed.md',
        kind: 'workspace',
        path: 'C:/wiki/doomed.md',
        name: 'doomed.md',
        content: '# Doomed',
        savedContent: '# Doomed',
        isDirty: false,
        version: 1,
        isSaving: false
      })
      await openWin2Promise
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(win2.tabStore.getBufferKeys()).toEqual([])
      expect(win2.bufferStore.hasBuffer('c:/wiki/doomed.md')).toBe(false)
    } finally {
      stop1()
      stop2()
      win1.detach()
      win2.detach()
      hub.dispose()
    }
  })
})
