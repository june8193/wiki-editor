import type { GitDiffRequest } from '@shared/git'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'
import type { BufferKeyRemap } from './DocumentBufferStore'

export type PaneId = 'primary' | 'secondary'
export type SplitMode = 'single' | 'horizontal' | 'vertical'
export type SplitDirection = Exclude<SplitMode, 'single'>
export type EditorMode = 'raw' | 'preview' | 'wysiwyg'
export type GitDiffViewMode = 'side-by-side' | 'inline'

export interface CursorPosition {
  selectionStart: number
  selectionEnd: number
}

export interface DiffTabState {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
}

interface BaseTabItem {
  id: string
  bufferKey: string
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
}

export interface DocumentTabItem extends BaseTabItem {
  kind: 'document'
}

export interface DiffTabItem extends BaseTabItem {
  kind: 'diff'
  diff: DiffTabState
}

export type TabItem = DocumentTabItem | DiffTabItem

export interface OpenDiffTabOptions {
  paneId?: PaneId
  viewMode?: GitDiffViewMode
}

export interface PaneState {
  id: PaneId
  tabs: readonly TabItem[]
  activeTabId: string | null
}

export interface PaneLayoutState {
  splitMode: SplitMode
  splitRatio: number
  activePaneId: PaneId
  panes: Record<PaneId, PaneState>
}

export interface OpenTabOptions {
  paneId?: PaneId
  mode?: EditorMode
}

export interface TabViewPatch {
  mode?: EditorMode
  cursor?: CursorPosition
  scrollTop?: number
}

export interface CloseTabResult {
  closedTab: TabItem
  isLastReferenceForBuffer: boolean
}

export type PaneTabTransition =
  | { type: 'tab-opened'; paneId: PaneId; tab: TabItem }
  | {
      type: 'tab-duplicated'
      sourcePaneId: PaneId
      targetPaneId: PaneId
      sourceTabId: string
      tab: TabItem
    }
  | { type: 'tab-switched'; paneId: PaneId; tab: TabItem }
  | {
      type: 'tab-moved'
      sourcePaneId: PaneId
      targetPaneId: PaneId
      tab: TabItem
      targetIndex?: number
    }
  | { type: 'tab-closed'; paneId: PaneId; closedTab: TabItem; isLastReferenceForBuffer: boolean }
  | { type: 'editor-mode-changed'; paneId: PaneId; tab: TabItem; from: EditorMode; to: EditorMode }
  | { type: 'split-mode-changed'; from: SplitMode; to: SplitMode }

export interface PaneTabStoreOptions {
  onTransition?: (transition: PaneTabTransition) => void
}

const MIN_SPLIT_RATIO = 0.15
const MAX_SPLIT_RATIO = 0.85

function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

function createInitialState(): PaneLayoutState {
  return {
    splitMode: 'single',
    splitRatio: 0.5,
    activePaneId: 'primary',
    panes: {
      primary: { id: 'primary', tabs: [], activeTabId: null },
      secondary: { id: 'secondary', tabs: [], activeTabId: null }
    }
  }
}

function removeTabFromPane(
  pane: PaneState,
  tabId: string
): { nextPane: PaneState; removed: TabItem | null } {
  const index = pane.tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) {
    return { nextPane: pane, removed: null }
  }

  const removed = pane.tabs[index]
  const nextTabs = pane.tabs.filter((tab) => tab.id !== tabId)
  let nextActiveTabId = pane.activeTabId

  if (pane.activeTabId === tabId) {
    nextActiveTabId =
      nextTabs.length > 0 ? nextTabs[Math.min(index, nextTabs.length - 1)].id : null
  }

  return {
    nextPane: { ...pane, tabs: nextTabs, activeTabId: nextActiveTabId },
    removed
  }
}

function insertTabAt(
  tabs: readonly TabItem[],
  tab: TabItem,
  targetIndex?: number
): readonly TabItem[] {
  const next = [...tabs]
  if (targetIndex === undefined || targetIndex < 0 || targetIndex >= next.length) {
    next.push(tab)
  } else {
    next.splice(targetIndex, 0, tab)
  }
  return next
}

