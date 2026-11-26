import type { DocumentBufferStore } from '@shared/documentBufferStore'
import type {
  DocumentJumpHighlightTarget,
  DocumentSearchJumpRequest,
  SearchMatchOptions,
  WorkspaceSearchFileResult,
  WorkspaceSearchLineMatch
} from '@shared/search'
import type { GitDiffRequest, GitDiffViewMode } from '@shared/git'
import type { DocumentSymbolItem, GitBlobSnapshotRequest } from '@shared/symbol'
import { getWorkspacePathKey, type WorkspaceEntry } from '@shared/workspace'
import type { DiffJumpRequest } from '../components/GitDiffViewer'
import { isImageDocument, isMarkdownDocument } from '../editor/editorModes'
import type { MarkdownHeading } from '../editor/MarkdownTocEngine'
import type {
  OutlineActiveHeadingReport,
  OutlineContextTarget,
  OutlineScrollRequest
} from '../editor/outlineScrollSpy'
import type { PreviewJumpHighlightQuery } from '../editor/previewSearchHighlight'
import type { RawJumpHighlightRequest } from '../editor/rawSearchHighlight'
import {
  type EditorMode,
  getPaneActiveTab,
  type PaneId,
  type PaneTabStore,
  type PaneTabTransition
} from './PaneTabStore'
import type { OpenedWorkspaceDocument } from './RendererBufferSyncClient'

export interface PaneDiffJumpRequest extends DiffJumpRequest {
  paneId: PaneId
  tabId: string
}

export interface PaneSnapshotJumpRequest {
  paneId: PaneId
  tabId: string
  lineNumber: number
  columnStart: number
  columnEnd: number
  nonce: number
}

export type PaneNavigationEntry =
  | {
      kind: 'document'
      tabId: string
      bufferKey: string
      filePath: string
      lineNumber: number
      columnStart: number
      columnEnd: number
    }
  | {
      kind: 'diff'
      tabId: string
      request: GitDiffRequest
      viewMode: GitDiffViewMode
      workspaceRootPath?: string
      lineNumber: number
      side: 'old' | 'new'
    }
  | {
      kind: 'snapshot'
      tabId: string
      request: GitBlobSnapshotRequest
      workspaceRootPath?: string
      lineNumber: number
      columnStart: number
      columnEnd: number
    }

export interface PaneHistoryAvailability {
  canGoBack: boolean
  canGoForward: boolean
}

export interface PaneNavigationSnapshot {
  searchJumpRequest: DocumentSearchJumpRequest | null
  outlineScrollRequest: OutlineScrollRequest | null
  diffJumpRequest: PaneDiffJumpRequest | null
  snapshotJumpRequest: PaneSnapshotJumpRequest | null
  activeHeadingIndex: number | null
  historyByPane: Record<PaneId, PaneHistoryAvailability>
}

export interface DocumentJumpHighlights {
  rawJumpHighlight: RawJumpHighlightRequest | null
  wysiwygJumpHighlight: DocumentJumpHighlightTarget | null
  previewJumpHighlight: PreviewJumpHighlightQuery | null
}

export interface PaneNavigationCoordinatorOptions {
  tabStore: PaneTabStore
  bufferStore: DocumentBufferStore
  openWorkspaceFile: (
    target: WorkspaceEntry | string,
    targetPaneId?: PaneId,
    explicitName?: string,
    isCancelled?: () => boolean
  ) => Promise<OpenedWorkspaceDocument | null>
}

interface NavigationTargetBase {
  paneId: PaneId
  tabId: string
  bufferKey: string
  mode: EditorMode
  content: string
}

interface ActiveJumpRecord extends NavigationTargetBase {
  request: DocumentSearchJumpRequest
}

interface InFlightJumpRecord {
  seq: number
  targetBufferKey: string
}

interface ActiveOutlineRecord extends NavigationTargetBase {
  request: OutlineScrollRequest
}

interface ActiveOutlineHeadingState {
  context: OutlineContextTarget
  index: number | null
}

interface PinnedOutlineHeadingState {
  context: OutlineContextTarget
  content: string
  index: number
}

