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

  it('tracks per-window exclusive dirty buffers vs shared buffers for close guards', async () => {
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => `# ${filePath}`,
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{"autoSave":false}',
        saveConfigRaw: async () => ({ autoSave: false })
      }
    })

    try {
      const alpha = await hub.openWorkspaceFile('C:/wiki/alpha.md', 'alpha.md', undefined, 2)
      const shared = await hub.openWorkspaceFile('C:/wiki/shared.md', 'shared.md', undefined, 1)
      await hub.openWorkspaceFile('C:/wiki/shared.md', 'shared.md', undefined, 2)
      const config = await hub.openConfigDocument(2)

      hub.syncWindowTabs(1, [shared.key])
      hub.syncWindowTabs(2, [alpha.key, alpha.key, shared.key, config.key])

      expect(hub.hasAnyDirtyBuffer()).toBe(false)
      expect(hub.getDirtyBuffersLostOnWindowClose(2)).toEqual([])

      hub.updateContent(alpha.key, '# dirty alpha')
      hub.updateContent(shared.key, '# dirty shared')
      hub.updateContent(config.key, '{"autoSave":true}')

      expect(hub.hasAnyDirtyBuffer()).toBe(true)
      expect(
        hub
          .getDirtyBuffersLostOnWindowClose(2)
          .map((buffer) => buffer.key)
          .sort()
      ).toEqual([alpha.key, config.key].sort())

      // When Main closes shared tab, shared becomes exclusive to Win2.
      hub.syncWindowTabs(1, [])
      expect(
        hub
          .getDirtyBuffersLostOnWindowClose(2)
          .map((buffer) => buffer.key)
          .sort()
      ).toEqual([alpha.key, config.key, shared.key].sort())

      // Pending transfer reservation on another window protects close of source window
      hub.registerPendingTransfer(3, alpha.key)
      expect(
        hub
          .getDirtyBuffersLostOnWindowClose(2)
          .map((buffer) => buffer.key)
          .sort()
      ).toEqual([config.key, shared.key].sort())
    } finally {
      hub.dispose()
    }
  })

  it('clearWorkspaceBuffers closes workspace buffers and in-flight opens while preserving config buffer', async () => {
    const readGate = createDeferred<string>()
    const events: string[] = []
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) =>
          filePath.includes('pending.md') ? readGate.promise : '# Alpha',
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{"autoSave":false}',
        saveConfigRaw: async () => ({ autoSave: false })
      }
    })
    hub.subscribe((event) => {
      events.push(event.type)
    })

    try {
      const alpha = await hub.openWorkspaceFile('C:/wiki/alpha.md', 'alpha.md', undefined, 1)
      const config = await hub.openConfigDocument(2)
      hub.syncWindowTabs(1, [alpha.key])
      hub.syncWindowTabs(2, [alpha.key, config.key])
      hub.updateContent(alpha.key, '# dirty alpha')
      hub.updateContent(config.key, '{"autoSave":true}')

      const pendingOpen = hub.openWorkspaceFile('C:/wiki/pending.md', 'pending.md', undefined, 1)
      await new Promise((resolve) => setTimeout(resolve, 10))

      const closedKeys = hub.clearWorkspaceBuffers()
      expect(closedKeys.sort()).toEqual([alpha.key, 'c:/wiki/pending.md'].sort())
      expect(events).toContain('buffers-closed')

      readGate.resolve('# Stale pending content')
      await pendingOpen

      const snapshot = hub.getSnapshot()
      expect(snapshot.buffers[alpha.key]).toBeUndefined()
      expect(snapshot.buffers['c:/wiki/pending.md']).toBeUndefined()
      expect(snapshot.buffers[config.key]).toBeDefined()
      expect(snapshot.buffers[config.key]?.isDirty).toBe(true)
      expect(snapshot.tabCounts[alpha.key]).toBeUndefined()
      expect(snapshot.tabCounts[config.key]).toBe(1)
    } finally {
      hub.dispose()
    }
  })

  it('prepareWorkspacePathsForDiscard and finishWorkspacePathsDiscard cancel auto-save/in-flight saves, block mid-discard edits/warnings, force-sync restored files, and close removed dirty buffers', async () => {
    const files = new Map<string, string>([
      ['C:/wiki/target.md', '# Target Initial'],
      ['C:/wiki/missing.md', '# Missing Initial'],
      ['C:/wiki/untouched.md', '# Untouched Initial']
    ])
    let writeCountForTarget = 0
    let releaseInFlightSave!: () => void
    const inFlightSaveGate = createDeferred()

    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: true, autoSaveDelayMs: 25 },
      storage: {
        readWorkspaceFile: async (filePath) => {
          const content = files.get(filePath)
          if (content === undefined) {
            throw new Error(`파일을 찾을 수 없습니다: ${filePath}`)
          }
          return content
        },
        writeWorkspaceFile: async (filePath, content) => {
          if (filePath.endsWith('target.md')) {
            writeCountForTarget += 1
            await inFlightSaveGate.promise
          }
          files.set(filePath, content)
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    const events: string[] = []
    hub.subscribe((event) => events.push(event.type))

    try {
      const target = await hub.openWorkspaceFile('C:/wiki/target.md', 'target.md', undefined, 1)
      const missing = await hub.openWorkspaceFile('C:/wiki/missing.md', 'missing.md', undefined, 1)
      const untouched = await hub.openWorkspaceFile(
        'C:/wiki/untouched.md',
        'untouched.md',
        undefined,
        1
      )
      const config = await hub.openConfigDocument(1)
      hub.syncWindowTabs(1, [target.key, missing.key, untouched.key, config.key])

      // Start an in-flight save on target, plus dirty missing and untouched
      hub.updateContent(target.key, '# Target Stale Inflight')
      const inflightSave = hub.saveBuffer(target.key)
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Prepare waits for in-flight save, cancels auto-save, and enters discard lock
      let prepared = false
      const preparePromise = hub.prepareWorkspacePathsForDiscard([
        'C:/wiki/target.md',
        'C:/wiki/missing.md'
      ]).then(() => {
        prepared = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(prepared).toBe(false)

      releaseInFlightSave = inFlightSaveGate.resolve
      releaseInFlightSave()
      await inflightSave
      await preparePromise

      // Edit target again into dirty state? While in discard window, stale updateContent & watcher reconcile warnings are suppressed
      hub.updateContent(target.key, '# Target Dirty Suppressed')
      expect(hub.getBuffer(target.key)?.content).toBe('# Target Stale Inflight')

      hub.updateContent(missing.key, '# Missing Dirty')
      hub.updateContent(untouched.key, '# Untouched Dirty')
      hub.updateContent(config.key, '{"dirty":true}')

      // Simulate git discard restoring target.md on disk and deleting missing.md on disk
      files.set('C:/wiki/target.md', '# Target Restored From Git')
      files.delete('C:/wiki/missing.md')

      // Mid-discard reconcile ignores keys in discard window (no spurious conflict/missing warning)
      const midReconcile = await hub.reconcileWorkspaceBuffersWithDisk()
      expect(midReconcile.warnings).toEqual([])
      expect(midReconcile.closedKeys).toEqual([])

      // Finish with forceSync=true -> target force-synced (isDirty: false), missing closed, untouched & config preserved
      const closedKeys = await hub.finishWorkspacePathsDiscard(
        ['C:/wiki/target.md', 'C:/wiki/missing.md'],
        true
      )
      expect(closedKeys).toEqual([missing.key])
      expect(events).toContain('buffers-force-synced')
      expect(events).toContain('buffers-closed')

      const targetAfter = hub.getBuffer(target.key)!
      expect(targetAfter.content).toBe('# Target Restored From Git')
      expect(targetAfter.savedContent).toBe('# Target Restored From Git')
      expect(targetAfter.isDirty).toBe(false)
      expect(hub.getBuffer(missing.key)).toBeUndefined()
      expect(hub.getBuffer(untouched.key)?.isDirty).toBe(true)
      expect(hub.getBuffer(config.key)?.isDirty).toBe(true)

      // Wait longer than autoSaveDelayMs: target must NOT be overwritten by any residual auto-save timer
      const writesBeforeWait = writeCountForTarget
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(writeCountForTarget).toBe(writesBeforeWait)
      expect(files.get('C:/wiki/target.md')).toBe('# Target Restored From Git')

      // If discard fails (forceSync=false), discard lock releases cleanly so subsequent edits work again
      await hub.prepareWorkspacePathsForDiscard(['C:/wiki/target.md'])
      await hub.finishWorkspacePathsDiscard(['C:/wiki/target.md'], false)
      hub.updateContent(target.key, '# Edited After Failed Discard')
      expect(hub.getBuffer(target.key)?.content).toBe('# Edited After Failed Discard')
      expect(hub.getBuffer(target.key)?.isDirty).toBe(true)
    } finally {
      hub.dispose()
    }
  })

  it('refreshCleanWorkspaceFile refreshes only a clean target workspace file without reading unrelated text or reloading open image tabs', async () => {
    const schemaPath = 'C:/wiki/.wiki-editor/frontmatter.json'
    const notePath = 'C:/wiki/note.md'
    const imagePath = 'C:/wiki/assets/diagram.png'
    const files = new Map<string, string>([
      [schemaPath, '{"version":1,"fields":[]}'],
      [notePath, '# Unrelated Note']
    ])
    const readCalls: string[] = []
    let readDirCalls = 0
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async (filePath) => {
          readCalls.push(filePath)
          const content = files.get(filePath)
          if (content === undefined) throw new Error('ENOENT')
          return content
        },
        writeWorkspaceFile: async () => undefined,
        readWorkspaceDirectory: async () => {
          readDirCalls += 1
          return []
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const schemaBuf = await hub.openWorkspaceFile(schemaPath, 'frontmatter.json', undefined, 1)
      const noteBuf = await hub.openWorkspaceFile(notePath, 'note.md', undefined, 1)
      const imageBuf = await hub.openWorkspaceFile(imagePath, 'diagram.png', undefined, 1)
      hub.syncWindowTabs(1, [schemaBuf.key, noteBuf.key, imageBuf.key])
      const initialImageVersion = hub.getBuffer(imageBuf.key)?.version
      readCalls.length = 0

      files.set(schemaPath, '{"version":1,"fields":[{"key":"status","label":"상태","type":"text"}]}')
      files.set(notePath, '# Changed Externally But Unrelated')

      const refreshed = await hub.refreshCleanWorkspaceFile(schemaPath)
      expect(refreshed?.content).toContain('"status"')
      expect(refreshed?.isDirty).toBe(false)
      expect(readCalls).toEqual([schemaPath])
      expect(readDirCalls).toBe(0)
      expect(hub.getBuffer(noteBuf.key)?.content).toBe('# Unrelated Note')
      expect(hub.getBuffer(imageBuf.key)?.version).toBe(initialImageVersion)

      // Leaves dirty target buffer untouched without hitting disk
      hub.updateContent(schemaBuf.key, '{"version":1,"fields":[{"key":"draft"}]}')
      files.set(schemaPath, '{"version":1,"fields":[{"key":"disk"}]}')
      readCalls.length = 0

      const skippedDirty = await hub.refreshCleanWorkspaceFile(schemaPath)
      expect(skippedDirty?.isDirty).toBe(true)
      expect(skippedDirty?.content).toContain('"draft"')
      expect(readCalls).toEqual([])
    } finally {
      hub.dispose()
    }
  })
})
