import { describe, expect, it, vi } from 'vitest'
import { DocumentBufferStore } from '@shared/documentBufferStore'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import type { MarkdownHeading } from '../editor/MarkdownTocEngine'
import { PaneTabStore, type PaneId } from './PaneTabStore'
import {
  PaneNavigationCoordinator,
  resolveDocumentJumpHighlights
} from './PaneNavigationCoordinator'
import type { OpenedWorkspaceDocument } from './RendererBufferSyncClient'

const DETAILS_HEADING: MarkdownHeading = {
  level: 2,
  depth: 1,
  number: '1.1.',
  rawTitle: 'Details',
  title: 'Details',
  slug: 'details',
  line: 3,
  hasExplicitNumber: false
}

function setupNavigation() {
  const bufferStore = new DocumentBufferStore()
  const tabStore = new PaneTabStore()

  const openDocument = (filePath: string, content: string, paneId?: PaneId): OpenedWorkspaceDocument => {
    const name = filePath.split('/').pop() ?? filePath
    const buffer = bufferStore.openBuffer({
      kind: 'workspace',
      path: filePath,
      name,
      content
    })
    const tab = tabStore.openTab(buffer.key, {
      paneId,
      mode: 'raw'
    })
    return { paneId: paneId ?? tabStore.getSnapshot().activePaneId, tab, buffer }
  }

  const coordinator = new PaneNavigationCoordinator({
    tabStore,
    bufferStore,
    openWorkspaceFile: async (target, targetPaneId, _explicitName, isCancelled) => {
      if (isCancelled?.()) return null
      const filePath = typeof target === 'string' ? target : target.path
      const existing = bufferStore.getBuffer(filePath)
      const content = existing?.content ?? '# Title\nAlpha line\n## Section'
      return openDocument(filePath, content, targetPaneId)
    }
  })

  return { bufferStore, tabStore, coordinator, openDocument }
}

