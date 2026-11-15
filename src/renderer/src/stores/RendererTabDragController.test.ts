import { describe, expect, it, vi } from 'vitest'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import type { WikiBufferApi, WikiWindowApi } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type {
  ActiveTabDragSession,
  TabDragEndInput,
  TabDragEndResult,
  TabDragOutcome,
  TabDragStartInput
} from '@shared/window'
import { createHubBufferApi } from '../test/inMemoryWikiHarness'
import { PaneTabStore } from './PaneTabStore'
import { RendererBufferSyncClient } from './RendererBufferSyncClient'
import { RendererTabDragController } from './RendererTabDragController'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createDragControllerHarness(windowApi: WikiWindowApi) {
  const files = new Map<string, string>([['C:/wiki/note.md', '# Original']])
  const hub = new SharedDocumentBufferHub({
    initialAutoSaveConfig: { autoSave: false, autoSaveDelayMs: 500 },
    storage: {
      readWorkspaceFile: async (path) => files.get(path) ?? '',
      writeWorkspaceFile: async (path, content) => {
        files.set(path, content)
      },
      getConfigPath: async () => 'C:/config.json',
      readConfigRaw: async () => '{}',
      saveConfigRaw: async () => undefined
    }
  })

  const listeners = new Set<(event: SharedBufferHubEvent) => void>()
  const unsubscribeHub = hub.subscribe((event) => {
    for (const listener of listeners) {
      listener(event)
    }
  })
  const bufferApi: WikiBufferApi = createHubBufferApi(hub, 1, listeners)
  const bufferStore = new DocumentBufferStore()
  const tabStore = new PaneTabStore()
  const onError = vi.fn()
  const syncClient = new RendererBufferSyncClient({
    bufferStore,
    tabStore,
    bufferApi,
    windowApi,
    onError,
    onConfirmCloseDirtyTab: vi.fn()
  })
  const controller = new RendererTabDragController({
    tabStore,
    windowApi,
    getWindowId: syncClient.getWindowId,
    isBufferReadyForImmediateDrag: syncClient.isBufferReadyForImmediateDrag,
    syncTabBufferForTransfer: syncClient.syncTabBufferForTransfer,
    closeDetachedTab: syncClient.forceCloseTab,
    onError
  })

  const start = (): (() => void) => {
    const stopSync = syncClient.start()
    const stopDrag = controller.start()
    return () => {
      stopDrag()
      stopSync()
      unsubscribeHub()
      hub.dispose()
    }
  }

  return { hub, bufferApi, tabStore, syncClient, controller, onError, start }
}

