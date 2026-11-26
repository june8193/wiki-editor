import { describe, expect, it } from 'vitest'
import type { SharedBufferHubEvent } from './documentBuffer'
import { UnencodableCharactersError } from './encoding'
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

  it('ignores a slower refreshCleanWorkspaceFile read after a newer clean version has already settled', async () => {
    const filePath = 'C:/wiki/.wiki-editor/frontmatter.json'
    const firstRead = createDeferred<string>()
    const secondRead = createDeferred<string>()
    let readIndex = 0
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => {
          readIndex += 1
          return readIndex === 1 ? firstRead.promise : secondRead.promise
        },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const opened = await hub.openWorkspaceFile(filePath, 'frontmatter.json', 'initial', 1)
      hub.syncWindowTabs(1, [opened.key])

      const slowRefresh = hub.refreshCleanWorkspaceFile(filePath)
      const fastRefresh = hub.refreshCleanWorkspaceFile(filePath)

      secondRead.resolve('newer')
      await fastRefresh
      expect(hub.getBuffer(opened.key)?.content).toBe('newer')

      firstRead.resolve('stale')
      await slowRefresh
      expect(hub.getBuffer(opened.key)?.content).toBe('newer')
    } finally {
      hub.dispose()
    }
  })

  it('ignores a slower refreshCleanWorkspaceFile read even when a faster read matched the initial content without bumping version (ABA race)', async () => {
    const filePath = 'C:/wiki/.wiki-editor/frontmatter.json'
    const firstRead = createDeferred<string>()
    const secondRead = createDeferred<string>()
    let readIndex = 0
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => {
          readIndex += 1
          return readIndex === 1 ? firstRead.promise : secondRead.promise
        },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const opened = await hub.openWorkspaceFile(filePath, 'frontmatter.json', 'A', 1)
      hub.syncWindowTabs(1, [opened.key])

      const slowRefresh = hub.refreshCleanWorkspaceFile(filePath)
      const fastRefresh = hub.refreshCleanWorkspaceFile(filePath)

      secondRead.resolve('A')
      await fastRefresh
      expect(hub.getBuffer(opened.key)?.content).toBe('A')

      firstRead.resolve('B')
      await slowRefresh
      expect(hub.getBuffer(opened.key)?.content).toBe('A')
    } finally {
      hub.dispose()
    }
  })
})

