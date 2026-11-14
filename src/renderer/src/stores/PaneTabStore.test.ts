import { describe, expect, it, vi } from 'vitest'
import { PaneTabStore } from './PaneTabStore'

describe('PaneTabStore', () => {
  it('opens tabs, deduplicates within a pane, switches active tab, and selects neighbor on close', () => {
    const store = new PaneTabStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const t1 = store.openTab('c:/wiki/a.md')
    const t2 = store.openTab('c:/wiki/b.md')
    const t3 = store.openTab('c:/wiki/c.md')

    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.bufferKey)).toEqual([
      'c:/wiki/a.md',
      'c:/wiki/b.md',
      'c:/wiki/c.md'
    ])
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(t3.id)

    // Opening a.md again in same pane focuses t1 instead of creating duplicate
    const refocused = store.openTab('c:/wiki/a.md')
    expect(refocused.id).toBe(t1.id)
    expect(store.getSnapshot().panes.primary.tabs).toHaveLength(3)
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(t1.id)

    // Activate middle tab t2, then close it -> selects right neighbor t3
    store.activateTab('primary', t2.id)
    const result = store.closeTab('primary', t2.id)
    expect(result?.isLastReferenceForBuffer).toBe(true)
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([t1.id, t3.id])
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(t3.id)
    expect(listener).toHaveBeenCalled()
  })

  it('supports split mode transitions, clamped ratio, independent same-file tabs, move/duplicate, and auto-collapse', () => {
    const store = new PaneTabStore()

    const p1 = store.openTab('c:/wiki/shared.md')
    const p2 = store.openTab('c:/wiki/other.md')
    expect(store.getSnapshot().splitMode).toBe('single')

    // Duplicate shared.md to secondary pane auto-opens horizontal split
    const s1 = store.duplicateTabToOtherPane('primary', p1.id)
    expect(s1).not.toBeNull()
    expect(store.getSnapshot().splitMode).toBe('horizontal')
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(1)
    expect(s1!.id).not.toBe(p1.id)
    expect(s1!.bufferKey).toBe('c:/wiki/shared.md')

    // Closing one reference leaves isLastReferenceForBuffer = false because primary still holds shared.md
    expect(store.hasOtherTabForBuffer('c:/wiki/shared.md', s1!.id)).toBe(true)

    // Toggle vertical split and clamp split ratio to [0.15, 0.85]
    store.setSplitMode('vertical')
    expect(store.getSnapshot().splitMode).toBe('vertical')
    store.setSplitRatio(0.02)
    expect(store.getSnapshot().splitRatio).toBe(0.15)
    store.setSplitRatio(0.99)
    expect(store.getSnapshot().splitRatio).toBe(0.85)

    // Move other.md from primary to secondary at index 0
    store.moveTab('primary', 'secondary', p2.id, 0)
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([p1.id])
    expect(store.getSnapshot().panes.secondary.tabs.map((t) => t.id)).toEqual([p2.id, s1!.id])

    // Closing both tabs in secondary auto-collapses back to single mode
    store.closeTab('secondary', s1!.id)
    expect(store.getSnapshot().splitMode).toBe('vertical')
    store.closeTab('secondary', p2.id)
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().activePaneId).toBe('primary')
  })

  it('stores independent mode, cursor, and scrollTop per tab and handles renames/deletes/collapse merge', () => {
    const store = new PaneTabStore()

    const primaryTab = store.openTab('c:/wiki/doc.md')
    const secondaryTab = store.duplicateTabToOtherPane('primary', primaryTab.id)!

    store.updateTabViewState('primary', primaryTab.id, {
      mode: 'raw',
      cursor: { selectionStart: 10, selectionEnd: 15 },
      scrollTop: 120
    })
    store.updateTabViewState('secondary', secondaryTab.id, {
      mode: 'preview',
      cursor: { selectionStart: 2, selectionEnd: 2 },
      scrollTop: 340
    })

    const snap = store.getSnapshot()
    expect(snap.panes.primary.tabs[0]).toMatchObject({
      mode: 'raw',
      cursor: { selectionStart: 10, selectionEnd: 15 },
      scrollTop: 120
    })
    expect(snap.panes.secondary.tabs[0]).toMatchObject({
      mode: 'preview',
      cursor: { selectionStart: 2, selectionEnd: 2 },
      scrollTop: 340
    })

    // Rename updates bufferKey in both panes without losing per-tab view state
    store.remapBufferKeys([{ oldKey: 'c:/wiki/doc.md', newKey: 'c:/wiki/renamed.md' }])
    expect(store.getSnapshot().panes.primary.tabs[0].bufferKey).toBe('c:/wiki/renamed.md')
    expect(store.getSnapshot().panes.secondary.tabs[0].bufferKey).toBe('c:/wiki/renamed.md')
    expect(store.getSnapshot().panes.secondary.tabs[0].mode).toBe('preview')

    // Open unique file in secondary then collapse to single -> merges unique tab into primary
    const extraTab = store.openTab('c:/wiki/extra.md', { paneId: 'secondary' })
    store.setSplitMode('single')
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.bufferKey)).toEqual([
      'c:/wiki/renamed.md',
      'c:/wiki/extra.md'
    ])
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(0)

    // Delete closes matching tabs across panes
    store.closeTabsByBufferKeys(['c:/wiki/extra.md'])
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([primaryTab.id])
    expect(extraTab.bufferKey).toBe('c:/wiki/extra.md')
  })
})