describe('RendererTabDragController', () => {
  it('handles sync-before-async Escape cancellation without detaching or closing the tab', async () => {
    const startGate = createDeferred<ActiveTabDragSession>()
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragOutcome }> = []
    const endInputs: TabDragEndInput[] = []

    const windowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async () => ({ windowId: 2 }),
      startTabDrag: async (_input: TabDragStartInput) => startGate.promise,
      updateTabDragOutcome: async (dragSessionId, outcome) => {
        outcomeUpdates.push({ dragSessionId, outcome })
        return null
      },
      endTabDrag: async (input) => {
        endInputs.push(input)
        return { detached: false, outcome: 'cancelled' } satisfies TabDragEndResult
      },
      onTabDragStateChanged: () => () => undefined,
      closeCurrent: async () => undefined
    }

    const { tabStore, syncClient, controller, start } = createDragControllerHarness(windowApi)
    const cleanup = start()

    try {
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })
      const tabId = tabStore.getSnapshot().panes.primary.tabs[0].id

      controller.startDrag('primary', tabId)
      expect(controller.getSnapshot()).toEqual({ paneId: 'primary', tabId })
      controller.cancelDrag()
      expect(controller.getSnapshot()).toBeNull()

      startGate.resolve({
        dragSessionId: 'drag-async-1',
        sourceWindowId: 1,
        paneId: 'primary',
        tabId,
        payload: {
          bufferKey: 'c:/wiki/note.md',
          mode: 'raw',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        },
        outcome: 'pending'
      })

      await controller.endDrag({ x: 1600, y: 300 })

      expect(outcomeUpdates).toEqual([{ dragSessionId: 'drag-async-1', outcome: 'cancelled' }])
      expect(endInputs).toHaveLength(1)
      expect(endInputs[0]?.dragSessionId).toBe('drag-async-1')
      expect(tabStore.getBufferKeys()).toEqual(['c:/wiki/note.md'])
    } finally {
      cleanup()
    }
  })

  it('flushes dirty edits to hub before endDrag detaches and closes local tab only on success', async () => {
    let hubRef!: SharedDocumentBufferHub
    const endPayloads: TabDragEndInput[] = []
    const windowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async () => ({ windowId: 2 }),
      startTabDrag: async (input) => ({
        dragSessionId: 'drag-dirty-1',
        sourceWindowId: 1,
        paneId: input.paneId,
        tabId: input.tabId,
        payload: input.payload,
        outcome: 'pending'
      }),
      updateTabDragOutcome: async () => null,
      endTabDrag: async (input) => {
        endPayloads.push(input)
        hubRef.registerPendingTransfer(2, input.payload!.bufferKey)
        return { detached: true, windowId: 2 }
      },
      onTabDragStateChanged: () => () => undefined,
      closeCurrent: async () => undefined
    }

    const { hub, bufferApi, tabStore, syncClient, controller, start } =
      createDragControllerHarness(windowApi)
    hubRef = hub
    const cleanup = start()

    try {
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })
      const tabId = tabStore.getSnapshot().panes.primary.tabs[0].id

      const origUpdate = bufferApi.updateContent.bind(bufferApi)
      bufferApi.updateContent = async () => {
        throw new Error('Transient sync stall')
      }
      syncClient.updateBufferContent('c:/wiki/note.md', '# Unsaved drag edit')
      await new Promise((resolve) => setTimeout(resolve, 10))
      bufferApi.updateContent = origUpdate

      controller.startDrag('primary', tabId)
      await controller.endDrag({ x: 1650, y: 240 })

      expect(endPayloads).toHaveLength(1)
      expect(endPayloads[0]?.screenPoint).toEqual({ x: 1650, y: 240 })
      expect(hub.getSnapshot().buffers['c:/wiki/note.md']?.content).toBe('# Unsaved drag edit')
      expect(hub.getSnapshot().buffers['c:/wiki/note.md']?.isDirty).toBe(true)
      expect(tabStore.getBufferKeys()).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('aborts detach, surfaces error, and preserves dirty tab when buffer sync fails during endDrag', async () => {
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragOutcome }> = []
    const endCalls: TabDragEndInput[] = []
    const windowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async () => ({ windowId: 2 }),
      startTabDrag: async (input) => ({
        dragSessionId: 'drag-sync-fail',
        sourceWindowId: 1,
        paneId: input.paneId,
        tabId: input.tabId,
        payload: input.payload,
        outcome: 'pending'
      }),
      updateTabDragOutcome: async (dragSessionId, outcome) => {
        outcomeUpdates.push({ dragSessionId, outcome })
        return null
      },
      endTabDrag: async (input) => {
        endCalls.push(input)
        return { detached: false, outcome: 'cancelled' }
      },
      onTabDragStateChanged: () => () => undefined,
      closeCurrent: async () => undefined
    }

    const { bufferApi, tabStore, syncClient, controller, onError, start } =
      createDragControllerHarness(windowApi)
    const cleanup = start()

    try {
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })
      const tabId = tabStore.getSnapshot().panes.primary.tabs[0].id

      bufferApi.updateContent = async () => {
        throw new Error('Hub write rejected')
      }
      syncClient.updateBufferContent('c:/wiki/note.md', '# Precious unsaved draft')
      await new Promise((resolve) => setTimeout(resolve, 10))
      onError.mockClear()

      controller.startDrag('primary', tabId)
      await controller.endDrag({ x: 1600, y: 300 })

      expect(onError).toHaveBeenCalledWith('Hub write rejected', expect.any(Error))
      expect(outcomeUpdates).toEqual([{ dragSessionId: 'drag-sync-fail', outcome: 'cancelled' }])
      expect(endCalls).toEqual([{ dragSessionId: 'drag-sync-fail' }])
      expect(tabStore.getBufferKeys()).toEqual(['c:/wiki/note.md'])
    } finally {
      cleanup()
    }
  })

  it('completes main drag session on completeInWindowDrop even when dragend never fires and forwards undefined screenPoint faithfully', async () => {
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragOutcome }> = []
    const endCalls: TabDragEndInput[] = []
    let counter = 0

    const windowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async () => ({ windowId: 2 }),
      startTabDrag: async (input) => ({
        dragSessionId: `drag-${++counter}`,
        sourceWindowId: 1,
        paneId: input.paneId,
        tabId: input.tabId,
        payload: input.payload,
        outcome: 'pending'
      }),
      updateTabDragOutcome: async (dragSessionId, outcome) => {
        outcomeUpdates.push({ dragSessionId, outcome })
        return null
      },
      endTabDrag: async (input) => {
        endCalls.push(input)
        return { detached: false, outcome: 'dropped-in-window' }
      },
      onTabDragStateChanged: () => () => undefined,
      closeCurrent: async () => undefined
    }

    const { tabStore, syncClient, controller, start } = createDragControllerHarness(windowApi)
    const cleanup = start()

    try {
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })
      const tabId = tabStore.getSnapshot().panes.primary.tabs[0].id

      controller.startDrag('primary', tabId)
      controller.completeInWindowDrop()
      expect(controller.getSnapshot()).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(outcomeUpdates).toEqual([{ dragSessionId: 'drag-1', outcome: 'dropped-in-window' }])
      expect(endCalls).toEqual([{ dragSessionId: 'drag-1' }])

      controller.startDrag('primary', tabId)
      await controller.endDrag(undefined)
      expect(endCalls[1]).toEqual({
        dragSessionId: 'drag-2',
        screenPoint: undefined,
        payload: expect.objectContaining({ bufferKey: 'c:/wiki/note.md' })
      })
    } finally {
      cleanup()
    }
  })
})
