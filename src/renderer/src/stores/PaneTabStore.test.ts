import { describe, expect, it, vi } from 'vitest'
import {
  canAcceptIncomingSplitDrop,
  canSplitWithTab,
  PaneTabStore,
  type PaneTabTransition
} from './PaneTabStore'

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

  it('emits authoritative domain transitions and treats duplicate-to-existing as focus switch instead of duplicate', () => {
    const transitions: PaneTabTransition[] = []
    const store = new PaneTabStore({
      onTransition: (transition) => {
        transitions.push(transition)
      }
    })

    const primaryAlpha = store.openTab('c:/wiki/alpha.md')
    store.openTab('c:/wiki/alpha.md') // already active in primary -> no transition

    const duplicatedAlpha = store.duplicateTabToOtherPane('primary', primaryAlpha.id)
    expect(duplicatedAlpha).not.toBeNull()

    // Focus back to primary via activateTab even though primaryAlpha is already primary.activeTabId
    store.activateTab('primary', primaryAlpha.id)

    // Duplicate again while secondary already has alpha.md -> switches focus, NOT tab-duplicated
    store.duplicateTabToOtherPane('primary', primaryAlpha.id)
    // Repeating when secondary is already active with alpha.md -> no-op
    store.duplicateTabToOtherPane('primary', primaryAlpha.id)

    // Cursor/scroll updates emit no transition; mode changes emit editor-mode-changed
    store.updateTabViewState('secondary', duplicatedAlpha!.id, {
      cursor: { selectionStart: 3, selectionEnd: 3 }
    })
    store.updateTabViewState('secondary', duplicatedAlpha!.id, { mode: 'preview' })

    const beta = store.openTab('c:/wiki/beta.md', { paneId: 'primary' })
    store.moveTab('primary', 'secondary', beta.id, 0)
    store.closeTab('secondary', duplicatedAlpha!.id)
    store.closeTab('secondary', beta.id)

    expect(
      transitions.map((t) =>
        t.type === 'split-mode-changed'
          ? `${t.type}:${t.from}->${t.to}`
          : t.type === 'editor-mode-changed'
            ? `${t.type}:${t.from}->${t.to}`
            : `${t.type}`
      )
    ).toEqual([
      'tab-opened',
      'tab-duplicated',
      'split-mode-changed:single->horizontal',
      'tab-switched',
      'tab-switched',
      'editor-mode-changed:raw->preview',
      'tab-opened',
      'tab-moved',
      'tab-closed',
      'tab-closed',
      'split-mode-changed:horizontal->single'
    ])
  })

  it('splits into vertical or horizontal mode when splitting a tab from single mode via splitWithTab', () => {
    const store = new PaneTabStore()
    const a = store.openTab('c:/wiki/a.md')

    // Sole tab in single mode cannot split
    expect(canSplitWithTab(store.getSnapshot())).toBe(false)
    store.splitWithTab('primary', a.id, 'vertical')
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(store.getSnapshot().panes.secondary.tabs).toHaveLength(0)

    // With 2+ tabs, splitWithTab('primary', b.id, 'vertical') opens vertical split with moved tab focused in secondary
    const b = store.openTab('c:/wiki/b.md')
    expect(canSplitWithTab(store.getSnapshot())).toBe(true)
    store.splitWithTab('primary', b.id, 'vertical')

    let snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.primary.activeTabId).toBe(a.id)
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([b.id])
    expect(snap.panes.secondary.activeTabId).toBe(b.id)

    // Collapsing back to single and splitting with 'horizontal' opens horizontal split
    store.closeTab('secondary', b.id)
    const c = store.openTab('c:/wiki/c.md')
    store.splitWithTab('primary', c.id, 'horizontal')
    snap = store.getSnapshot()
    expect(snap.splitMode).toBe('horizontal')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id])
  })

  it('switches split orientation in split mode via splitWithTab without emptying either pane', () => {
    const store = new PaneTabStore()
    const a = store.openTab('c:/wiki/a.md')
    const b = store.openTab('c:/wiki/b.md')
    const c = store.openTab('c:/wiki/c.md')

    // Start horizontal split: primary=[a, b], secondary=[c]
    store.splitWithTab('primary', c.id, 'horizontal')
    expect(store.getSnapshot().splitMode).toBe('horizontal')

    // 1) Primary has 2+ tabs -> splitWithTab('primary', b.id, 'vertical') moves tab to secondary and switches mode
    store.splitWithTab('primary', b.id, 'vertical')
    let snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])
    expect(snap.panes.secondary.activeTabId).toBe(b.id)

    // 2) Primary has only 1 tab -> switching to 'horizontal' keeps both panes non-empty and switches mode
    expect(canSplitWithTab(store.getSnapshot())).toBe(true)
    store.splitWithTab('primary', a.id, 'horizontal')
    snap = store.getSnapshot()
    expect(snap.splitMode).toBe('horizontal')
    expect(snap.activePaneId).toBe('primary')
    expect(snap.panes.primary.tabs.map((t) => t.id)).toEqual([a.id])
    expect(snap.panes.primary.activeTabId).toBe(a.id)
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])

    // 3) Dragging from secondary -> preserves secondary tab order, focuses dragged tab, and switches mode
    store.splitWithTab('secondary', c.id, 'vertical')
    snap = store.getSnapshot()
    expect(snap.splitMode).toBe('vertical')
    expect(snap.activePaneId).toBe('secondary')
    expect(snap.panes.secondary.tabs.map((t) => t.id)).toEqual([c.id, b.id])
    expect(snap.panes.secondary.activeTabId).toBe(c.id)

    // 4) Empty secondary guard: if secondary is empty, orientation switch from sole primary tab is a no-op
    const singlePaneStore = new PaneTabStore()
    const sole = singlePaneStore.openTab('c:/wiki/sole.md')
    singlePaneStore.setSplitMode('horizontal')
    expect(canSplitWithTab(singlePaneStore.getSnapshot())).toBe(false)
    singlePaneStore.splitWithTab('primary', sole.id, 'vertical')
    expect(singlePaneStore.getSnapshot().splitMode).toBe('horizontal')
    expect(singlePaneStore.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([sole.id])
    expect(singlePaneStore.getSnapshot().panes.secondary.tabs).toHaveLength(0)
  })

  it('preserves initial cursor and scrollTop options on openTab and reports total tab count across panes', () => {
    const store = new PaneTabStore()
    expect(store.getTotalTabCount()).toBe(0)

    const a = store.openTab('c:/wiki/a.md', {
      mode: 'wysiwyg',
      cursor: { selectionStart: 5, selectionEnd: 12 },
      scrollTop: 210
    })
    expect(a.mode).toBe('wysiwyg')
    expect(a.cursor).toEqual({ selectionStart: 5, selectionEnd: 12 })
    expect(a.scrollTop).toBe(210)
    expect(store.getTotalTabCount()).toBe(1)

    store.openTab('c:/wiki/b.md', { paneId: 'secondary', mode: 'preview' })
    expect(store.getTotalTabCount()).toBe(2)
  })

  it('inserts transferred tabs at specific indices or end, deduplicates by bufferKey per pane, and allows incoming split drop even in 1-tab single mode', () => {
    const store = new PaneTabStore()
    expect(canAcceptIncomingSplitDrop(store.getSnapshot())).toBe(false)

    // Empty window split drop falls back cleanly to primary single pane
    const first = store.acceptTransferredTab(
      {
        bufferKey: 'c:/wiki/alpha.md',
        mode: 'wysiwyg',
        cursor: { selectionStart: 2, selectionEnd: 6 },
        scrollTop: 42
      },
      { kind: 'split', direction: 'horizontal' }
    )
    expect(store.getSnapshot().splitMode).toBe('single')
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.id)).toEqual([first.id])
    expect(first.mode).toBe('wysiwyg')
    expect(first.cursor).toEqual({ selectionStart: 2, selectionEnd: 6 })
    expect(first.scrollTop).toBe(42)

    // Even with 1 tab in single mode, incoming external split drop is allowed (unlike same-window split)
    expect(canSplitWithTab(store.getSnapshot())).toBe(false)
    expect(canAcceptIncomingSplitDrop(store.getSnapshot())).toBe(true)

    // Insert at specific index 0 in primary
    const second = store.acceptTransferredTab(
      {
        bufferKey: 'c:/wiki/beta.md',
        mode: 'preview',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 100
      },
      { kind: 'pane', paneId: 'primary', targetIndex: 0 }
    )
    expect(store.getSnapshot().panes.primary.tabs.map((t) => t.bufferKey)).toEqual([
      'c:/wiki/beta.md',
      'c:/wiki/alpha.md'
    ])
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(second.id)

    // Same bufferKey dropped onto same pane activates existing tab instead of duplicating
    const focused = store.acceptTransferredTab(
      {
        bufferKey: 'c:/wiki/alpha.md',
        mode: 'raw',
        cursor: { selectionStart: 0, selectionEnd: 0 },
        scrollTop: 0
      },
      { kind: 'pane', paneId: 'primary' }
    )
    expect(focused.id).toBe(first.id)
    expect(store.getSnapshot().panes.primary.tabs).toHaveLength(2)
    expect(store.getSnapshot().panes.primary.activeTabId).toBe(first.id)

    // Single-tab target window splits cleanly when accepting external split drop
    const singleStore = new PaneTabStore()
    singleStore.openTab('c:/wiki/main.md')
    const splitTab = singleStore.acceptTransferredTab(
      {
        bufferKey: 'c:/wiki/side.md',
        mode: 'wysiwyg',
        cursor: { selectionStart: 4, selectionEnd: 9 },
        scrollTop: 155
      },
      { kind: 'split', direction: 'vertical' }
    )
    const splitSnap = singleStore.getSnapshot()
    expect(splitSnap.splitMode).toBe('vertical')
    expect(splitSnap.activePaneId).toBe('secondary')
    expect(splitSnap.panes.primary.tabs.map((t) => t.bufferKey)).toEqual(['c:/wiki/main.md'])
    expect(splitSnap.panes.secondary.tabs.map((t) => t.id)).toEqual([splitTab.id])
    expect(splitTab.mode).toBe('wysiwyg')
    expect(splitTab.scrollTop).toBe(155)
  })
})
