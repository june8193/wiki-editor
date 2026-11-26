import type { DocumentBufferStore } from '@shared/documentBufferStore'
import type {
  DocumentJumpHighlightTarget,
  DocumentSearchJumpRequest,
  SearchMatchOptions,
  WorkspaceSearchFileResult,
  WorkspaceSearchLineMatch
} from '@shared/search'
import type { DocumentSymbolItem } from '@shared/symbol'
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

export interface PaneNavigationSnapshot {
  searchJumpRequest: DocumentSearchJumpRequest | null
  outlineScrollRequest: OutlineScrollRequest | null
  diffJumpRequest: PaneDiffJumpRequest | null
  activeHeadingIndex: number | null
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
  private spyOutlineHeading: ActiveOutlineHeadingState | null = null
  private pinnedOutlineHeading: PinnedOutlineHeadingState | null = null
  private latestSpyByPane: Partial<Record<PaneId, ActiveOutlineHeadingState>> = {}

  private cachedSnapshot: PaneNavigationSnapshot

  constructor(options: PaneNavigationCoordinatorOptions) {
    this.tabStore = options.tabStore
    this.bufferStore = options.bufferStore
    this.openWorkspaceFileFn = options.openWorkspaceFile

    this.cachedSnapshot = {
      searchJumpRequest: null,
      outlineScrollRequest: null,
      diffJumpRequest: null,
      activeHeadingIndex: null
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
    this.spyOutlineHeading = null
    this.pinnedOutlineHeading = null
    this.latestSpyByPane = {}
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
    explicitName,
    lineNumber,
    columnStart,
    columnEnd,
    query,
    options
  }: {
    filePath: string
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

    const opened = await this.openWorkspaceFileFn(filePath, undefined, explicitName, isCancelled)
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

  selectOutlineSymbol = (symbol: DocumentSymbolItem): void => {
    const layout = this.tabStore.getSnapshot()
    const activePane = layout.panes[layout.activePaneId]
    const activeTab = getPaneActiveTab(activePane)
    if (!activeTab) return

    if (activeTab.kind === 'diff') {
      this.diffJumpSeq += 1
      this.activeDiffJump = {
        paneId: activePane.id,
        tabId: activeTab.id,
        lineNumber: symbol.lineNumber,
        side: 'new',
        nonce: this.diffJumpSeq
      }
      this.syncSnapshot()
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
        transition.paneId === this.activeDiffJump.paneId
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
    const nextActiveHeadingIndex = this.pinnedOutlineHeading
      ? this.pinnedOutlineHeading.index
      : this.spyOutlineHeading
        ? this.spyOutlineHeading.index
        : null

    if (
      this.cachedSnapshot.searchJumpRequest === nextSearchJump &&
      this.cachedSnapshot.outlineScrollRequest === nextOutlineScroll &&
      this.cachedSnapshot.diffJumpRequest === nextDiffJump &&
      this.cachedSnapshot.activeHeadingIndex === nextActiveHeadingIndex
    ) {
      return
    }

    this.cachedSnapshot = {
      searchJumpRequest: nextSearchJump,
      outlineScrollRequest: nextOutlineScroll,
      diffJumpRequest: nextDiffJump,
      activeHeadingIndex: nextActiveHeadingIndex
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}
