import type { BufferKeyRemap } from '@shared/documentBuffer'
import type { GitDiffRequest } from '@shared/git'
import {
  clampSplitRatio,
  type CursorPosition,
  DEFAULT_SPLIT_RATIO,
  type EditorMode,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  normalizeSplitRatio,
  type PaneId,
  roundSplitRatio,
  type SplitDirection,
  type SplitMode,
  type TabTransferPayload,
  type TabViewState
} from '@shared/window'
import { normalizeMermaidHeightPx } from '../editor/mermaidContainFit'
import { formatGitDiffTabKey } from '../utils/gitFilePresentation'

export type { CursorPosition, EditorMode, PaneId, SplitDirection, SplitMode, TabViewState }
export {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  normalizeSplitRatio,
  roundSplitRatio
}
export type GitDiffViewMode = 'side-by-side' | 'inline'

export interface DiffTabState {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
}

export type MermaidDiagramHeightMap = Readonly<Record<string, number>>

export interface DocumentTabRuntimeViewState {
  mermaidHeights?: MermaidDiagramHeightMap
}

export interface DocumentTabItem extends TabViewState, DocumentTabRuntimeViewState {
  id: string
  kind: 'document'
  bufferKey: string
  /** Left Raw region width fraction in Split mode (0.15..0.85, default 0.5); named splitPreviewRatio per spec contract. */
  splitPreviewRatio: number
}

export interface DiffTabItem {
  id: string
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

export interface OpenTabOptions extends Partial<TabViewState> {
  paneId?: PaneId
}

export type TransferredTabDropTarget =
  | {
      kind: 'pane'
      paneId: PaneId
      targetIndex?: number
    }
  | {
      kind: 'split'
      direction: SplitDirection
    }

export type TabViewPatch = Partial<TabViewState & DocumentTabRuntimeViewState>

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

export interface RestoreWorkspaceTabInput extends TabViewState {
  bufferKey: string
}

export interface RestoreWorkspacePaneInput {
  tabs: readonly RestoreWorkspaceTabInput[]
  activeTabKey: string | null
}

export interface RestoreWorkspaceLayoutInput {
  splitMode: SplitMode
  splitRatio: number
  activePaneId: PaneId
  panes: Record<PaneId, RestoreWorkspacePaneInput>
}

export interface PaneTabRestoreOptions {
  preserveTab?: (tab: TabItem) => boolean
}

function normalizeMermaidHeightMap(
  raw: MermaidDiagramHeightMap | undefined
): MermaidDiagramHeightMap | undefined {
  if (!raw) return undefined
  const normalized: Record<string, number> = {}
  let count = 0
  for (const [key, height] of Object.entries(raw)) {
    const normalizedHeight = normalizeMermaidHeightPx(height)
    if (normalizedHeight !== null) {
      normalized[key] = normalizedHeight
      count += 1
    }
  }
  return count > 0 ? normalized : undefined
}

function areMermaidHeightMapsEqual(
  left: MermaidDiagramHeightMap | undefined,
  right: MermaidDiagramHeightMap | undefined
): boolean {
  if (left === right) return true
  const leftKeys = left ? Object.keys(left) : []
  const rightKeys = right ? Object.keys(right) : []
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (left![key] !== right![key]) return false
  }
  return true
}

function createDocumentTab(
  id: string,
  bufferKey: string,
  viewState: Partial<TabViewState> = {}
): DocumentTabItem {
  return {
    id,
    kind: 'document',
    bufferKey,
    mode: viewState.mode ?? 'raw',
    cursor: viewState.cursor ? { ...viewState.cursor } : { selectionStart: 0, selectionEnd: 0 },
    scrollTop: viewState.scrollTop ?? 0,
    splitPreviewRatio: normalizeSplitRatio(viewState.splitPreviewRatio ?? DEFAULT_SPLIT_RATIO)
  }
}