const MAX_PANE_HISTORY_ENTRIES = 50

const EMPTY_HISTORY_AVAILABILITY: PaneHistoryAvailability = {
  canGoBack: false,
  canGoForward: false
}

function getLineColumnFromOffset(
  content: string,
  offset: number
): { lineNumber: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, content.length))
  let lineNumber = 1
  let lastLineStart = 0
  for (let i = 0; i < clamped; i += 1) {
    if (content.charCodeAt(i) === 10) {
      lineNumber += 1
      lastLineStart = i + 1
    }
  }
  return { lineNumber, column: clamped - lastLineStart }
}

const EMPTY_JUMP_HIGHLIGHTS: DocumentJumpHighlights = {
  rawJumpHighlight: null,
  wysiwygJumpHighlight: null,
  previewJumpHighlight: null
}

function isSameOutlineContext(
  a: OutlineContextTarget | null,
  b: OutlineContextTarget | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.paneId === b.paneId && a.tabId === b.tabId && a.mode === b.mode
}

function isPinValidForContext(
  pin: PinnedOutlineHeadingState | null,
  activeContext: OutlineContextTarget | null,
  bufferContent: string
): pin is PinnedOutlineHeadingState {
  return (
    pin !== null &&
    activeContext !== null &&
    isSameOutlineContext(pin.context, activeContext) &&
    pin.content === bufferContent
  )
}

function isSpyValidForContext(
  spy: ActiveOutlineHeadingState | null,
  activeContext: OutlineContextTarget | null
): spy is ActiveOutlineHeadingState {
  return spy !== null && activeContext !== null && isSameOutlineContext(spy.context, activeContext)
}

function toJumpTarget(jump: DocumentSearchJumpRequest): DocumentJumpHighlightTarget {
  return {
    query: jump.query,
    options: jump.options,
    lineNumber: jump.lineNumber,
    columnStart: jump.columnStart,
    columnEnd: jump.columnEnd,
    nonce: jump.nonce
  }
}

/**
 * Computes mode-specific jump highlight payloads from a single jump request.
 * In Split mode, Preview suppresses its own scroll so Raw drives line-synced scrolling.
 */
export function resolveDocumentJumpHighlights(
  searchJumpRequest: DocumentSearchJumpRequest | null,
  tabId: string,
  effectiveMode: EditorMode,
  isImage: boolean
): DocumentJumpHighlights {
  if (isImage || !searchJumpRequest || searchJumpRequest.tabId !== tabId) {
    return EMPTY_JUMP_HIGHLIGHTS
  }

  return {
    rawJumpHighlight:
      effectiveMode === 'raw' || effectiveMode === 'split'
        ? {
            lineNumber: searchJumpRequest.lineNumber,
            columnStart: searchJumpRequest.columnStart,
            columnEnd: searchJumpRequest.columnEnd,
            nonce: searchJumpRequest.nonce
          }
        : null,
    wysiwygJumpHighlight: effectiveMode === 'wysiwyg' ? toJumpTarget(searchJumpRequest) : null,
    previewJumpHighlight:
      effectiveMode === 'preview' || effectiveMode === 'split'
        ? {
            ...toJumpTarget(searchJumpRequest),
            suppressScroll: effectiveMode === 'split'
          }
        : null
  }
}

/**
 * Coordinates ephemeral per-pane navigation state (Search Panel jumps and Document Outline
 * scroll-spy / click-to-scroll), subscribing directly to `PaneTabStore` transitions and
 * `DocumentBufferStore` edits so pending requests auto-invalidate in one place.
 */
export class PaneNavigationCoordinator {
  private readonly tabStore: PaneTabStore
  private readonly bufferStore: DocumentBufferStore
  private readonly openWorkspaceFileFn: PaneNavigationCoordinatorOptions['openWorkspaceFile']

  private readonly listeners = new Set<() => void>()
  private readonly unsubscribes: Array<() => void> = []
  private disposed = false

  private searchJumpSeq = 0
  private inFlightJump: InFlightJumpRecord | null = null
  private activeJump: ActiveJumpRecord | null = null