function reconcileRemovedLayout(
  primary: PaneState,
  secondary: PaneState,
  currentSplitMode: SplitMode,
  currentActivePaneId: PaneId,
  hadSecondaryTabs: boolean,
  promoteSecondaryIfPrimaryEmpty: boolean
): Pick<PaneLayoutState, 'splitMode' | 'activePaneId' | 'panes'> {
  if (hadSecondaryTabs && secondary.tabs.length === 0) {
    return {
      splitMode: 'single',
      activePaneId: 'primary',
      panes: { primary, secondary }
    }
  }
  if (
    promoteSecondaryIfPrimaryEmpty &&
    primary.tabs.length === 0 &&
    currentSplitMode !== 'single' &&
    secondary.tabs.length > 0
  ) {
    return {
      splitMode: 'single',
      activePaneId: 'primary',
      panes: {
        primary: {
          id: 'primary',
          tabs: secondary.tabs,
          activeTabId: secondary.activeTabId
        },
        secondary: { id: 'secondary', tabs: [], activeTabId: null }
      }
    }
  }
  return {
    splitMode: currentSplitMode,
    activePaneId: currentActivePaneId,
    panes: { primary, secondary }
  }
}

export function getPaneActiveTab(pane: PaneState): TabItem | null {
  if (!pane.activeTabId) return null
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null
}

function hasBufferReferenceInPanes(
  panes: Record<PaneId, PaneState>,
  bufferKey: string,
  excludeTabId?: string
): boolean {
  return [panes.primary, panes.secondary].some((pane) =>
    pane.tabs.some((tab) => tab.bufferKey === bufferKey && tab.id !== excludeTabId)
  )
}

function hasPopulatedSplitPanes(layout: PaneLayoutState): boolean {
  return (
    layout.splitMode !== 'single' &&
    layout.panes.primary.tabs.length > 0 &&
    layout.panes.secondary.tabs.length > 0
  )
}

export function canSplitWithTab(layout: PaneLayoutState): boolean {
  return layout.panes.primary.tabs.length > 1 || hasPopulatedSplitPanes(layout)
}
/**
 * Manages up to 2 split panes, independent per-pane tab bars, and lightweight inactive tab state.
 */
export class PaneTabStore {
  private state: PaneLayoutState = createInitialState()
  private nextTabSeq = 1
  private listeners = new Set<() => void>()
  private readonly onTransition?: (transition: PaneTabTransition) => void

