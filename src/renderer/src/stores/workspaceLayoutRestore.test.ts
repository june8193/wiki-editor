import { describe, expect, it, vi } from 'vitest'
import type { SharedBufferHubEvent } from '@shared/documentBuffer'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { SharedDocumentBufferHub } from '@shared/sharedDocumentBufferHub'
import { createHubBufferApi } from '../test/inMemoryWikiHarness'
import { PaneTabStore } from './PaneTabStore'
import { RendererBufferSyncClient } from './RendererBufferSyncClient'
import { restoreWorkspacePaneLayout } from './workspaceLayoutRestore'

function createRestoreTestHarness(initialFiles: ReadonlyArray<[string, string]>) {
  const files = new Map<string, string>(initialFiles)
  const hub = new SharedDocumentBufferHub({
    initialAutoSaveConfig: { autoSave: false },
    storage: {
      readWorkspaceFile: async (filePath) => {
        const val = files.get(filePath.replace(/\\/g, '/'))
        if (val === undefined) throw new Error(`ENOENT: ${filePath}`)
        return val
      },
      writeWorkspaceFile: async (filePath, content) => {
        files.set(filePath.replace(/\\/g, '/'), content)
      },
      getConfigPath: async () => 'C:/Users/test/config.json',
      readConfigRaw: async () => '{"theme":"light"}',
      saveConfigRaw: async () => ({})
    }
  })
  const listeners = new Set<(event: SharedBufferHubEvent) => void>()
  const unsubscribeHub = hub.subscribe((event) => {
    for (const listener of listeners) {
      listener(event)
    }
  })
  const bufferApi = createHubBufferApi(hub, 1, listeners)
  const bufferStore = new DocumentBufferStore()
  const tabStore = new PaneTabStore()
  const onError = vi.fn()
  const client = new RendererBufferSyncClient({
    bufferStore,
    tabStore,
    bufferApi,
    onError,
    onConfirmCloseDirtyTab: vi.fn()
  })

  return {
    hub,
    bufferStore,
    tabStore,
    client,
    onError,
    dispose: () => {
      unsubscribeHub()
      hub.dispose()
    }
  }
}