  private outlineScrollSeq = 0
  private activeOutlineScroll: ActiveOutlineRecord | null = null
  private diffJumpSeq = 0
  private activeDiffJump: PaneDiffJumpRequest | null = null
  private snapshotJumpSeq = 0
  private activeSnapshotJump: PaneSnapshotJumpRequest | null = null
  private spyOutlineHeading: ActiveOutlineHeadingState | null = null
  private pinnedOutlineHeading: PinnedOutlineHeadingState | null = null
  private latestSpyByPane: Partial<Record<PaneId, ActiveOutlineHeadingState>> = {}
  private backStackByPane: Record<PaneId, PaneNavigationEntry[]> = {
    primary: [],
    secondary: []
  }
  private forwardStackByPane: Record<PaneId, PaneNavigationEntry[]> = {
    primary: [],
    secondary: []
  }
  private lastLocationByTabId = new Map<string, { lineNumber: number; side?: 'old' | 'new' }>()

  private cachedSnapshot: PaneNavigationSnapshot

  constructor(options: PaneNavigationCoordinatorOptions) {
    this.tabStore = options.tabStore
    this.bufferStore = options.bufferStore
    this.openWorkspaceFileFn = options.openWorkspaceFile

    this.cachedSnapshot = {
      searchJumpRequest: null,
      outlineScrollRequest: null,
      diffJumpRequest: null,
      snapshotJumpRequest: null,
      activeHeadingIndex: null,
      historyByPane: {
        primary: EMPTY_HISTORY_AVAILABILITY,
        secondary: EMPTY_HISTORY_AVAILABILITY
      }
    }

    this.unsubscribes.push(
      this.tabStore.subscribeTransitions(this.handleTabTransition),
      this.tabStore.subscribe(this.handleLayoutUpdate),
      this.bufferStore.subscribe(this.handleBufferUpdate)
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): PaneNavigationSnapshot => this.cachedSnapshot

  dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.searchJumpSeq += 1
    this.inFlightJump = null
    this.activeJump = null
    this.activeOutlineScroll = null
    this.activeDiffJump = null
    this.activeSnapshotJump = null
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes.length = 0
    this.listeners.clear()
  }

  resetForWorkspaceSwitch = (): void => {
    this.searchJumpSeq += 1
    this.inFlightJump = null
    this.activeJump = null
    this.activeOutlineScroll = null
    this.activeDiffJump = null
    this.activeSnapshotJump = null
    this.spyOutlineHeading = null
    this.pinnedOutlineHeading = null
    this.latestSpyByPane = {}
    this.backStackByPane = { primary: [], secondary: [] }
    this.forwardStackByPane = { primary: [], secondary: [] }
    this.lastLocationByTabId.clear()
    this.syncSnapshot()
  }

  openSearchLineMatch = async (
    file: Pick<WorkspaceSearchFileResult, 'path' | 'name'>,
    line: WorkspaceSearchLineMatch,
    query: string,
    options: SearchMatchOptions
  ): Promise<void> => {
    const firstSpan = line.matches[0]
    const columnStart = firstSpan ? line.lineOffset + firstSpan.start : 0
    const columnEnd = firstSpan ? line.lineOffset + firstSpan.end : 0

    await this.openFileWithJump({
      filePath: file.path,
      explicitName: file.name,
      lineNumber: line.lineNumber,
      columnStart,
      columnEnd,
      query,
      options
    })
  }

  /**
   * Opens a workspace file in the active pane and optionally jumps to a 1-based line/column.
   */
  openFileAtLine = async (
    filePath: string,
    lineNumber?: number,
    column?: number
  ): Promise<void> => {
    if (lineNumber === undefined) {
      await this.openWorkspaceFileFn(filePath)
      return
    }
    const columnOffset = column && column >= 1 ? column - 1 : 0
    await this.openFileWithJump({
      filePath,
      lineNumber,
      columnStart: columnOffset,
      columnEnd: columnOffset,
      query: '',
      options: { caseSensitive: false, wholeWord: false, useRegex: false }
    })
  }