describe('PaneNavigationCoordinator', () => {
  it('auto-invalidates pending Search Panel jump on tab-opened, tab-switched, editor-mode-changed, tab-closed, buffer edit, and workspace switch', async () => {
    const { bufferStore, tabStore, coordinator, openDocument } = setupNavigation()
    openDocument('C:/wiki/other.md', '# Other')

    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Alpha line', matches: [{ start: 0, end: 5 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )

    const initialJump = coordinator.getSnapshot().searchJumpRequest
    expect(initialJump).not.toBeNull()
    expect(initialJump?.query).toBe('Alpha')
    expect(initialJump?.lineNumber).toBe(2)

    // 1. Buffer content edit invalidates jump
    const alphaBuf = bufferStore.getBuffer('C:/wiki/alpha.md')!
    bufferStore.updateContent(alphaBuf.key, '# Title\nEdited Alpha line')
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    // 2. Re-dispatch, then editor-mode-changed invalidates jump
    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Edited Alpha line', matches: [{ start: 7, end: 12 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )
    const activeTab = tabStore.getActiveTab('primary')!
    expect(coordinator.getSnapshot().searchJumpRequest).not.toBeNull()
    tabStore.updateTabViewState('primary', activeTab.id, { mode: 'preview' })
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    // 3. Re-dispatch, then tab-switched invalidates jump
    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Edited Alpha line', matches: [{ start: 7, end: 12 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )
    expect(coordinator.getSnapshot().searchJumpRequest).not.toBeNull()
    const otherTab = tabStore.getSnapshot().panes.primary.tabs[0]
    tabStore.activateTab('primary', otherTab.id)
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    // 4. Re-dispatch, then tab-opened invalidates jump
    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Edited Alpha line', matches: [{ start: 7, end: 12 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )
    expect(coordinator.getSnapshot().searchJumpRequest).not.toBeNull()
    openDocument('C:/wiki/third.md', '# Third')
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    // 5. Re-dispatch, then tab-closed invalidates jump
    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Edited Alpha line', matches: [{ start: 7, end: 12 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )
    const alphaTab = tabStore.getActiveTab('primary')!
    expect(coordinator.getSnapshot().searchJumpRequest).not.toBeNull()
    tabStore.closeTab('primary', alphaTab.id)
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    // 6. Re-dispatch, then resetForWorkspaceSwitch invalidates jump
    await coordinator.openSearchLineMatch(
      { path: 'C:/wiki/alpha.md', name: 'alpha.md' },
      { lineNumber: 2, lineOffset: 0, lineText: 'Edited Alpha line', matches: [{ start: 7, end: 12 }] },
      'Alpha',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )
    expect(coordinator.getSnapshot().searchJumpRequest).not.toBeNull()
    coordinator.resetForWorkspaceSwitch()
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    coordinator.dispose()
  })

  it('cancels stale in-flight async search jump when superseded by a newer jump or another tab open', async () => {
    let resolveSlow!: (val: OpenedWorkspaceDocument | null) => void
    const slowPromise = new Promise<OpenedWorkspaceDocument | null>((resolve) => {
      resolveSlow = resolve
    })

    const bufferStore = new DocumentBufferStore()
    const tabStore = new PaneTabStore()
    const slowOpenCancelled = vi.fn()

    const coordinator = new PaneNavigationCoordinator({
      tabStore,
      bufferStore,
      openWorkspaceFile: async (target, _paneId, _name, isCancelled) => {
        const filePath = typeof target === 'string' ? target : target.path
        if (filePath.includes('slow')) {
          const result = await slowPromise
          if (isCancelled?.()) {
            slowOpenCancelled()
            return null
          }
          return result
        }
        const buffer = bufferStore.openBuffer({
          kind: 'workspace',
          path: filePath,
          name: 'fast.md',
          content: '# Fast\nFastTarget'
        })
        const tab = tabStore.openTab(buffer.key, { mode: 'raw' })
        return { paneId: tabStore.getSnapshot().activePaneId, tab, buffer }
      }
    })

    const slowDispatch = coordinator.openSearchLineMatch(
      { path: 'C:/wiki/slow.md', name: 'slow.md' },
      { lineNumber: 1, lineOffset: 0, lineText: 'SlowTarget', matches: [{ start: 0, end: 10 }] },
      'SlowTarget',
      DEFAULT_SEARCH_MATCH_OPTIONS
    )

    // Another tab opens while slow jump is in flight -> invalidates slow jump
    const otherBuf = bufferStore.openBuffer({
      kind: 'workspace',
      path: 'C:/wiki/other.md',
      name: 'other.md',
      content: '# Other'
    })
    tabStore.openTab(otherBuf.key, { mode: 'raw' })

    const slowBuf = bufferStore.openBuffer({
      kind: 'workspace',
      path: 'C:/wiki/slow.md',
      name: 'slow.md',
      content: '# Slow\nSlowTarget'
    })
    const slowTab = tabStore.openTab(slowBuf.key, {
      mode: 'raw'
    })
    resolveSlow({ paneId: tabStore.getSnapshot().activePaneId, tab: slowTab, buffer: slowBuf })
    await slowDispatch

    expect(slowOpenCancelled).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot().searchJumpRequest).toBeNull()

    coordinator.dispose()
  })

  it('manages Document Outline scroll request, pinned heading, scroll-spy updates, and auto-invalidates on tab/mode/edit/workspace transitions', () => {
    const { bufferStore, tabStore, coordinator, openDocument } = setupNavigation()
    const { paneId, tab } = openDocument('C:/wiki/guide.md', '# Intro\n\n## Details\nBody')
    const second = openDocument('C:/wiki/second.md', '# Second')
    tabStore.activateTab(paneId, tab.id)

    coordinator.selectOutlineHeading(DETAILS_HEADING, 1)

    let snap = coordinator.getSnapshot()
    expect(snap.outlineScrollRequest).toEqual({
      paneId,
      tabId: tab.id,
      mode: 'raw',
      line: 3,
      slug: 'details',
      index: 1,
      nonce: 1
    })
    expect(snap.activeHeadingIndex).toBe(1)

    // Programmatic scroll spy report does NOT drop pin
    coordinator.reportActiveHeading({
      context: { paneId, tabId: tab.id, mode: 'raw' },
      headingIndex: 0,
      isUserScroll: false
    })
    expect(coordinator.getSnapshot().activeHeadingIndex).toBe(1)

    // User scroll spy report DOES drop pin and updates activeHeadingIndex
    coordinator.reportActiveHeading({
      context: { paneId, tabId: tab.id, mode: 'raw' },
      headingIndex: 0,
      isUserScroll: true
    })
    expect(coordinator.getSnapshot().activeHeadingIndex).toBe(0)

    // Re-select heading, then buffer edit auto-invalidates outlineScrollRequest and pin
    coordinator.selectOutlineHeading(DETAILS_HEADING, 1)
    expect(coordinator.getSnapshot().outlineScrollRequest).not.toBeNull()
    bufferStore.updateContent(tab.bufferKey, '# Intro\n\n## Details\nEdited Body')
    snap = coordinator.getSnapshot()
    expect(snap.outlineScrollRequest).toBeNull()
    expect(snap.activeHeadingIndex).toBe(0)

    // Re-select heading, then editor-mode-changed auto-invalidates outlineScrollRequest
    coordinator.selectOutlineHeading(DETAILS_HEADING, 1)
    expect(coordinator.getSnapshot().outlineScrollRequest).not.toBeNull()
    tabStore.updateTabViewState(paneId, tab.id, { mode: 'split' })
    expect(coordinator.getSnapshot().outlineScrollRequest).toBeNull()

    // Re-select heading, then tab-switched auto-invalidates outlineScrollRequest
    coordinator.selectOutlineHeading(DETAILS_HEADING, 1)
    expect(coordinator.getSnapshot().outlineScrollRequest).not.toBeNull()
    tabStore.activateTab(paneId, second.tab.id)
    expect(coordinator.getSnapshot().outlineScrollRequest).toBeNull()

    // Re-select heading, then resetForWorkspaceSwitch clears state
    tabStore.activateTab(paneId, tab.id)
    coordinator.selectOutlineHeading(DETAILS_HEADING, 1)
    expect(coordinator.getSnapshot().outlineScrollRequest).not.toBeNull()
    coordinator.resetForWorkspaceSwitch()
    snap = coordinator.getSnapshot()
    expect(snap.outlineScrollRequest).toBeNull()
    expect(snap.activeHeadingIndex).toBeNull()

    coordinator.dispose()
  })

  it('derives mode-specific jump highlights with Split suppressing Preview scroll', () => {
    const request = {
      paneId: 'primary' as const,
      tabId: 'tab-1',
      query: 'alpha',
      options: { ...DEFAULT_SEARCH_MATCH_OPTIONS },
      lineNumber: 3,
      columnStart: 2,
      columnEnd: 7,
      nonce: 4
    }

    const splitHighlights = resolveDocumentJumpHighlights(request, 'tab-1', 'split', false)
    expect(splitHighlights.rawJumpHighlight).toEqual({
      lineNumber: 3,
      columnStart: 2,
      columnEnd: 7,
      nonce: 4
    })
    expect(splitHighlights.wysiwygJumpHighlight).toBeNull()
    expect(splitHighlights.previewJumpHighlight?.suppressScroll).toBe(true)

    const previewHighlights = resolveDocumentJumpHighlights(request, 'tab-1', 'preview', false)
    expect(previewHighlights.rawJumpHighlight).toBeNull()
    expect(previewHighlights.previewJumpHighlight?.suppressScroll).toBe(false)

    const imageHighlights = resolveDocumentJumpHighlights(request, 'tab-1', 'raw', true)
    expect(imageHighlights).toEqual({
      rawJumpHighlight: null,
      wysiwygJumpHighlight: null,
      previewJumpHighlight: null
    })
  })
})
