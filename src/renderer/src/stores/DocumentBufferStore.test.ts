import { describe, expect, it, vi } from 'vitest'
import { DocumentBufferStore } from './DocumentBufferStore'

describe('DocumentBufferStore', () => {
  it('opens and deduplicates buffers by normalized path across Windows and POSIX styles', () => {
    const store = new DocumentBufferStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    const opened = store.openBuffer({
      kind: 'workspace',
      path: 'C:\\wiki\\docs\\note.md',
      name: 'note.md',
      content: '# Hello'
    })

    expect(opened.key).toBe('c:/wiki/docs/note.md')
    expect(opened.content).toBe('# Hello')
    expect(opened.savedContent).toBe('# Hello')
    expect(opened.isDirty).toBe(false)
    expect(opened.version).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)

    // Opening equivalent path with forward slashes & different casing returns the same buffer
    const reopened = store.openBuffer({
      kind: 'workspace',
      path: 'c:/wiki/docs/Note.md',
      content: '# Stale Disk Read'
    })
    expect(reopened.key).toBe(opened.key)
    expect(reopened.content).toBe('# Hello')
    expect(reopened.version).toBe(1)

    unsubscribe()
  })

  it('tracks content updates, versions, dirty state, and save completion without clobbering concurrent edits', () => {
    const store = new DocumentBufferStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const buf = store.openBuffer({
      kind: 'workspace',
      path: 'C:/wiki/a.md',
      name: 'a.md',
      content: 'v0'
    })

    store.updateContent(buf.key, 'v1')
    let current = store.getBuffer(buf.key)!
    expect(current.content).toBe('v1')
    expect(current.isDirty).toBe(true)
    expect(current.version).toBe(2)

    // Re-opening while dirty preserves unsaved edits
    const reopened = store.openBuffer({
      kind: 'workspace',
      path: 'C:\\wiki\\a.md',
      content: 'v0'
    })
    expect(reopened.content).toBe('v1')
    expect(reopened.isDirty).toBe(true)

    // Simulate user typing v2 while v1 save is in-flight
    store.updateContent(buf.key, 'v2')
    store.markSaved(buf.key, 'v1')
    current = store.getBuffer(buf.key)!
    expect(current.savedContent).toBe('v1')
    expect(current.content).toBe('v2')
    expect(current.isDirty).toBe(true)

    // Saving v2 clears dirty
    store.markSaved(buf.key, 'v2')
    current = store.getBuffer(buf.key)!
    expect(current.isDirty).toBe(false)
    expect(listener).toHaveBeenCalled()
  })

  it('remaps renamed file and folder paths, removes deleted paths, clears workspace buffers while preserving config, and refreshes clean config only', () => {
    const store = new DocumentBufferStore()

    store.openBuffer({
      kind: 'workspace',
      path: 'C:/wiki/docs/guide.md',
      name: 'guide.md',
      content: '# Guide'
    })
    store.openBuffer({
      kind: 'workspace',
      path: 'C:/wiki/docs/sub/deep.md',
      name: 'deep.md',
      content: '# Deep'
    })
    store.openBuffer({
      kind: 'config',
      path: 'C:\\Users\\test\\config.json',
      name: 'config.json',
      content: '{"theme":"light"}'
    })

    // Make guide.md dirty before folder rename
    store.updateContent('C:\\wiki\\docs\\guide.md', '# Guide Edited')

    const remapped = store.syncRenamedPath('C:/wiki/docs', 'C:/wiki/guides')
    expect(remapped).toEqual([
      { oldKey: 'c:/wiki/docs/guide.md', newKey: 'c:/wiki/guides/guide.md' },
      { oldKey: 'c:/wiki/docs/sub/deep.md', newKey: 'c:/wiki/guides/sub/deep.md' }
    ])

    expect(store.getBuffer('c:/wiki/docs/guide.md')).toBeUndefined()
    const movedGuide = store.getBuffer('C:\\wiki\\guides\\guide.md')!
    expect(movedGuide.path).toBe('C:/wiki/guides/guide.md')
    expect(movedGuide.isDirty).toBe(true)
    expect(movedGuide.content).toBe('# Guide Edited')

    // Refresh clean config updates content; dirty config ignores refresh
    store.refreshCleanContent('C:/Users/test/config.json', '{"theme":"dark"}')
    expect(store.getBuffer('C:\\Users\\test\\config.json')!.content).toBe('{"theme":"dark"}')
    store.updateContent('C:\\Users\\test\\config.json', '{dirty')
    store.refreshCleanContent('C:\\Users\\test\\config.json', '{"theme":"light"}')
    expect(store.getBuffer('C:\\Users\\test\\config.json')!.content).toBe('{dirty')

    // Delete subfolder removes deep.md only
    const removedOnDelete = store.removeBuffersUnderPath('C:\\wiki\\guides\\sub')
    expect(removedOnDelete).toEqual(['c:/wiki/guides/sub/deep.md'])
    expect(store.getBuffer('c:/wiki/guides/sub/deep.md')).toBeUndefined()

    // Clearing workspace buffers removes workspace docs but preserves config.json
    const removedWorkspace = store.clearWorkspaceBuffers()
    expect(removedWorkspace).toEqual(['c:/wiki/guides/guide.md'])
    expect(store.getBuffer('C:\\Users\\test\\config.json')).toBeDefined()
    expect(store.getDirtyBuffers('workspace')).toEqual([])
    expect(store.getDirtyBuffers('config')).toHaveLength(1)
  })

  it('keeps read-only image buffers immutable, excludes them from dirty checks, and bumps cache version on refreshImageAsset', () => {
    const store = new DocumentBufferStore()

    const imageBuf = store.openBuffer({
      kind: 'workspace',
      contentKind: 'image',
      path: 'C:\\wiki\\assets\\diagram.png',
      name: 'diagram.png'
    })

    expect(imageBuf).toMatchObject({
      key: 'c:/wiki/assets/diagram.png',
      kind: 'workspace',
      contentKind: 'image',
      path: 'C:\\wiki\\assets\\diagram.png',
      name: 'diagram.png',
      content: '',
      savedContent: '',
      isDirty: false,
      isSaving: false,
      version: 1
    })

    // Text mutations and save state updates are ignored on image buffers
    store.updateContent(imageBuf.key, 'corrupted text')
    store.markSaved(imageBuf.key, 'corrupted text')
    store.setSaving(imageBuf.key, true)
    store.refreshCleanContent(imageBuf.key, 'corrupted text')

    const unchanged = store.getBuffer(imageBuf.key)!
    expect(unchanged.content).toBe('')
    expect(unchanged.savedContent).toBe('')
    expect(unchanged.isDirty).toBe(false)
    expect(unchanged.isSaving).toBe(false)
    expect(unchanged.version).toBe(1)
    expect(store.getDirtyBuffers()).toEqual([])

    // Refreshing external image bumps version for cache busting without dirtying
    store.refreshImageAsset(imageBuf.key)
    const refreshed = store.getBuffer(imageBuf.key)!
    expect(refreshed.version).toBe(2)
    expect(refreshed.isDirty).toBe(false)

    // Parent folder rename and deletion keep image buffer synchronized
    const remapped = store.syncRenamedPath('C:/wiki/assets', 'C:/wiki/media')
    expect(remapped).toEqual([
      { oldKey: 'c:/wiki/assets/diagram.png', newKey: 'c:/wiki/media/diagram.png' }
    ])
    const renamed = store.getBuffer('c:/wiki/media/diagram.png')!
    expect(renamed.contentKind).toBe('image')
    expect(renamed.path).toBe('C:/wiki/media/diagram.png')
    expect(renamed.name).toBe('diagram.png')

    expect(store.removeBuffersUnderPath('C:\\wiki\\media')).toEqual(['c:/wiki/media/diagram.png'])
    expect(store.getBuffer('c:/wiki/media/diagram.png')).toBeUndefined()
  })
})