  private openFileWithJump = async ({
    filePath,
    targetPaneId,
    explicitName,
    lineNumber,
    columnStart,
    columnEnd,
    query,
    options
  }: {
    filePath: string
    targetPaneId?: PaneId
    explicitName?: string
    lineNumber: number
    columnStart: number
    columnEnd: number
    query: string
    options: SearchMatchOptions
  }): Promise<void> => {
    const jumpSeq = ++this.searchJumpSeq
    const targetBufferKey = getWorkspacePathKey(filePath)
    this.inFlightJump = { seq: jumpSeq, targetBufferKey }
    this.activeJump = null
    this.syncSnapshot()

    const isCancelled = (): boolean => this.disposed || this.searchJumpSeq !== jumpSeq

    const opened = await this.openWorkspaceFileFn(
      filePath,
      targetPaneId,
      explicitName,
      isCancelled
    )
    if (this.inFlightJump?.seq === jumpSeq) {
      this.inFlightJump = null
    }
    if (!opened || isCancelled()) {
      return
    }

    const buffer = this.bufferStore.getBuffer(opened.tab.bufferKey)
    if (!buffer || isImageDocument(buffer)) {
      return
    }

    this.activeJump = {
      paneId: opened.paneId,
      tabId: opened.tab.id,
      bufferKey: opened.tab.bufferKey,
      mode: opened.tab.mode,
      content: buffer.content,
      request: {
        paneId: opened.paneId,
        tabId: opened.tab.id,
        query,
        options,
        lineNumber,
        columnStart,
        columnEnd,
        nonce: jumpSeq
      }
    }
    this.syncSnapshot()
  }

  dispatchOutlineHeadingScroll = (
    context: OutlineContextTarget,
    content: string,
    heading: MarkdownHeading,
    index: number
  ): void => {
    this.outlineScrollSeq += 1
    const tab = this.tabStore.getTab(context.paneId, context.tabId)
    const bufferKey = tab?.kind === 'document' ? tab.bufferKey : ''
    const request: OutlineScrollRequest = {
      ...context,
      line: heading.line,
      slug: heading.slug,
      index,
      nonce: this.outlineScrollSeq
    }
    this.activeOutlineScroll = {
      paneId: context.paneId,
      tabId: context.tabId,
      bufferKey,
      mode: context.mode,
      content,
      request
    }
    this.pinnedOutlineHeading = {
      context,
      content,
      index
    }
    this.syncSnapshot()
  }

  selectOutlineHeading = (heading: MarkdownHeading, index: number): void => {
    const active = this.resolveActiveOutlineContext()
    if (!active.context) return
    this.dispatchOutlineHeadingScroll(active.context, active.bufferContent, heading, index)
  }

  recordNavigationOrigin = (paneId: PaneId, entry: PaneNavigationEntry): void => {
    this.lastLocationByTabId.set(entry.tabId, {
      lineNumber: entry.lineNumber,
      ...(entry.kind === 'diff' ? { side: entry.side } : {})
    })
    const stack = this.backStackByPane[paneId]
    stack.push(entry)
    if (stack.length > MAX_PANE_HISTORY_ENTRIES) {
      stack.splice(0, stack.length - MAX_PANE_HISTORY_ENTRIES)
    }
    this.forwardStackByPane[paneId] = []
    this.syncSnapshot()
  }