describe('SharedDocumentBufferHub encoding state and protections', () => {
  it('initializes encoding from storage, toggles isDirty on setEncoding/revert, and schedules/cancels auto-save', async () => {
    const writes: Array<{ filePath: string; content: string; encoding?: string }> = []
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: true, autoSaveDelayMs: 40 },
      storage: {
        readWorkspaceFile: async () => '초기 본문',
        readWorkspaceFileWithEncoding: async () => ({
          content: '초기 본문',
          encoding: 'euc-kr'
        }),
        writeWorkspaceFile: async (filePath, content, options) => {
          writes.push({ filePath, content, encoding: options?.encoding })
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const opened = await hub.openWorkspaceFile('C:/wiki/legacy.md', 'legacy.md', undefined, 1)
      hub.syncWindowTabs(1, [opened.key])

      expect(opened.encoding).toBe('euc-kr')
      expect(opened.savedEncoding).toBe('euc-kr')
      expect(opened.isDirty).toBe(false)

      // Change encoding to utf-8 -> dirty, content preserved
      const changed = hub.setEncoding(opened.key, 'utf-8')
      expect(changed?.content).toBe('초기 본문')
      expect(changed?.encoding).toBe('utf-8')
      expect(changed?.savedEncoding).toBe('euc-kr')
      expect(changed?.isDirty).toBe(true)

      // Revert encoding back to euc-kr before auto-save fires -> clean & timer cancelled
      const reverted = hub.setEncoding(opened.key, 'euc-kr')
      expect(reverted?.isDirty).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 70))
      expect(writes).toEqual([])

      // Change again and let auto-save persist with the new encoding
      hub.setEncoding(opened.key, 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect(writes).toEqual([
        { filePath: 'C:/wiki/legacy.md', content: '초기 본문', encoding: 'utf-8' }
      ])
      expect(hub.getBuffer(opened.key)?.savedEncoding).toBe('utf-8')
      expect(hub.getBuffer(opened.key)?.isDirty).toBe(false)
    } finally {
      hub.dispose()
    }
  })

  it('reopenWithEncoding re-decodes disk bytes with target encoding and resets isDirty', async () => {
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => 'garbled',
        readWorkspaceFileWithEncoding: async (_filePath, encoding) =>
          encoding === 'euc-kr'
            ? { content: '한글 복원', encoding: 'euc-kr' }
            : { content: 'garbled', encoding: 'utf-8' },
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const opened = await hub.openWorkspaceFile('C:/wiki/note.md', 'note.md', undefined, 1)
      hub.syncWindowTabs(1, [opened.key])
      hub.updateContent(opened.key, 'unsaved local edit')
      expect(hub.getBuffer(opened.key)?.isDirty).toBe(true)

      const reopened = await hub.reopenWithEncoding(opened.key, 'euc-kr')
      expect(reopened?.content).toBe('한글 복원')
      expect(reopened?.savedContent).toBe('한글 복원')
      expect(reopened?.encoding).toBe('euc-kr')
      expect(reopened?.savedEncoding).toBe('euc-kr')
      expect(reopened?.isDirty).toBe(false)
    } finally {
      hub.dispose()
    }
  })

  it('locks config.json, .wiki-editor/frontmatter.json, and image buffers to utf-8 and rejects encoding changes or reopen', async () => {
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => '{}',
        readWorkspaceFileWithEncoding: async () => ({ content: '{}', encoding: 'utf-8' }),
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const configBuf = await hub.openConfigDocument(1)
      const schemaBuf = await hub.openWorkspaceFile(
        'C:/wiki/.wiki-editor/frontmatter.json',
        'frontmatter.json',
        undefined,
        1
      )
      const imageBuf = await hub.openWorkspaceFile('C:/wiki/assets/pic.png', 'pic.png', undefined, 1)

      for (const lockedBuf of [configBuf, schemaBuf, imageBuf]) {
        expect(lockedBuf.encoding).toBe('utf-8')
        expect(lockedBuf.savedEncoding).toBe('utf-8')
        expect(() => hub.setEncoding(lockedBuf.key, 'euc-kr')).toThrow()
        await expect(hub.reopenWithEncoding(lockedBuf.key, 'euc-kr')).rejects.toThrow()
        expect(hub.getBuffer(lockedBuf.key)?.encoding).toBe('utf-8')
        expect(hub.getBuffer(lockedBuf.key)?.savedEncoding).toBe('utf-8')
      }
    } finally {
      hub.dispose()
    }
  })

  it('saveBuffer returns unencodableChars without save-error on manual lossy failure and saves with allowLossy: true', async () => {
    let diskContent = '초기 본문'
    let diskEncoding: 'utf-8' | 'euc-kr' = 'euc-kr'
    const events: SharedBufferHubEvent[] = []
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => diskContent,
        readWorkspaceFileWithEncoding: async () => ({
          content: diskContent,
          encoding: diskEncoding
        }),
        writeWorkspaceFile: async (_filePath, content, options) => {
          if (options?.encoding === 'euc-kr' && content.includes('😀')) {
            if (!options.allowLossy) {
              throw new UnencodableCharactersError('euc-kr', { count: 1, samples: ['😀'] })
            }
            diskContent = content.replace(/😀/g, '?')
            diskEncoding = 'euc-kr'
            return
          }
          diskContent = content
          diskEncoding = options?.encoding ?? 'utf-8'
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    hub.subscribe((event) => events.push(event))

    try {
      const opened = await hub.openWorkspaceFile('C:/wiki/lossy.md', 'lossy.md', undefined, 1)
      hub.syncWindowTabs(1, [opened.key])
      hub.updateContent(opened.key, '안녕 😀')

      // Manual save without allowLossy fails with unencodableChars, touches neither disk nor save-error
      const blocked = await hub.saveBuffer(opened.key)
      expect(blocked.ok).toBe(false)
      expect(blocked.unencodableChars).toEqual({ count: 1, samples: ['😀'] })
      expect(diskContent).toBe('초기 본문')
      expect(events.some((e) => e.type === 'save-error')).toBe(false)

      // Manual save with allowLossy: true writes '?' replacement and updates savedEncoding
      const forced = await hub.saveBuffer(opened.key, { allowLossy: true })
      expect(forced.ok).toBe(true)
      expect(diskContent).toBe('안녕 ?')
      expect(diskEncoding).toBe('euc-kr')
      expect(forced.buffer?.savedEncoding).toBe('euc-kr')
      expect(forced.buffer?.isDirty).toBe(false)
    } finally {
      hub.dispose()
    }
  })

  it('auto-save runs with allowLossy: false, emits save-error, stops retrying, and retries after content or encoding change', async () => {
    let writeAttempts = 0
    const events: SharedBufferHubEvent[] = []
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: true, autoSaveDelayMs: 25 },
      storage: {
        readWorkspaceFile: async () => '초기',
        readWorkspaceFileWithEncoding: async () => ({ content: '초기', encoding: 'euc-kr' }),
        writeWorkspaceFile: async (_filePath, content, options) => {
          writeAttempts += 1
          if (options?.encoding === 'euc-kr' && !options.allowLossy && content.includes('😀')) {
            throw new UnencodableCharactersError('euc-kr', { count: 1, samples: ['😀'] })
          }
        },
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })
    hub.subscribe((event) => events.push(event))

    try {
      const opened = await hub.openWorkspaceFile('C:/wiki/auto.md', 'auto.md', undefined, 1)
      hub.syncWindowTabs(1, [opened.key])
      hub.updateContent(opened.key, '이모지 😀')

      await new Promise((resolve) => setTimeout(resolve, 90))
      expect(writeAttempts).toBe(1)
      expect(events.filter((e) => e.type === 'save-error')).toHaveLength(1)

      // Wait another cycle: must not infinitely retry for the same version
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(writeAttempts).toBe(1)

      // Changing encoding to utf-8 bumps version and triggers a new auto-save attempt that succeeds
      hub.setEncoding(opened.key, 'utf-8')
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(writeAttempts).toBe(2)
      expect(hub.getBuffer(opened.key)?.isDirty).toBe(false)
      expect(hub.getBuffer(opened.key)?.savedEncoding).toBe('utf-8')
    } finally {
      hub.dispose()
    }
  })

  it('reconcileWorkspaceBuffersWithDisk re-detects encoding for clean files and warns on encoding conflict for dirty files', async () => {
    let diskContent = 'Hello'
    let diskEncoding: 'utf-8' | 'euc-kr' = 'utf-8'
    const hub = new SharedDocumentBufferHub({
      initialAutoSaveConfig: { autoSave: false },
      storage: {
        readWorkspaceFile: async () => diskContent,
        readWorkspaceFileWithEncoding: async () => ({
          content: diskContent,
          encoding: diskEncoding
        }),
        writeWorkspaceFile: async () => undefined,
        getConfigPath: async () => 'C:/Users/test/config.json',
        readConfigRaw: async () => '{}',
        saveConfigRaw: async () => ({})
      }
    })

    try {
      const cleanBuf = await hub.openWorkspaceFile('C:/wiki/clean.md', 'clean.md', undefined, 1)
      const dirtyBuf = await hub.openWorkspaceFile('C:/wiki/dirty.md', 'dirty.md', undefined, 1)
      hub.syncWindowTabs(1, [cleanBuf.key, dirtyBuf.key])

      hub.updateContent(dirtyBuf.key, 'local dirty edit')

      // External change alters both content & encoding for clean.md and encoding for dirty.md
      diskContent = '외부 EUC-KR'
      diskEncoding = 'euc-kr'

      const result = await hub.reconcileWorkspaceBuffersWithDisk()
      const updatedClean = hub.getBuffer(cleanBuf.key)!
      expect(updatedClean.content).toBe('외부 EUC-KR')
      expect(updatedClean.savedContent).toBe('외부 EUC-KR')
      expect(updatedClean.encoding).toBe('euc-kr')
      expect(updatedClean.savedEncoding).toBe('euc-kr')
      expect(updatedClean.isDirty).toBe(false)

      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain('dirty.md')
    } finally {
      hub.dispose()
    }
  })
})
