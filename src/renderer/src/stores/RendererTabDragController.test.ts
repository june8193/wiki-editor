import { describe, expect, it, vi } from 'vitest'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import type { WikiBufferApi, WikiWindowApi } from '@shared/ipc'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import type {
  ActiveTabDragSession,
  TabDragEndInput,
  TabDragEndResult,
  TabDragResolution,
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
    bufferSync: syncClient,
    windowApi,
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
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragResolution }> = []
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
      acceptTabDragDrop: async () => ({ accepted: false, reason: 'no-active-drag' }),
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
      acceptTabDragDrop: async () => ({ accepted: false, reason: 'no-active-drag' }),
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
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragResolution }> = []
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
      acceptTabDragDrop: async () => ({ accepted: false, reason: 'no-active-drag' }),
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
    const outcomeUpdates: Array<{ dragSessionId: string; outcome: TabDragResolution }> = []
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
      acceptTabDragDrop: async () => ({ accepted: false, reason: 'no-active-drag' }),
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

  it('tracks external drag sessions, accepts cross-window drops into buffer/tab stores, and reconciles remote dropped-in-window on source without spawning duplicate detach', async () => {
    const dragListeners = new Set<(session: ActiveTabDragSession | null) => void>()
    const emitDragState = (session: ActiveTabDragSession | null): void => {
      for (const listener of dragListeners) {
        listener(session)
      }
    }
    const endCalls: TabDragEndInput[] = []
    let acceptResult: Awaited<ReturnType<WikiWindowApi['acceptTabDragDrop']>> = {
      accepted: false,
      reason: 'no-active-drag'
    }

    const targetWindowApi: WikiWindowApi = {
      role: 'main',
      getInitContext: async () => ({ role: 'main', initialTabs: [] }),
      detachTabToNewWindow: async () => ({ windowId: 2 }),
      startTabDrag: async (input) => ({
        dragSessionId: 'drag-target-own',
        sourceWindowId: 1,
        paneId: input.paneId,
        tabId: input.tabId,
        payload: input.payload,
        outcome: 'pending'
      }),
      updateTabDragOutcome: async () => null,
      acceptTabDragDrop: async () => acceptResult,
      endTabDrag: async (input) => {
        endCalls.push(input)
        return { detached: false, outcome: 'dropped-in-window' }
      },
      onTabDragStateChanged: (listener) => {
        dragListeners.add(listener)
        return () => dragListeners.delete(listener)
      },
      closeCurrent: async () => undefined
    }

    const { hub, tabStore, syncClient, controller, start } =
      createDragControllerHarness(targetWindowApi)
    const cleanup = start()

    try {
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })

      // Own window drag does not populate externalDragSnapshot
      const ownTabId = tabStore.getSnapshot().panes.primary.tabs[0].id
      controller.startDrag('primary', ownTabId)
      emitDragState({
        dragSessionId: 'drag-target-own',
        sourceWindowId: 1,
        paneId: 'primary',
        tabId: ownTabId,
        payload: {
          bufferKey: 'c:/wiki/note.md',
          mode: 'raw',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        },
        outcome: 'pending'
      })
      expect(controller.getUiState().externalDragSession).toBeNull()

      // Remote dropped-in-window closes source tab, clears draggingTab, invokes endTabDrag, and ignores late endDrag
      emitDragState({
        dragSessionId: 'drag-target-own',
        sourceWindowId: 1,
        targetWindowId: 2,
        paneId: 'primary',
        tabId: ownTabId,
        payload: {
          bufferKey: 'c:/wiki/note.md',
          mode: 'raw',
          cursor: { selectionStart: 0, selectionEnd: 0 },
          scrollTop: 0
        },
        outcome: 'dropped-in-window'
      })
      expect(controller.getSnapshot()).toBeNull()
      expect(tabStore.getBufferKeys()).toEqual([])
      await Promise.resolve()
      expect(endCalls).toEqual([{ dragSessionId: 'drag-target-own' }])

      await controller.endDrag({ x: 1800, y: 200 })
      expect(endCalls).toHaveLength(1)

      // External drag from window 2 populates externalDragSnapshot, clears on cancel, and accepts drop cleanly
      const externalSession: ActiveTabDragSession = {
        dragSessionId: 'drag-ext-1',
        sourceWindowId: 2,
        paneId: 'primary',
        tabId: 'tab-ext',
        payload: {
          bufferKey: 'c:/wiki/external.md',
          mode: 'wysiwyg',
          cursor: { selectionStart: 4, selectionEnd: 8 },
          scrollTop: 120
        },
        outcome: 'pending'
      }
      emitDragState(externalSession)
      expect(controller.getUiState().externalDragSession).toEqual(externalSession)

      emitDragState({ ...externalSession, outcome: 'cancelled' })
      expect(controller.getUiState().externalDragSession).toBeNull()

      // Accepted external drop inserts buffer and tab (splitting even in 1-tab single mode)
      await syncClient.openWorkspaceFile({
        name: 'note.md',
        path: 'C:/wiki/note.md',
        relativePath: 'note.md',
        kind: 'file'
      })
      emitDragState(externalSession)
      acceptResult = {
        accepted: true,
        dragSessionId: 'drag-ext-1',
        sourceWindowId: 2,
        targetWindowId: 1,
        payload: externalSession.payload,
        buffer: {
          key: 'c:/wiki/external.md',
          path: 'C:/wiki/external.md',
          name: 'external.md',
          kind: 'workspace',
          content: '# Dirty external content',
          savedContent: '# Clean disk',
          isDirty: true,
          version: 2,
          isSaving: false
        }
      }

      const accepted = await controller.acceptExternalDrop(
        { kind: 'split', direction: 'vertical' },
        externalSession.dragSessionId
      )
      expect(accepted).toBe(true)
      expect(controller.getUiState().externalDragSession).toBeNull()
      expect(tabStore.getSnapshot().splitMode).toBe('vertical')
      expect(tabStore.getSnapshot().panes.secondary.tabs[0]).toMatchObject({
        bufferKey: 'c:/wiki/external.md',
        mode: 'wysiwyg',
        cursor: { selectionStart: 4, selectionEnd: 8 },
        scrollTop: 120
      })

      // Rejection clears externalDragSnapshot and leaves tabs untouched
      emitDragState(externalSession)
      acceptResult = { accepted: false, reason: 'drag-not-pending' }
      expect(await controller.acceptExternalDrop({ kind: 'pane', paneId: 'primary' })).toBe(false)
      expect(controller.getUiState().externalDragSession).toBeNull()
      expect(hub.getSnapshot().revision).toBeGreaterThanOrEqual(0)
    } finally {
      cleanup()
    }
  })
})