  captureCurrentPaneEntry = (paneId: PaneId): PaneNavigationEntry | null => {
    const layout = this.tabStore.getSnapshot()
    const pane = layout.panes[paneId]
    const activeTab = getPaneActiveTab(pane)
    if (!activeTab) return null
    if (activeTab.kind === 'diff') {
      const remembered = this.lastLocationByTabId.get(activeTab.id)
      const activeJump =
        this.activeDiffJump && this.activeDiffJump.tabId === activeTab.id
          ? this.activeDiffJump
          : null
      return {
        kind: 'diff',
        tabId: activeTab.id,
        request: activeTab.diff.request,
        viewMode: activeTab.diff.viewMode,
        workspaceRootPath: activeTab.diff.workspaceRootPath,
        lineNumber: activeJump?.lineNumber ?? remembered?.lineNumber ?? 1,
        side: activeJump?.side ?? remembered?.side ?? 'new'
      }
    }
    if (activeTab.kind === 'snapshot') {
      const remembered = this.lastLocationByTabId.get(activeTab.id)
      const activeJump =
        this.activeSnapshotJump && this.activeSnapshotJump.tabId === activeTab.id
          ? this.activeSnapshotJump
          : null
      return {
        kind: 'snapshot',
        tabId: activeTab.id,
        request: activeTab.snapshot.request,
        workspaceRootPath: activeTab.snapshot.workspaceRootPath,
        lineNumber: activeJump?.lineNumber ?? remembered?.lineNumber ?? 1,
        columnStart: activeJump?.columnStart ?? 0,
        columnEnd: activeJump?.columnEnd ?? 0
      }
    }
    const buffer = this.bufferStore.getBuffer(activeTab.bufferKey)
    if (!buffer || isImageDocument(buffer)) return null
    const { lineNumber, column } = getLineColumnFromOffset(
      buffer.content,
      activeTab.cursor.selectionStart
    )
    return {
      kind: 'document',
      tabId: activeTab.id,
      bufferKey: activeTab.bufferKey,
      filePath: buffer.path,
      lineNumber,
      columnStart: column,
      columnEnd: column
    }
  }

  private stepNavigationHistory = async (
    paneId: PaneId,
    sourceStack: PaneNavigationEntry[],
    targetStack: PaneNavigationEntry[],
    currentEntryOverride?: PaneNavigationEntry | null
  ): Promise<boolean> => {
    const target = sourceStack.pop()
    if (!target) {
      return false
    }
    const currentEntry =
      currentEntryOverride !== undefined
        ? currentEntryOverride
        : this.captureCurrentPaneEntry(paneId)
    if (currentEntry) {
      targetStack.push(currentEntry)
      if (targetStack.length > MAX_PANE_HISTORY_ENTRIES) {
        targetStack.splice(0, targetStack.length - MAX_PANE_HISTORY_ENTRIES)
      }
    }
    await this.restoreNavigationEntry(paneId, target)
    this.syncSnapshot()
    return true
  }

  goBack = (
    paneId: PaneId,
    currentEntryOverride?: PaneNavigationEntry | null
  ): Promise<boolean> =>
    this.stepNavigationHistory(
      paneId,
      this.backStackByPane[paneId],
      this.forwardStackByPane[paneId],
      currentEntryOverride
    )

  goForward = (
    paneId: PaneId,
    currentEntryOverride?: PaneNavigationEntry | null
  ): Promise<boolean> =>
    this.stepNavigationHistory(
      paneId,
      this.forwardStackByPane[paneId],
      this.backStackByPane[paneId],
      currentEntryOverride
    )