describe('restoreWorkspacePaneLayout', () => {
  it('restores valid tabs silently, skips missing text/image files, promotes secondary when primary empties, preserves config, and respects cancellation', async () => {
    const harness = createRestoreTestHarness([
      ['C:/wiki/keep.md', '# Keep'],
      ['C:/wiki/sec.md', '# Secondary'],
      ['C:/wiki/assets/ok.png', '<png>']
    ])
    const stop = harness.client.start()

    try {
      await harness.client.openConfigDocument()
      expect(harness.tabStore.getBufferKeys()).toEqual(['c:/users/test/config.json'])
      harness.onError.mockClear()

      const promoted = await restoreWorkspacePaneLayout(harness.client, {
        rootPath: 'C:\\wiki',
        persistedLayout: {
          splitMode: 'vertical',
          splitRatio: 0.4,
          activePaneId: 'secondary',
          panes: {
            primary: {
              tabs: [
                {
                  path: 'C:\\wiki\\missing.md',
                  mode: 'raw',
                  cursor: { selectionStart: 0, selectionEnd: 0 },
                  scrollTop: 0,
                  splitPreviewRatio: 0.5
                },
                {
                  path: 'C:\\wiki\\assets\\deleted.png',
                  mode: 'raw',
                  cursor: { selectionStart: 0, selectionEnd: 0 },
                  scrollTop: 0,
                  splitPreviewRatio: 0.5
                },
                {
                  path: 'C:\\outside\\secret.md',
                  mode: 'raw',
                  cursor: { selectionStart: 0, selectionEnd: 0 },
                  scrollTop: 0,
                  splitPreviewRatio: 0.5
                }
              ],
              activeTabPath: 'C:\\wiki\\missing.md'
            },
            secondary: {
              tabs: [
                {
                  path: 'C:\\wiki\\sec.md',
                  mode: 'preview',
                  cursor: { selectionStart: 3, selectionEnd: 5 },
                  scrollTop: 75,
                  splitPreviewRatio: 0.65
                }
              ],
              activeTabPath: 'C:\\wiki\\sec.md'
            }
          }
        },
        readDir: async (dirPath = '') => {
          if (dirPath.replace(/\\/g, '/').toLowerCase() === 'c:/wiki/assets') {
            return [
              {
                name: 'ok.png',
                path: 'C:/wiki/assets/ok.png',
                relativePath: 'assets/ok.png',
                kind: 'file'
              }
            ]
          }
          return []
        }
      })

      expect(harness.onError).not.toHaveBeenCalled()
      expect(promoted.restored).toBe(true)
      expect(promoted.hadPrunedTabs).toBe(true)
      expect(promoted.reconciledLayout.splitMode).toBe('single')
      expect(harness.tabStore.getSnapshot().splitMode).toBe('single')
      expect(harness.tabStore.getSnapshot().activePaneId).toBe('primary')
      expect(harness.tabStore.getBufferKeys()).toEqual([
        'c:/wiki/sec.md',
        'c:/users/test/config.json'
      ])
      expect(harness.tabStore.getSnapshot().panes.primary.tabs[0]).toMatchObject({
        mode: 'preview',
        cursor: { selectionStart: 3, selectionEnd: 5 },
        scrollTop: 75,
        splitPreviewRatio: 0.65
      })

      const cancelled = await restoreWorkspacePaneLayout(harness.client, {
        rootPath: 'C:\\wiki',
        persistedLayout: {
          splitMode: 'single',
          splitRatio: 0.5,
          activePaneId: 'primary',
          panes: {
            primary: {
              tabs: [
                {
                  path: 'C:\\wiki\\keep.md',
                  mode: 'raw',
                  cursor: { selectionStart: 0, selectionEnd: 0 },
                  scrollTop: 0,
                  splitPreviewRatio: 0.5
                }
              ],
              activeTabPath: 'C:\\wiki\\keep.md'
            },
            secondary: { tabs: [], activeTabPath: null }
          }
        },
        readDir: async () => [],
        isCancelled: () => true
      })

      expect(cancelled.restored).toBe(false)
      expect(harness.tabStore.getBufferKeys()).toEqual([
        'c:/wiki/sec.md',
        'c:/users/test/config.json'
      ])
    } finally {
      stop()
      harness.dispose()
    }
  })

  it('reconciles valid images from preloaded rootEntries and handles empty stale split layouts without dropping preserved config', async () => {
    const harness = createRestoreTestHarness([['C:/wiki/logo.png', '<png>']])
    const stop = harness.client.start()

    try {
      await harness.client.openConfigDocument()

      const staleEmpty = await restoreWorkspacePaneLayout(harness.client, {
        rootPath: 'C:\\wiki',
        persistedLayout: {
          splitMode: 'horizontal',
          splitRatio: 0.4,
          activePaneId: 'secondary',
          panes: {
            primary: { tabs: [], activeTabPath: null },
            secondary: { tabs: [], activeTabPath: null }
          }
        },
        readDir: async () => []
      })
      expect(staleEmpty.restored).toBe(true)
      expect(staleEmpty.hadPrunedTabs).toBe(true)
      expect(staleEmpty.reconciledLayout.splitMode).toBe('single')
      expect(harness.tabStore.getBufferKeys()).toEqual(['c:/users/test/config.json'])

      const readDir = vi.fn(async () => [])
      const restoredImage = await restoreWorkspacePaneLayout(harness.client, {
        rootPath: 'C:\\wiki',
        persistedLayout: {
          splitMode: 'single',
          splitRatio: 0.5,
          activePaneId: 'primary',
          panes: {
            primary: {
              tabs: [
                {
                  path: 'C:\\wiki\\logo.png',
                  mode: 'raw',
                  cursor: { selectionStart: 0, selectionEnd: 0 },
                  scrollTop: 0,
                  splitPreviewRatio: 0.5
                }
              ],
              activeTabPath: 'C:\\wiki\\logo.png'
            },
            secondary: { tabs: [], activeTabPath: null }
          }
        },
        rootEntries: [
          {
            name: 'logo.png',
            path: 'C:\\wiki\\logo.png',
            relativePath: 'logo.png',
            kind: 'file'
          }
        ],
        readDir
      })

      expect(readDir).not.toHaveBeenCalled()
      expect(restoredImage.restored).toBe(true)
      expect(harness.tabStore.getBufferKeys()).toEqual([
        'c:/wiki/logo.png',
        'c:/users/test/config.json'
      ])
    } finally {
      stop()
      harness.dispose()
    }
  })
})