function createInitialState(): PaneLayoutState {
  return {
    splitMode: 'single',
    splitRatio: DEFAULT_SPLIT_RATIO,
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

function collapseOrPromoteSplitLayout(
  primary: PaneState,
  secondary: PaneState,
  splitMode: SplitMode,
  activePaneId: PaneId,
  promoteSecondaryIfPrimaryEmpty: boolean
): Pick<PaneLayoutState, 'splitMode' | 'activePaneId' | 'panes'> {
  if (
    promoteSecondaryIfPrimaryEmpty &&
    primary.tabs.length === 0 &&
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
  if (secondary.tabs.length === 0) {
    return {
      splitMode: 'single',
      activePaneId: 'primary',
      panes: { primary, secondary }
    }
  }
  return {
    splitMode,
    activePaneId,
    panes: { primary, secondary }
  }
}

export function getPaneActiveTab(pane: PaneState): TabItem | null {
  if (!pane.activeTabId) return null
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null
}

function getTabIdentityKey(tab: TabItem): string {
  return tab.kind === 'document' ? tab.bufferKey : formatGitDiffTabKey(tab.diff.request)
}

function hasBufferReferenceInPanes(
  panes: Record<PaneId, PaneState>,
  bufferKey: string,
  excludeTabId?: string
): boolean {
  return [panes.primary, panes.secondary].some((pane) =>
    pane.tabs.some(
      (tab) => tab.kind === 'document' && tab.bufferKey === bufferKey && tab.id !== excludeTabId
    )
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
 * External cross-window drags add a tab rather than moving one out of `primary`, so even a
 * 1-tab `single`-mode window can split safely into `secondary`.
 */
export function canAcceptIncomingSplitDrop(layout: PaneLayoutState): boolean {
  return layout.panes.primary.tabs.length > 0
}

export function extractLayoutBufferKeys(layout: PaneLayoutState): string[] {
  const keys: string[] = []
  for (const paneId of ['primary', 'secondary'] as const) {
    const pane = layout.panes[paneId]
    if (!pane) continue
    for (const tab of pane.tabs) {
      if (tab.kind === 'document') {
        keys.push(tab.bufferKey)
      }
    }
  }
  return keys
}

export function countLayoutTabs(layout: PaneLayoutState): number {
  let count = 0
  for (const paneId of ['primary', 'secondary'] as const) {
    const pane = layout.panes[paneId]
    if (!pane) continue
    count += pane.tabs.length
  }
  return count
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

  getBufferKeys(): string[] {
    return extractLayoutBufferKeys(this.state)
  }

  getTotalTabCount(): number {
    return countLayoutTabs(this.state)
  }

  openTab = (bufferKey: string, options: OpenTabOptions = {}): DocumentTabItem =>
    this.openOrFocusTab(bufferKey, options)

  /**
   * Inserts or activates a transferred tab from another window on either a target pane tab bar
   * (optionally at `targetIndex`) or a newly activated split pane.
   */
  acceptTransferredTab = (
    payload: TabTransferPayload,
    target?: TransferredTabDropTarget
  ): DocumentTabItem => {
    const viewOptions: OpenTabOptions = {
      mode: payload.mode,
      cursor: payload.cursor,
      scrollTop: payload.scrollTop,
      splitPreviewRatio: payload.splitPreviewRatio
    }
    if (target?.kind === 'split') {
      if (this.state.panes.primary.tabs.length === 0) {
        return this.openOrFocusTab(payload.bufferKey, { ...viewOptions, paneId: 'primary' })
      }
      return this.openOrFocusTab(
        payload.bufferKey,
        { ...viewOptions, paneId: 'secondary' },
        undefined,
        { splitDirection: target.direction }
      )
    }

    const requestedPaneId = target?.paneId ?? this.state.activePaneId
    const paneId: PaneId =
      requestedPaneId === 'secondary' && this.state.panes.primary.tabs.length === 0
        ? 'primary'
        : requestedPaneId
    return this.openOrFocusTab(
      payload.bufferKey,
      { ...viewOptions, paneId },
      undefined,
      { targetIndex: target?.targetIndex }
    )
  }

  private resolveTargetPaneContext(
    paneIdOption?: PaneId,
    splitDirection?: SplitDirection
  ): {
    targetPaneId: PaneId
    targetPane: PaneState
    nextSplitMode: SplitMode
  } {
    const targetPaneId = paneIdOption ?? this.state.activePaneId
    const targetPane = this.state.panes[targetPaneId]
    const nextSplitMode =
      splitDirection ??
      (targetPaneId === 'secondary' && this.state.splitMode === 'single'
        ? 'horizontal'
        : this.state.splitMode)
    return { targetPaneId, targetPane, nextSplitMode }
  }

  private appendNewTabInPane<T extends TabItem>(
    targetPaneId: PaneId,
    targetPane: PaneState,
    nextSplitMode: SplitMode,
    created: T,
    duplicateFrom?: { sourcePaneId: PaneId; sourceTabId: string },
    targetIndex?: number
  ): T {
    this.commit(
      {
        ...this.state,
        splitMode: nextSplitMode,
        activePaneId: targetPaneId,
        panes: {
          ...this.state.panes,
          [targetPaneId]: {
            ...targetPane,
            tabs: insertTabAt(targetPane.tabs, created, targetIndex),
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

  openDiffTab = (
    request: GitDiffRequest,
    options: OpenDiffTabOptions = {},
    duplicateFrom?: { sourcePaneId: PaneId; sourceTabId: string }
  ): DiffTabItem => {
    const { targetPaneId, targetPane, nextSplitMode } = this.resolveTargetPaneContext(
      options.paneId
    )
    const nextDiffKey = formatGitDiffTabKey(request)

    const existing = duplicateFrom
      ? targetPane.tabs.find(
          (tab): tab is DiffTabItem =>
            tab.kind === 'diff' && formatGitDiffTabKey(tab.diff.request) === nextDiffKey
        )
      : targetPane.tabs.find((tab): tab is DiffTabItem => tab.kind === 'diff')

    if (existing) {
      const isSameTarget = formatGitDiffTabKey(existing.diff.request) === nextDiffKey
      const nextViewMode =
        options.viewMode ?? (isSameTarget ? existing.diff.viewMode : 'side-by-side')
      const updatedTab: DiffTabItem = {
        ...existing,
        diff: { request, viewMode: nextViewMode }
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
      diff: { request, viewMode: options.viewMode ?? 'side-by-side' }
    }

    return this.appendNewTabInPane(targetPaneId, targetPane, nextSplitMode, created, duplicateFrom)
  }

  private openOrFocusTab(
    bufferKey: string,
    options: OpenTabOptions = {},
    duplicateFrom?: { sourcePaneId: PaneId; sourceTabId: string },
    placement?: { targetIndex?: number; splitDirection?: SplitDirection }
  ): DocumentTabItem {
    const { targetPaneId, targetPane, nextSplitMode } = this.resolveTargetPaneContext(
      options.paneId,
      placement?.splitDirection
    )

    const existing = targetPane.tabs.find(
      (tab): tab is DocumentTabItem => tab.kind === 'document' && tab.bufferKey === bufferKey
    )
    if (existing) {
      this.commitTabActivation(targetPaneId, existing.id, nextSplitMode)
      return existing
    }

    const created = createDocumentTab(this.nextTabId(), bufferKey, options)

    return this.appendNewTabInPane(
      targetPaneId,
      targetPane,
      nextSplitMode,
      created,
      duplicateFrom,
      placement?.targetIndex
    )
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
    const { nextPane, removed } = removeTabFromPane(this.state.panes[paneId], tabId)
    if (!removed) return null

    const nextPrimary = paneId === 'primary' ? nextPane : this.state.panes.primary
    const nextSecondary = paneId === 'secondary' ? nextPane : this.state.panes.secondary
    const reconciled = collapseOrPromoteSplitLayout(
      nextPrimary,
      nextSecondary,
      this.state.splitMode,
      this.state.activePaneId,
      paneId === 'primary' && this.state.splitMode !== 'single'
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
    const existingKeys = new Set(primary.tabs.map(getTabIdentityKey))
    const mergedTabs = [
      ...primary.tabs,
      ...secondary.tabs.filter((tab) => !existingKeys.has(getTabIdentityKey(tab)))
    ]
    const activeSecondaryTab =
      this.state.activePaneId === 'secondary' ? getPaneActiveTab(secondary) : null
    const preservedSecondaryFocus = activeSecondaryTab
      ? mergedTabs.find((tab) => getTabIdentityKey(tab) === getTabIdentityKey(activeSecondaryTab))
          ?.id ?? null
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
    const { nextPane: nextSourcePane, removed } = removeTabFromPane(sourcePane, tabId)
    if (!removed) return

    const targetPane = this.state.panes[targetPaneId]
    const targetIdentity = getTabIdentityKey(removed)
    const existingInTarget = targetPane.tabs.find(
      (tab) => getTabIdentityKey(tab) === targetIdentity
    )

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
    const reconciled = collapseOrPromoteSplitLayout(
      nextPrimary,
      nextSecondary,
      nextSplitMode,
      targetPaneId,
      nextSplitMode !== 'single'
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
      {
        paneId: targetPaneId,
        mode: sourceTab.mode,
        splitPreviewRatio: sourceTab.splitPreviewRatio
      },
      { sourcePaneId, sourceTabId: tabId }
    )
  }

  private replaceTabInPane(
    paneId: PaneId,
    index: number,
    updatedTab: TabItem,
    transitions: PaneTabTransition[] = []
  ): void {
    const pane = this.state.panes[paneId]
    const nextTabs = [...pane.tabs]
    nextTabs[index] = updatedTab
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

    this.replaceTabInPane(paneId, index, {
      ...current,
      diff: { ...current.diff, viewMode }
    })
  }

  updateTabViewState = (paneId: PaneId, tabId: string, patch: TabViewPatch): void => {
    const pane = this.state.panes[paneId]
    const index = pane.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return

    const current = pane.tabs[index]
    if (current.kind !== 'document') return

    const nextMode = patch.mode ?? current.mode
    const nextCursor = patch.cursor ?? current.cursor
    const nextScrollTop = patch.scrollTop ?? current.scrollTop
    const nextSplitPreviewRatio =
      patch.splitPreviewRatio !== undefined
        ? normalizeSplitRatio(patch.splitPreviewRatio)
        : current.splitPreviewRatio
    const nextMermaidHeights =
      'mermaidHeights' in patch
        ? normalizeMermaidHeightMap(patch.mermaidHeights)
        : current.mermaidHeights

    if (
      nextMode === current.mode &&
      nextCursor.selectionStart === current.cursor.selectionStart &&
      nextCursor.selectionEnd === current.cursor.selectionEnd &&
      nextScrollTop === current.scrollTop &&
      nextSplitPreviewRatio === current.splitPreviewRatio &&
      areMermaidHeightMapsEqual(nextMermaidHeights, current.mermaidHeights)
    ) {
      return
    }

    const { mermaidHeights: _omittedMermaidHeights, ...baseTab } = current
    const updatedTab: DocumentTabItem = {
      ...baseTab,
      mode: nextMode,
      cursor: { ...nextCursor },
      scrollTop: nextScrollTop,
      splitPreviewRatio: nextSplitPreviewRatio,
      ...(nextMermaidHeights ? { mermaidHeights: nextMermaidHeights } : {})
    }

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

    this.replaceTabInPane(paneId, index, updatedTab, transitions)
  }

  remapBufferKeys(remappings: readonly BufferKeyRemap[]): void {
    if (remappings.length === 0) return
    const map = new Map(remappings.map((item) => [item.oldKey, item.newKey]))
    let changed = false

    const remapPane = (pane: PaneState): PaneState => {
      let paneChanged = false
      const nextTabs = pane.tabs.map((tab) => {
        if (tab.kind !== 'document') return tab
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

  closeUnstagedDiffTabsForPaths = (repoRelativePaths: readonly string[]): void => {
    if (repoRelativePaths.length === 0) return
    const targetSet = new Set(repoRelativePaths)
    this.removeTabsWhere(
      (tab) =>
        tab.kind === 'diff' &&
        tab.diff.request.kind === 'unstaged' &&
        targetSet.has(tab.diff.request.path)
    )
  }

  closeUnstagedDiffTabsExcept = (activeRepoRelativePaths: ReadonlySet<string>): void => {
    this.removeTabsWhere(
      (tab) =>
        tab.kind === 'diff' &&
        tab.diff.request.kind === 'unstaged' &&
        !activeRepoRelativePaths.has(tab.diff.request.path)
    )
  }

  closeAllUnstagedDiffTabs = (): void => {
    this.removeTabsWhere((tab) => tab.kind === 'diff' && tab.diff.request.kind === 'unstaged')
  }

  restoreWorkspaceLayout = (
    input: RestoreWorkspaceLayoutInput,
    options: PaneTabRestoreOptions = {}
  ): void => {
    const transitions: PaneTabTransition[] = []
    const buildPane = (paneId: PaneId): { pane: PaneState; restoredCount: number } => {
      const existingPane = this.state.panes[paneId]
      const inputPane = input.panes[paneId]
      const seenKeys = new Set<string>()
      const restoredTabs: DocumentTabItem[] = []

      for (const tabInput of inputPane.tabs) {
        if (seenKeys.has(tabInput.bufferKey)) continue
        seenKeys.add(tabInput.bufferKey)
        const created = createDocumentTab(this.nextTabId(), tabInput.bufferKey, tabInput)
        restoredTabs.push(created)
        transitions.push({ type: 'tab-opened', paneId, tab: created })
      }

      const preservedTabs = options.preserveTab
        ? existingPane.tabs.filter(
            (tab) => options.preserveTab!(tab) && !seenKeys.has(getTabIdentityKey(tab))
          )
        : []

      const tabs = [...restoredTabs, ...preservedTabs]
      let activeTabId: string | null = null
      if (restoredTabs.length > 0) {
        activeTabId =
          (inputPane.activeTabKey
            ? restoredTabs.find((tab) => tab.bufferKey === inputPane.activeTabKey)?.id
            : undefined) ?? restoredTabs[0].id
      } else if (preservedTabs.length > 0) {
        activeTabId =
          existingPane.activeTabId &&
          preservedTabs.some((tab) => tab.id === existingPane.activeTabId)
            ? existingPane.activeTabId
            : preservedTabs[0].id
      }

      return {
        pane: { id: paneId, tabs, activeTabId },
        restoredCount: restoredTabs.length
      }
    }

    const builtPrimary = buildPane('primary')
    const builtSecondary = buildPane('secondary')
    const hasAnyRestoredTab = builtPrimary.restoredCount > 0 || builtSecondary.restoredCount > 0
    const nextSplitRatio =
      hasAnyRestoredTab || input.splitMode !== 'single'
        ? normalizeSplitRatio(input.splitRatio)
        : this.state.splitRatio

    const candidateSplitMode: SplitMode =
      input.splitMode !== 'single'
        ? input.splitMode
        : this.state.splitMode !== 'single'
          ? this.state.splitMode
          : 'horizontal'
    const candidateActivePaneId: PaneId = hasAnyRestoredTab
      ? input.activePaneId === 'secondary'
        ? 'secondary'
        : 'primary'
      : this.state.activePaneId === 'secondary'
        ? 'secondary'
        : 'primary'

    const reconciled = collapseOrPromoteSplitLayout(
      builtPrimary.pane,
      builtSecondary.pane,
      candidateSplitMode,
      candidateActivePaneId,
      true
    )

    if (
      !hasAnyRestoredTab &&
      reconciled.splitMode === this.state.splitMode &&
      nextSplitRatio === this.state.splitRatio &&
      reconciled.activePaneId === this.state.activePaneId &&
      reconciled.panes.primary.tabs.length === this.state.panes.primary.tabs.length &&
      reconciled.panes.secondary.tabs.length === this.state.panes.secondary.tabs.length
    ) {
      return
    }

    this.commit(
      {
        ...reconciled,
        splitRatio: nextSplitRatio
      },
      transitions
    )
  }

  private removeTabsWhere(shouldRemove: (tab: TabItem) => boolean): void {
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

    const reconciled = collapseOrPromoteSplitLayout(
      pResult.nextPane,
      sResult.nextPane,
      this.state.splitMode,
      this.state.activePaneId,
      this.state.splitMode !== 'single'
    )

    this.commit({
      ...this.state,
      ...reconciled
    })
  }
}