  private restoreNavigationEntry = async (
    paneId: PaneId,
    entry: PaneNavigationEntry
  ): Promise<void> => {
    const pane = this.tabStore.getSnapshot().panes[paneId]
    if (entry.kind === 'diff') {
      const existing = pane.tabs.find((tab) => tab.kind === 'diff' && tab.id === entry.tabId)
      const tab = existing
        ? existing
        : this.tabStore.openDiffTab(entry.request, {
            paneId,
            viewMode: entry.viewMode,
            workspaceRootPath: entry.workspaceRootPath
          })
      if (existing) {
        this.tabStore.activateTab(paneId, existing.id)
      }
      this.jumpToDiffLine(paneId, tab.id, entry.lineNumber, entry.side)
      return
    }

    if (entry.kind === 'snapshot') {
      const existing = pane.tabs.find((tab) => tab.kind === 'snapshot' && tab.id === entry.tabId)
      const tab = existing
        ? existing
        : this.tabStore.openSnapshotTab(entry.request, {
            paneId,
            workspaceRootPath: entry.workspaceRootPath
          })
      if (existing) {
        this.tabStore.activateTab(paneId, existing.id)
      }
      this.jumpToSnapshotLine(
        paneId,
        tab.id,
        entry.lineNumber,
        entry.columnStart,
        entry.columnEnd
      )
      return
    }

    const existingDoc = pane.tabs.find(
      (tab) =>
        tab.kind === 'document' && (tab.id === entry.tabId || tab.bufferKey === entry.bufferKey)
    )
    if (existingDoc && existingDoc.kind === 'document') {
      this.tabStore.activateTab(paneId, existingDoc.id)
      const buffer = this.bufferStore.getBuffer(existingDoc.bufferKey)
      if (buffer && !isImageDocument(buffer)) {
        const jumpSeq = ++this.searchJumpSeq
        this.activeJump = {
          paneId,
          tabId: existingDoc.id,
          bufferKey: existingDoc.bufferKey,
          mode: existingDoc.mode,
          content: buffer.content,
          request: {
            paneId,
            tabId: existingDoc.id,
            query: '',
            options: { caseSensitive: false, wholeWord: false, useRegex: false },
            lineNumber: entry.lineNumber,
            columnStart: entry.columnStart,
            columnEnd: entry.columnEnd,
            nonce: jumpSeq
          }
        }
        this.syncSnapshot()
        return
      }
    }

    await this.openFileWithJump({
      filePath: entry.filePath,
      targetPaneId: paneId,
      lineNumber: entry.lineNumber,
      columnStart: entry.columnStart,
      columnEnd: entry.columnEnd,
      query: '',
      options: { caseSensitive: false, wholeWord: false, useRegex: false }
    })
  }

  jumpToDiffLine = (
    paneId: PaneId,
    tabId: string,
    lineNumber: number,
    side: 'old' | 'new' = 'new'
  ): void => {
    this.lastLocationByTabId.set(tabId, { lineNumber, side })
    this.diffJumpSeq += 1
    this.activeDiffJump = {
      paneId,
      tabId,
      lineNumber,
      side,
      nonce: this.diffJumpSeq
    }
    this.syncSnapshot()
  }

  jumpToSnapshotLine = (
    paneId: PaneId,
    tabId: string,
    lineNumber: number,
    columnStart = 0,
    columnEnd = 0
  ): void => {
    this.lastLocationByTabId.set(tabId, { lineNumber })
    this.snapshotJumpSeq += 1
    this.activeSnapshotJump = {
      paneId,
      tabId,
      lineNumber,
      columnStart,
      columnEnd,
      nonce: this.snapshotJumpSeq
    }
    this.syncSnapshot()
  }

  selectOutlineSymbol = (symbol: DocumentSymbolItem): void => {
    const layout = this.tabStore.getSnapshot()
    const activePane = layout.panes[layout.activePaneId]
    const activeTab = getPaneActiveTab(activePane)
    if (!activeTab) return

    if (activeTab.kind === 'diff') {
      this.jumpToDiffLine(activePane.id, activeTab.id, symbol.lineNumber, 'new')
      return
    }

    if (activeTab.kind === 'snapshot') {
      this.jumpToSnapshotLine(
        activePane.id,
        activeTab.id,
        symbol.lineNumber,
        symbol.columnStart,
        symbol.columnEnd
      )
      return
    }

    if (activeTab.kind !== 'document') {
      return
    }

    const buffer = this.bufferStore.getBuffer(activeTab.bufferKey)
    if (!buffer || isImageDocument(buffer)) return

    const jumpSeq = ++this.searchJumpSeq
    this.activeJump = {
      paneId: activePane.id,
      tabId: activeTab.id,
      bufferKey: activeTab.bufferKey,
      mode: activeTab.mode,
      content: buffer.content,
      request: {
        paneId: activePane.id,
        tabId: activeTab.id,
        query: '',
        options: { caseSensitive: false, wholeWord: false, useRegex: false },
        lineNumber: symbol.lineNumber,
        columnStart: symbol.columnStart,
        columnEnd: symbol.columnEnd,
        nonce: jumpSeq
      }
    }
    this.syncSnapshot()
  }

