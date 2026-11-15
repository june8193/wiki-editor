import { describe, expect, it } from 'vitest'
import { SharedDocumentBufferHub } from './sharedDocumentBufferHub'

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SharedDocumentBufferHub race guards', () => {
  it('does not close a missing clean buffer during reconcile if edited dirty before Promise.all finishes', async () => {
    const secondReadGate = createDeferred<string>()
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => {
          if (filePath.endsWith('missing.md')) {
            throw new Error('ENOENT: no such file or directory')
          }
          return secondReadGate.promise
        },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      await hub.openWorkspaceFile('C:/wiki/missing.md', 'missing.md', 'Original clean', 1)
      await hub.openWorkspaceFile('C:/wiki/slow.md', 'slow.md', 'Slow clean', 1)
      hub.syncWindowTabs(1, ['c:/wiki/missing.md', 'c:/wiki/slow.md'])

      const reconcilePromise = hub.reconcileWorkspaceBuffersWithDisk()
      // Allow missing.md's ENOENT check to settle while slow.md is still awaiting readWorkspaceFile
      await new Promise((resolve) => setTimeout(resolve, 10))

      // User types into missing.md before reconcile's Promise.all completes
      hub.updateContent('c:/wiki/missing.md', 'Newly typed unsaved draft')
      secondReadGate.resolve('Slow clean')

      const result = await reconcilePromise
      expect(result.closedKeys).toEqual([])
      expect(result.warnings).toHaveLength(1)
      expect(hub.getSnapshot().buffers['c:/wiki/missing.md']?.content).toBe(
        'Newly typed unsaved draft'
      )
      expect(hub.getSnapshot().buffers['c:/wiki/missing.md']?.isDirty).toBe(true)
    } finally {
      hub.dispose()
    }
  })

  it('remaps in-flight loadAndOpenBuffer and pendingOpenWindows when syncRenamedPath runs before disk read settles', async () => {
    const readGate = createDeferred<string>()
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => readGate.promise,
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const openPromise = hub.openWorkspaceFile('C:/wiki/old.md', 'old.md', undefined, 1)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const remappings = hub.syncRenamedPath('C:/wiki/old.md', 'C:/wiki/new.md')
      expect(remappings).toEqual([{ oldKey: 'c:/wiki/old.md', newKey: 'c:/wiki/new.md' }])

      readGate.resolve('# Loaded content')
      const opened = await openPromise

      expect(opened.key).toBe('c:/wiki/new.md')
      expect(opened.path).toBe('C:/wiki/new.md')
      expect(opened.name).toBe('new.md')

      const snapshot = hub.getSnapshot()
      expect(snapshot.buffers['c:/wiki/new.md']).toBeDefined()
      expect(snapshot.buffers['c:/wiki/old.md']).toBeUndefined()

      // Closing a different tab sync later must not discard c:/wiki/new.md while Win1 holds pending open
      hub.syncWindowTabs(2, [])
      expect(hub.getSnapshot().buffers['c:/wiki/new.md']).toBeDefined()
    } finally {
      hub.dispose()
    }
  })
})
