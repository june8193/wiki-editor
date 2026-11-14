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

  it('preserves secondary active tab focus when collapsing to single mode (including deduplicated buffers)', () => {
    const store = new PaneTabStore()

    const primaryDoc = store.openTab('c:/wiki/a.md')
    const sharedPrimary = store.openTab('c:/wiki/shared.md')
    store.activateTab('primary', primaryDoc.id)

    const secondaryUnique = store.openTab('c:/wiki/sec.md', { paneId: 'secondary' })
    expect(store.getSnapshot().activePaneId).toBe('secondary')

    // Case 1: active secondary tab is unique -> promoted to primary and focused
    store.setSplitMode('single')
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().activePaneId).toBe('primary')
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(secondaryUnique.id)
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(0)

    // Case 2: active secondary tab shares bufferKey with a primary tab -> primary matching tab gets focused
    store.activateTab('primary', primaryDoc.id)
    const duplicated = store.duplicateTabToOtherPane('primary', sharedPrimary.id)!
    store.activateTab('secondary', duplicated.id)
    expect(store.getSnapshot().activePaneId).toBe('secondary')

    store.setSplitMode('single')
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(sharedPrimary.id)
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.bufferKey)).not.toHaveLength(0)
  })

  it('blocks moving the sole primary tab to secondary in single mode, but promotes secondary when emptying primary in split mode', () => {
    const store = new PaneTabStore()

    const sole = store.openTab('c:/wiki/sole.md')
    expect(store.getSnapshot().splitMode).toBe('single')

    // Attempting to move the sole primary tab to secondary in single mode is a no-op
    store.moveTab('primary', 'secondary', sole.id)
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([sole.id])
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(0)

    // In split mode, moving primary's last tab to secondary promotes secondary into primary & collapses to single
    const sec = store.openTab('c:/wiki/sec.md', { paneId: 'secondary' })
    expect(store.getSnapshot().splitMode).toBe('horizontal')

    store.moveTab('primary', 'secondary', sole.id)
    const snap = store.getSnapshot()
    expect(snap.splitMode).toBe('single')
    expect(snap.activePaneId).toBe('primary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([sec.id, sole.id])
    expect(snap.panes.primary.activeTabId).toBe(sole.id)
    expect(snap.panes.secondary.tabs).toHaveLength(0)
  })

  it('splits into vertical or horizontal mode when moving a tab from single mode with targetSplitMode', () => {
    const store = new PaneTabStore()
    const a = store.openTab('c:/wiki/a.md')

    // Sole tab in single mode cannot split even when targetSplitMode is provided
    store.moveTab('primary', 'secondary', a.id, undefined, 'vertical')
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(0)

    // With 2+ tabs, targetSplitMode='vertical' opens vertical split with moved tab focused in secondary
    const b = store.openTab('c:/wiki/b.md')
    store.moveTab('primary', 'secondary', b.id, undefined, 'vertical')

    const snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.primary.activeTabId).toBe(a.id)
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([b.id])
    expect(snap.panes.secondary.activeTabId).toBe(b.id)
  })

  it('switches split orientation in split mode without emptying either pane', () => {
    const store = new PaneTabStore()
    const a = store.openTab('c:/wiki/a.md')
    const b = store.openTab('c:/wiki/b.md')
    const c = store.openTab('c:/wiki/c.md')

    // Start horizontal split: primary=[a, b], secondary=[c]
    store.moveTab('primary', 'secondary', c.id, undefined, 'horizontal')
    expect(store.getSnapshot().splitMode).toBe('horizontal')

    // 1) Primary has 2+ tabs -> moving b to secondary with targetSplitMode='vertical' moves tab and switches mode
    store.moveTab('primary', 'secondary', b.id, undefined, 'vertical')
    let snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])
    expect(snap.panes.secondary.activeTabId).toBe(b.id)

    // 2) Primary has only 1 tab -> switching to 'horizontal' keeps both panes non-empty and switches mode
    store.moveTab('primary', 'secondary', a.id, undefined, 'horizontal')
    snap = store.getSnapshot()
    expect(snap.splitMode).toBe('horizontal')
    expect(snap.activePaneId).toBe('primary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.primary.activeTabId).toBe(a.id)
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])

    // 3) Dragging from secondary -> preserves secondary tab order, focuses dragged tab, and switches mode
    store.moveTab('secondary', 'secondary', c.id, undefined, 'vertical')
    snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])
    expect(snap.panes.secondary.activeTabId).toBe(c.id)

    // 4) Empty secondary guard: if secondary is empty, orientation switch from sole primary tab is a no-op
    const singlePaneStore = new PaneTabStore()
    const sole = singlePaneStore.openTab('c:/wiki/sole.md')
    singlePaneStore.setSplitMode('horizontal')
    singlePaneStore.moveTab('primary', 'secondary', sole.id, undefined, 'vertical')
    expect(singlePaneStore.getSnapshot().splitMode).toBe('horizontal')
    expect(singlePaneStore.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([sole.id])
    expect(singlePaneStore.getSnapshot().panes.secondary.tabs).toHaveLength(0)
  })
})