  reportActiveHeading = (report: OutlineActiveHeadingReport): void => {
    this.latestSpyByPane[report.context.paneId] = {
      context: report.context,
      index: report.headingIndex
    }
    const active = this.resolveActiveOutlineContext()
    if (!isSameOutlineContext(active.context, report.context)) {
      return
    }
    if (report.isUserScroll) {
      this.pinnedOutlineHeading = null
    }
    if (
      !this.spyOutlineHeading ||
      !isSameOutlineContext(this.spyOutlineHeading.context, report.context) ||
      this.spyOutlineHeading.index !== report.headingIndex
    ) {
      this.spyOutlineHeading = { context: report.context, index: report.headingIndex }
    }
    this.syncSnapshot()
  }

  private resolveActiveOutlineContext(): {
    context: OutlineContextTarget | null
    bufferContent: string
  } {
    const layout = this.tabStore.getSnapshot()
    const activePane = layout.panes[layout.activePaneId]
    const activeTab = getPaneActiveTab(activePane)
    if (!activeTab || activeTab.kind !== 'document') {
      return { context: null, bufferContent: '' }
    }
    const activeBuffer = this.bufferStore.getBuffer(activeTab.bufferKey)
    if (!activeBuffer || !isMarkdownDocument(activeBuffer)) {
      return { context: null, bufferContent: '' }
    }
    return {
      context: { paneId: activePane.id, tabId: activeTab.id, mode: activeTab.mode },
      bufferContent: activeBuffer.content
    }
  }

  private resolveValidSpyState(
    activeContext: OutlineContextTarget | null
  ): ActiveOutlineHeadingState | null {
    if (!activeContext) return null
    if (isSpyValidForContext(this.spyOutlineHeading, activeContext)) {
      return this.spyOutlineHeading
    }
    const cached = this.latestSpyByPane[activeContext.paneId] ?? null
    return isSpyValidForContext(cached, activeContext) ? cached : null
  }

  private handleTabTransition = (transition: PaneTabTransition): void => {
    let changed = false

    // Cancel in-flight async search jump if another tab/mode transition occurs before it settles.
    if (this.inFlightJump) {
      const isMatchingTargetOpen =
        (transition.type === 'tab-opened' || transition.type === 'tab-switched') &&
        transition.tab.kind === 'document' &&
        transition.tab.bufferKey === this.inFlightJump.targetBufferKey
      if (
        !isMatchingTargetOpen &&
        (transition.type === 'tab-opened' ||
          transition.type === 'tab-switched' ||
          transition.type === 'tab-closed' ||
          transition.type === 'editor-mode-changed')
      ) {
        this.searchJumpSeq += 1
        this.inFlightJump = null
      }
    }

    if (this.activeJump) {
      if (this.shouldInvalidateTarget(this.activeJump, transition)) {
        this.activeJump = null
        changed = true
      }
    }

    if (this.activeOutlineScroll) {
      if (this.shouldInvalidateTarget(this.activeOutlineScroll, transition)) {
        this.activeOutlineScroll = null
        changed = true
      }
    }

    if (this.activeDiffJump) {
      if (
        (transition.type === 'tab-opened' || transition.type === 'tab-switched') &&
        transition.paneId === this.activeDiffJump.paneId &&
        transition.tab.id !== this.activeDiffJump.tabId
      ) {
        this.activeDiffJump = null
        changed = true
      } else if (
        transition.type === 'tab-closed' &&
        transition.paneId === this.activeDiffJump.paneId &&
        transition.closedTab.id === this.activeDiffJump.tabId
      ) {
        this.activeDiffJump = null
        changed = true
      } else if (transition.type === 'tab-moved' && transition.tab.id === this.activeDiffJump.tabId) {
        this.activeDiffJump = null
        changed = true
      }
    }

    if (this.activeSnapshotJump) {
      if (
        (transition.type === 'tab-opened' || transition.type === 'tab-switched') &&
        transition.paneId === this.activeSnapshotJump.paneId &&
        transition.tab.id !== this.activeSnapshotJump.tabId
      ) {
        this.activeSnapshotJump = null
        changed = true
      } else if (
        transition.type === 'tab-closed' &&
        transition.paneId === this.activeSnapshotJump.paneId &&
        transition.closedTab.id === this.activeSnapshotJump.tabId
      ) {
        this.activeSnapshotJump = null
        changed = true
      } else if (
        transition.type === 'tab-moved' &&
        transition.tab.id === this.activeSnapshotJump.tabId
      ) {
        this.activeSnapshotJump = null
        changed = true
      }
    }

    if (changed) {
      this.syncSnapshot()
    }
  }

