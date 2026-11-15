import { describe, expect, it, vi } from 'vitest'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import type { WikiBufferApi } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
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

function createHubClientHarness(windowId = 1) {
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
  const listeners = new Set<(event: SharedBufferHubEvent) => void>()
  hub.subscribe((event) => {
    for (const listener of listeners) {
      listener(event)
    }
  })

  const bufferApi: WikiBufferApi = {
    getSnapshot: async () => hub.getSnapshot(windowId),
    openWorkspaceFile: async (filePath, name, initialContent) =>
      hub.openWorkspaceFile(filePath, name, initialContent, windowId),
    openConfigDocument: async () => hub.openConfigDocument(windowId),
    refreshCleanConfig: async () => hub.refreshCleanConfig(),
    updateContent: async (key, nextContent) => hub.updateContent(key, nextContent),
    saveBuffer: async (key) => hub.saveBuffer(key),
    syncWindowTabs: async (bufferKeys) => hub.syncWindowTabs(windowId, bufferKeys),
    setAutoSavePaused: async (paused) => hub.setAutoSavePaused(windowId, paused),
    syncRenamedPath: async (oldPath, newPath) => hub.syncRenamedPath(oldPath, newPath),
    syncDeletedPath: async (targetPath) => hub.syncDeletedPath(targetPath),
    reconcileWorkspaceBuffersWithDisk: async () => hub.reconcileWorkspaceBuffersWithDisk(),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  const bufferStore = new DocumentBufferStore()
  const tabStore = new PaneTabStore()
  const client = new RendererBufferSyncClient({
    bufferStore,
    tabStore,
    bufferApi,
    onError: vi.fn(),
    onConfirmCloseDirtyTab: vi.fn()
  })

  return { hub, files, bufferApi, bufferStore, tabStore, client }
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
})