  constructor(options: PaneTabStoreOptions = {}) {
    this.onTransition = options.onTransition
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PaneLayoutState => this.state

  private commit(
    nextState: PaneLayoutState,
    transitions: readonly PaneTabTransition[] = []
  ): void {
    const prevSplitMode = this.state.splitMode
    const emitted: readonly PaneTabTransition[] =
      nextState.splitMode !== prevSplitMode
        ? [
            ...transitions,
            { type: 'split-mode-changed', from: prevSplitMode, to: nextState.splitMode }
          ]
        : transitions
    this.state = nextState
    for (const transition of emitted) {
      this.onTransition?.(transition)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  private nextTabId(): string {
    const id = `tab-${this.nextTabSeq}`
    this.nextTabSeq += 1
    return id
  }

  getTab(paneId: PaneId, tabId: string): TabItem | undefined {
    return this.state.panes[paneId].tabs.find((tab) => tab.id === tabId)
  }

  getActiveTab(paneId: PaneId = this.state.activePaneId): TabItem | undefined {
    return getPaneActiveTab(this.state.panes[paneId]) ?? undefined
  }

  hasOtherTabForBuffer(bufferKey: string, excludeTabId?: string): boolean {
    return hasBufferReferenceInPanes(this.state.panes, bufferKey, excludeTabId)
  }

  openTab = (bufferKey: string, options: OpenTabOptions = {}): TabItem =>
    this.openOrFocusTab(bufferKey, options)

  openDiffTab = (
    request: GitDiffRequest,
    options: OpenDiffTabOptions = {},
    duplicateFrom?: { sourcePaneId: PaneId; sourceTabId: string }
  ): DiffTabItem => {
    const targetPaneId = options.paneId ?? this.state.activePaneId
    const targetPane = this.state.panes[targetPaneId]
    const nextSplitMode =
      targetPaneId === 'secondary' && this.state.splitMode === 'single'
        ? 'horizontal'
        : this.state.splitMode
    const nextBufferKey = formatGitDiffTabKey(request)

    const existing = duplicateFrom
      ? targetPane.tabs.find(
          (tab): tab is DiffTabItem => tab.kind === 'diff' && tab.bufferKey === nextBufferKey
        )
      : targetPane.tabs.find((tab): tab is DiffTabItem => tab.kind === 'diff')

    if (existing) {
      const isSameTarget = existing.bufferKey === nextBufferKey
      const nextViewMode = options.viewMode ?? (isSameTarget ? existing.diff.viewMode : 'side-by-side')
      const updatedTab: DiffTabItem = {
        ...existing,
        bufferKey: nextBufferKey,
        diff: { request, viewMode: nextViewMode },
        scrollTop: isSameTarget ? existing.scrollTop : 0
      }
      const nextTabs = targetPane.tabs.map((tab) => (tab.id === existing.id ? updatedTab : tab))
      const tabChanged =
        this.state.activePaneId !== targetPaneId ||
        targetPane.activeTabId !== existing.id ||
        !isSameTarget ||
        existing.diff.viewMode !== nextViewMode

      if (tabChanged || this.state.splitMode !== nextSplitMode) {
        this.commit(
          {
            ...this.state,
            splitMode: nextSplitMode,
            activePaneId: targetPaneId,
            panes: {
              ...this.state.panes,
              [targetPaneId]: {
                ...targetPane,
                tabs: nextTabs,
                activeTabId: existing.id
              }
            }
          },
          [{ type: 'tab-switched', paneId: targetPaneId, tab: updatedTab }]
        )
      }
      return updatedTab
    }

    const created: DiffTabItem = {
      id: this.nextTabId(),
      kind: 'diff',
      bufferKey: nextBufferKey,
      diff: { request, viewMode: options.viewMode ?? 'side-by-side' },
      mode: 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    }

    this.commit(
      {
        ...this.state,
        splitMode: nextSplitMode,
        activePaneId: targetPaneId,
        panes: {
          ...this.state.panes,
          [targetPaneId]: {
            ...targetPane,
            tabs: [...targetPane.tabs, created],
            activeTabId: created.id
          }
        }
      },
      [
        duplicateFrom
          ? {
              type: 'tab-duplicated',
              sourcePaneId: duplicateFrom.sourcePaneId,
              targetPaneId,
              sourceTabId: duplicateFrom.sourceTabId,
              tab: created
            }
          : { type: 'tab-opened', paneId: targetPaneId, tab: created }
      ]
    )
    return created
  }

  private openOrFocusTab(
    bufferKey: string,
    options: OpenTabOptions = {},
    duplicateFrom?: { sourcePaneId: PaneId; sourceTabId: string }
  ): TabItem {
    const targetPaneId = options.paneId ?? this.state.activePaneId
    const targetPane = this.state.panes[targetPaneId]
    const nextSplitMode =
      targetPaneId === 'secondary' && this.state.splitMode === 'single'
        ? 'horizontal'
        : this.state.splitMode

    const existing = targetPane.tabs.find((tab) => tab.bufferKey === bufferKey)
    if (existing) {
      this.commitTabActivation(targetPaneId, existing.id, nextSplitMode)
      return existing
    }

    const created: TabItem = {
      id: this.nextTabId(),
      kind: 'document',
      bufferKey,
      mode: options.mode ?? 'raw',
      cursor: { selectionStart: 0, selectionEnd: 0 },
      scrollTop: 0
    }

    this.commit(
      {
        ...this.state,
        splitMode: nextSplitMode,
        activePaneId: targetPaneId,
        panes: {
          ...this.state.panes,
          [targetPaneId]: {
            ...targetPane,
            tabs: [...targetPane.tabs, created],
            activeTabId: created.id
          }
        }
      },
      [
        duplicateFrom
          ? {
              type: 'tab-duplicated',
              sourcePaneId: duplicateFrom.sourcePaneId,
              targetPaneId,
              sourceTabId: duplicateFrom.sourceTabId,
              tab: created
            }
          : { type: 'tab-opened', paneId: targetPaneId, tab: created }
      ]
    )
    return created
  }

  activateTab = (paneId: PaneId, tabId: string): void => {
    const pane = this.state.panes[paneId]
    if (!pane.tabs.some((tab) => tab.id === tabId)) return
    this.commitTabActivation(paneId, tabId, this.state.splitMode)
  }

  focusPane = (paneId: PaneId): void => {
    if (paneId === 'secondary' && this.state.splitMode === 'single') return
    if (this.state.activePaneId === paneId) return
    this.commit({
      ...this.state,
      activePaneId: paneId
    })
  }

  closeTab(paneId: PaneId, tabId: string): CloseTabResult | null {
    const hadSecondaryTabs = this.state.panes.secondary.tabs.length > 0
    const { nextPane, removed } = removeTabFromPane(this.state.panes[paneId], tabId)
    if (!removed) return null

    const nextPrimary = paneId === 'primary' ? nextPane : this.state.panes.primary
    const nextSecondary = paneId === 'secondary' ? nextPane : this.state.panes.secondary
    const reconciled = reconcileRemovedLayout(
      nextPrimary,
      nextSecondary,
      this.state.splitMode,
      this.state.activePaneId,
      hadSecondaryTabs,
      paneId === 'primary'
    )
    const isLastReferenceForBuffer =
      removed.kind === 'document' &&
      !hasBufferReferenceInPanes(reconciled.panes, removed.bufferKey)

    this.commit(
      {
        ...this.state,
        ...reconciled
      },
      [{ type: 'tab-closed', paneId, closedTab: removed, isLastReferenceForBuffer }]
    )

    return {
      closedTab: removed,
      isLastReferenceForBuffer
    }
  }

  setSplitMode = (mode: SplitMode): void => {
    if (mode === this.state.splitMode) return

    if (mode !== 'single') {
      this.commit({
        ...this.state,
        splitMode: mode
      })
      return
    }

    const primary = this.state.panes.primary
    const secondary = this.state.panes.secondary
    const existingKeys = new Set(primary.tabs.map((tab) => tab.bufferKey))
    const mergedTabs = [
      ...primary.tabs,
      ...secondary.tabs.filter((tab) => !existingKeys.has(tab.bufferKey))
    ]
    const activeSecondaryTab =
      this.state.activePaneId === 'secondary' ? getPaneActiveTab(secondary) : null
    const preservedSecondaryFocus = activeSecondaryTab
      ? mergedTabs.find((tab) => tab.bufferKey === activeSecondaryTab.bufferKey)?.id ?? null
      : null
    const nextPrimaryActive =
      preservedSecondaryFocus ??
      primary.activeTabId ??
      (secondary.activeTabId && mergedTabs.some((t) => t.id === secondary.activeTabId)
        ? secondary.activeTabId
        : (mergedTabs[0]?.id ?? null))

    this.commit({
      ...this.state,
      splitMode: 'single',
      activePaneId: 'primary',
      panes: {
        primary: {
          id: 'primary',
          tabs: mergedTabs,
          activeTabId: nextPrimaryActive
        },
        secondary: { id: 'secondary', tabs: [], activeTabId: null }
      }
    })
  }

  setSplitRatio = (ratio: number): void => {
    const clamped = clampSplitRatio(ratio)
    if (clamped === this.state.splitRatio) return
    this.commit({
      ...this.state,
      splitRatio: clamped
    })
  }

  private commitTabActivation(
    paneId: PaneId,
    tabId: string,
    splitMode: SplitMode
  ): void {
    const pane = this.state.panes[paneId]
    const targetTab = pane.tabs.find((tab) => tab.id === tabId)
    if (!targetTab) return
    if (
      this.state.splitMode === splitMode &&
      this.state.activePaneId === paneId &&
      pane.activeTabId === tabId
    ) {
      return
    }
    const tabChanged = this.state.activePaneId !== paneId || pane.activeTabId !== tabId
    this.commit(
      {
        ...this.state,
        splitMode,
        activePaneId: paneId,
        panes: {
          ...this.state.panes,
          [paneId]: {
            ...pane,
            activeTabId: tabId
          }
        }
      },
      tabChanged ? [{ type: 'tab-switched', paneId, tab: targetTab }] : []
    )
  }

  private moveTabBetweenPanes(
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    nextSplitMode: SplitMode,
    targetIndex?: number
  ): void {
    const sourcePane = this.state.panes[sourcePaneId]
    const hadSecondaryTabs = this.state.panes.secondary.tabs.length > 0
    const { nextPane: nextSourcePane, removed } = removeTabFromPane(sourcePane, tabId)
    if (!removed) return

    const targetPane = this.state.panes[targetPaneId]
    const existingInTarget = targetPane.tabs.find((tab) => tab.bufferKey === removed.bufferKey)

    const nextTargetPane: PaneState = existingInTarget
      ? {
          ...targetPane,
          activeTabId: existingInTarget.id
        }
      : {
          ...targetPane,
          tabs: insertTabAt(targetPane.tabs, removed, targetIndex),
          activeTabId: removed.id
        }

    const nextPrimary = sourcePaneId === 'primary' ? nextSourcePane : nextTargetPane
    const nextSecondary = sourcePaneId === 'secondary' ? nextSourcePane : nextTargetPane
    const reconciled = reconcileRemovedLayout(
      nextPrimary,
      nextSecondary,
      nextSplitMode,
      targetPaneId,
      hadSecondaryTabs,
      true
    )

    this.commit(
      {
        ...this.state,
        ...reconciled
      },
      [
        {
          type: 'tab-moved',
          sourcePaneId,
          targetPaneId,
          tab: existingInTarget ?? removed,
          ...(targetIndex !== undefined ? { targetIndex } : {})
        }
      ]
    )
  }

  splitWithTab = (
    sourcePaneId: PaneId,
    tabId: string,
    splitDirection: SplitDirection
  ): void => {
    const sourcePane = this.state.panes[sourcePaneId]
    if (!sourcePane.tabs.some((tab) => tab.id === tabId)) return

    if (sourcePaneId === 'primary' && sourcePane.tabs.length > 1) {
      this.moveTabBetweenPanes('primary', 'secondary', tabId, splitDirection)
      return
    }

    if (hasPopulatedSplitPanes(this.state)) {
      this.commitTabActivation(sourcePaneId, tabId, splitDirection)
    }
  }

  moveTab = (
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    tabId: string,
    targetIndex?: number
  ): void => {
    const sourcePane = this.state.panes[sourcePaneId]
    const sourceIndex = sourcePane.tabs.findIndex((tab) => tab.id === tabId)
    if (sourceIndex === -1) return

    if (sourcePaneId === targetPaneId) {
      const movingTab = sourcePane.tabs[sourceIndex]
      const without = sourcePane.tabs.filter((tab) => tab.id !== tabId)
      const clampedIndex =
        targetIndex === undefined
          ? without.length
          : Math.max(0, Math.min(targetIndex, without.length))
      if (clampedIndex === sourceIndex && sourcePane.activeTabId === tabId) return

      const reordered = insertTabAt(without, movingTab, clampedIndex)
      this.commit(
        {
          ...this.state,
          activePaneId: targetPaneId,
          panes: {
            ...this.state.panes,
            [sourcePaneId]: {
              ...sourcePane,
              tabs: reordered,
              activeTabId: tabId
            }
          }
        },
        [
          {
            type: 'tab-moved',
            sourcePaneId,
            targetPaneId,
            tab: movingTab,
            ...(targetIndex !== undefined ? { targetIndex } : {})
          }
        ]
      )
      return
    }

    if (
      sourcePaneId === 'primary' &&
      targetPaneId === 'secondary' &&
      this.state.splitMode === 'single' &&
      sourcePane.tabs.length <= 1
    ) {
      return
    }

    const nextSplitMode =
      targetPaneId === 'secondary' && this.state.splitMode === 'single'
        ? 'horizontal'
        : this.state.splitMode

    this.moveTabBetweenPanes(sourcePaneId, targetPaneId, tabId, nextSplitMode, targetIndex)
  }

  duplicateTabToOtherPane = (sourcePaneId: PaneId, tabId: string): TabItem | null => {
    const sourceTab = this.getTab(sourcePaneId, tabId)
    if (!sourceTab) return null
    const targetPaneId: PaneId = sourcePaneId === 'primary' ? 'secondary' : 'primary'
    if (sourceTab.kind === 'diff') {
      return this.openDiffTab(
        sourceTab.diff.request,
        { paneId: targetPaneId, viewMode: sourceTab.diff.viewMode },
        { sourcePaneId, sourceTabId: tabId }
      )
    }
    return this.openOrFocusTab(
      sourceTab.bufferKey,
      { paneId: targetPaneId, mode: sourceTab.mode },
      { sourcePaneId, sourceTabId: tabId }
    )
  }

  updateDiffTabViewMode = (
    paneId: PaneId,
    tabId: string,
    viewMode: GitDiffViewMode
  ): void => {
    const pane = this.state.panes[paneId]
    const index = pane.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const current = pane.tabs[index]
    if (current.kind !== 'diff' || current.diff.viewMode === viewMode) return

    const updatedTab: DiffTabItem = {
      ...current,
      diff: { ...current.diff, viewMode }
    }
    const nextTabs = [...pane.tabs]
    nextTabs[index] = updatedTab

    this.commit({
      ...this.state,
      panes: {
        ...this.state.panes,
        [paneId]: {
          ...pane,
          tabs: nextTabs
        }
      }
    })
  }

  updateTabViewState = (paneId: PaneId, tabId: string, patch: TabViewPatch): void => {
    const pane = this.state.panes[paneId]
    const index = pane.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return

    const current = pane.tabs[index]
    const nextMode = patch.mode ?? current.mode
    const nextCursor = patch.cursor ?? current.cursor
    const nextScrollTop = patch.scrollTop ?? current.scrollTop

    if (
      nextMode === current.mode &&
      nextCursor.selectionStart === current.cursor.selectionStart &&
      nextCursor.selectionEnd === current.cursor.selectionEnd &&
      nextScrollTop === current.scrollTop
    ) {
      return
    }

    const updatedTab: TabItem = {
      ...current,
      mode: nextMode,
      cursor: { ...nextCursor },
      scrollTop: nextScrollTop
    }
    const nextTabs = [...pane.tabs]
    nextTabs[index] = updatedTab

    const transitions: PaneTabTransition[] =
      nextMode !== current.mode
        ? [
            {
              type: 'editor-mode-changed',
              paneId,
              tab: updatedTab,
              from: current.mode,
              to: nextMode
            }
          ]
        : []

    this.commit(
      {
        ...this.state,
        panes: {
          ...this.state.panes,
          [paneId]: {
            ...pane,
            tabs: nextTabs
          }
        }
      },
      transitions
    )
  }

  remapBufferKeys(remappings: readonly BufferKeyRemap[]): void {
    if (remappings.length === 0) return
    const map = new Map(remappings.map((item) => [item.oldKey, item.newKey]))
    let changed = false

    const remapPane = (pane: PaneState): PaneState => {
      let paneChanged = false
      const nextTabs = pane.tabs.map((tab) => {
        const nextKey = map.get(tab.bufferKey)
        if (!nextKey || nextKey === tab.bufferKey) return tab
        paneChanged = true
        changed = true
        return { ...tab, bufferKey: nextKey }
      })
      return paneChanged ? { ...pane, tabs: nextTabs } : pane
    }

    const nextPrimary = remapPane(this.state.panes.primary)
    const nextSecondary = remapPane(this.state.panes.secondary)

    if (changed) {
      this.commit({
        ...this.state,
        panes: {
          primary: nextPrimary,
          secondary: nextSecondary
        }
      })
    }
  }

  closeTabsByBufferKeys(keys: readonly string[]): void {
    if (keys.length === 0) return
    const keySet = new Set(keys)
    this.removeTabsWhere((tab) => tab.kind === 'document' && keySet.has(tab.bufferKey))
  }

  closeAllDiffTabs = (): void => {
    this.removeTabsWhere((tab) => tab.kind === 'diff')
  }

  private removeTabsWhere(shouldRemove: (tab: TabItem) => boolean): void {
    const hadSecondaryTabs = this.state.panes.secondary.tabs.length > 0

    const filterPane = (pane: PaneState): { nextPane: PaneState; changed: boolean } => {
      const nextTabs = pane.tabs.filter((tab) => !shouldRemove(tab))
      if (nextTabs.length === pane.tabs.length) {
        return { nextPane: pane, changed: false }
      }
      let nextActiveTabId = pane.activeTabId
      if (nextActiveTabId && !nextTabs.some((tab) => tab.id === nextActiveTabId)) {
        nextActiveTabId = nextTabs[0]?.id ?? null
      }
      return {
        nextPane: { ...pane, tabs: nextTabs, activeTabId: nextActiveTabId },
        changed: true
      }
    }

    const pResult = filterPane(this.state.panes.primary)
    const sResult = filterPane(this.state.panes.secondary)
    if (!pResult.changed && !sResult.changed) return

    const reconciled = reconcileRemovedLayout(
      pResult.nextPane,
      sResult.nextPane,
      this.state.splitMode,
      this.state.activePaneId,
      hadSecondaryTabs,
      true
    )

    this.commit({
      ...this.state,
      ...reconciled
    })
  }
}