  private shouldInvalidateTarget(
    target: { paneId: PaneId; tabId: string; mode: EditorMode },
    transition: PaneTabTransition
  ): boolean {
    switch (transition.type) {
      case 'tab-opened':
      case 'tab-switched':
        return transition.paneId === target.paneId
      case 'tab-closed':
        return transition.paneId === target.paneId && transition.closedTab.id === target.tabId
      case 'editor-mode-changed':
        return (
          transition.paneId === target.paneId &&
          transition.tab.id === target.tabId &&
          transition.to !== target.mode
        )
      case 'tab-moved':
        return transition.tab.id === target.tabId
      case 'tab-duplicated':
      case 'split-mode-changed':
        return false
    }
  }

  private isTargetBufferStale(target: NavigationTargetBase): boolean {
    const buf = this.bufferStore.getBuffer(target.bufferKey)
    return !buf || buf.content !== target.content
  }

  private handleBufferUpdate = (): void => {
    if (this.activeJump && this.isTargetBufferStale(this.activeJump)) {
      this.activeJump = null
    }
    if (this.activeOutlineScroll && this.isTargetBufferStale(this.activeOutlineScroll)) {
      this.activeOutlineScroll = null
    }
    this.syncSnapshot()
  }

  private handleLayoutUpdate = (): void => {
    this.syncSnapshot()
  }

  private syncSnapshot(): void {
    const active = this.resolveActiveOutlineContext()
    if (!isPinValidForContext(this.pinnedOutlineHeading, active.context, active.bufferContent)) {
      this.pinnedOutlineHeading = null
    }
    this.spyOutlineHeading = this.resolveValidSpyState(active.context)

    const nextSearchJump = this.activeJump?.request ?? null
    const nextOutlineScroll = this.activeOutlineScroll?.request ?? null
    const nextDiffJump = this.activeDiffJump
    const nextSnapshotJump = this.activeSnapshotJump
    const nextActiveHeadingIndex = this.pinnedOutlineHeading
      ? this.pinnedOutlineHeading.index
      : this.spyOutlineHeading
        ? this.spyOutlineHeading.index
        : null
    const nextPrimaryBack = this.backStackByPane.primary.length > 0
    const nextPrimaryForward = this.forwardStackByPane.primary.length > 0
    const nextSecondaryBack = this.backStackByPane.secondary.length > 0
    const nextSecondaryForward = this.forwardStackByPane.secondary.length > 0
    const prevHistory = this.cachedSnapshot.historyByPane

    if (
      this.cachedSnapshot.searchJumpRequest === nextSearchJump &&
      this.cachedSnapshot.outlineScrollRequest === nextOutlineScroll &&
      this.cachedSnapshot.diffJumpRequest === nextDiffJump &&
      this.cachedSnapshot.snapshotJumpRequest === nextSnapshotJump &&
      this.cachedSnapshot.activeHeadingIndex === nextActiveHeadingIndex &&
      prevHistory.primary.canGoBack === nextPrimaryBack &&
      prevHistory.primary.canGoForward === nextPrimaryForward &&
      prevHistory.secondary.canGoBack === nextSecondaryBack &&
      prevHistory.secondary.canGoForward === nextSecondaryForward
    ) {
      return
    }

    this.cachedSnapshot = {
      searchJumpRequest: nextSearchJump,
      outlineScrollRequest: nextOutlineScroll,
      diffJumpRequest: nextDiffJump,
      snapshotJumpRequest: nextSnapshotJump,
      activeHeadingIndex: nextActiveHeadingIndex,
      historyByPane: {
        primary: { canGoBack: nextPrimaryBack, canGoForward: nextPrimaryForward },
        secondary: { canGoBack: nextSecondaryBack, canGoForward: nextSecondaryForward }
      }
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
