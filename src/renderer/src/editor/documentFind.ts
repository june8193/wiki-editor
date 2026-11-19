import type { EditorView } from '@codemirror/view'
import {
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type SearchMatchOptions,
  type TextMatchSpan
} from '@shared/search'
import {
  isKeyboardEventComposing,
  type KeyboardEventLike,
  type SearchFocusRequest
} from '../utils/workspaceSearch'
import { normalizeLineEndingsToLf } from './MarkdownTocEngine'

export interface DocumentFindState {
  isOpen: boolean
  query: string
  options: SearchMatchOptions
  focusRequest: SearchFocusRequest | null
}

export type FindBarKeyAction = 'next' | 'prev' | 'close'

export interface DocumentFindMatchResult {
  matches: TextMatchSpan[]
  errorMessage: string | null
}

export interface DocumentFindCriteria {
  query: string
  options: SearchMatchOptions
}

export interface DocumentFindHighlightQuery {
  isActive: boolean
  criteria: DocumentFindCriteria
  activeIndex: number
  scrollNonce: number
}

export interface DocumentFindResultReport {
  criteria: DocumentFindCriteria
  matchCount: number
  errorMessage: string | null
}

function areSearchMatchOptionsEqual(a: SearchMatchOptions, b: SearchMatchOptions): boolean {
  return (
    a.caseSensitive === b.caseSensitive &&
    a.wholeWord === b.wholeWord &&
    a.useRegex === b.useRegex
  )
}

/**
 * Returns true when two `DocumentFindCriteria` objects share identical query text and flags.
 */
export function areDocumentFindCriteriaEqual(
  a: DocumentFindCriteria,
  b: DocumentFindCriteria
): boolean {
  return a.query === b.query && areSearchMatchOptionsEqual(a.options, b.options)
}

/**
 * Returns true when two `DocumentFindResultReport` payloads represent the same criteria, match count, and error.
 */
export function areDocumentFindResultReportsEqual(
  a: DocumentFindResultReport | null,
  b: DocumentFindResultReport | null
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return (
    a.matchCount === b.matchCount &&
    a.errorMessage === b.errorMessage &&
    areDocumentFindCriteriaEqual(a.criteria, b.criteria)
  )
}

/**
 * Consumes a positive, unseen `scrollNonce` when either scrolling is skipped (`skipScroll`)
 * or `performScroll` locates and scrolls a target element.
 */
export function applyFindScrollNonce(
  lastHandledNonceRef: { current: number },
  scrollNonce: number,
  options: {
    skipScroll: boolean
    performScroll: () => boolean
  }
): void {
  if (scrollNonce <= 0 || scrollNonce === lastHandledNonceRef.current) {
    return
  }
  if (options.skipScroll || options.performScroll()) {
    lastHandledNonceRef.current = scrollNonce
  }
}

/**
 * Scrolls a matched DOM element into the center of its scroll container, falling back to
 * `scrollTop` math when `scrollIntoView` is unavailable in test DOM environments.
 */
export function scrollMatchElementIntoView(
  target: Element | null,
  scrollContainer?: HTMLElement | null
): void {
  if (!target) {
    return
  }
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center' })
    return
  }
  if (!scrollContainer || scrollContainer.scrollHeight <= scrollContainer.clientHeight) {
    return
  }
  const containerRect = scrollContainer.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  if (containerRect.height <= 0 && targetRect.height <= 0) {
    return
  }
  const targetCenter =
    targetRect.top - containerRect.top + scrollContainer.scrollTop + targetRect.height / 2
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
  scrollContainer.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, targetCenter - scrollContainer.clientHeight / 2)
  )
}

export interface DocumentFindKeyboardEvent extends KeyboardEventLike {
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface FindBarKeyHandlers {
  onNextMatch: () => void
  onPreviousMatch: () => void
  onClose: () => void
}

export interface DocumentFindActionHandlers {
  onOpen: (initialQuery?: string | null) => void
  onToggle: () => void
  onClose: () => void
  onChangeQuery: (query: string) => void
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
}

/**
 * Creates a fresh default find bar state for an editor pane or standalone document editor.
 */
export function createDefaultDocumentFindState(): DocumentFindState {
  return {
    isOpen: false,
    query: '',
    options: { ...DEFAULT_SEARCH_MATCH_OPTIONS },
    focusRequest: null
  }
}

/**
 * Applies an open-find transition, optionally replacing the query from a single-line selection.
 */
export function applyOpenDocumentFind(
  state: DocumentFindState,
  focusNonce: number,
  initialQuery?: string | null
): DocumentFindState {
  return {
    ...state,
    isOpen: true,
    query: initialQuery !== null && initialQuery !== undefined ? initialQuery : state.query,
    focusRequest: { nonce: focusNonce, selectAll: true }
  }
}

/**
 * Toggles Find Bar open state while assigning a focus-and-select request when opening.
 */
export function applyToggleDocumentFind(
  state: DocumentFindState,
  focusNonce: number
): DocumentFindState {
  return state.isOpen ? applyCloseDocumentFind(state) : applyOpenDocumentFind(state, focusNonce)
}

/**
 * Closes the Find Bar while preserving the current query and match options.
 */
export function applyCloseDocumentFind(state: DocumentFindState): DocumentFindState {
  if (!state.isOpen) return state
  return { ...state, isOpen: false }
}

/**
 * Updates the active find query when it differs from the current query.
 */
export function applyQueryDocumentFind(
  state: DocumentFindState,
  nextQuery: string
): DocumentFindState {
  if (state.query === nextQuery) return state
  return { ...state, query: nextQuery }
}

/**
 * Toggles a single find match option flag (`caseSensitive`, `wholeWord`, or `useRegex`).
 */
export function applyToggleOptionDocumentFind(
  state: DocumentFindState,
  optionKey: keyof SearchMatchOptions
): DocumentFindState {
  return {
    ...state,
    options: {
      ...state.options,
      [optionKey]: !state.options[optionKey]
    }
  }
}

/**
 * Binds standard Find Bar state actions (`onOpen`, `onToggle`, `onClose`, `onChangeQuery`, `onToggleOption`)
 * onto a caller-supplied focus nonce generator and state updater.
 */
export function createDocumentFindActions(
  nextFocusNonce: () => number,
  updateState: (updater: (current: DocumentFindState) => DocumentFindState) => void
): DocumentFindActionHandlers {
  return {
    onOpen: (initialQuery) => {
      const nonce = nextFocusNonce()
      updateState((current) => applyOpenDocumentFind(current, nonce, initialQuery))
    },
    onToggle: () => {
      const nonce = nextFocusNonce()
      updateState((current) => applyToggleDocumentFind(current, nonce))
    },
    onClose: () => updateState(applyCloseDocumentFind),
    onChangeQuery: (nextQuery) =>
      updateState((current) => applyQueryDocumentFind(current, nextQuery)),
    onToggleOption: (optionKey) =>
      updateState((current) => applyToggleOptionDocumentFind(current, optionKey))
  }
}

/**
 * Finds all text matches in a document using the shared search matching engine,
 * returning structured regex syntax errors instead of throwing.
 */
export function findTextMatchesInDocument(
  content: string,
  query: string,
  options: SearchMatchOptions
): DocumentFindMatchResult {
  if (query.length === 0) {
    return { matches: [], errorMessage: null }
  }
  const compiled = compileSearchMatcher(query, options)
  if (!compiled.ok) {
    return { matches: [], errorMessage: compiled.error }
  }
  return {
    matches: compiled.matcher.findMatches(normalizeLineEndingsToLf(content)),
    errorMessage: null
  }
}

/**
 * Clamps an active match index to `[0, matchCount - 1]` or `-1` when no matches exist.
 */
export function clampActiveMatchIndex(currentIndex: number, matchCount: number): number {
  if (matchCount <= 0) {
    return -1
  }
  if (currentIndex < 0) {
    return 0
  }
  return Math.min(currentIndex, matchCount - 1)
}

/**
 * Steps the active match index cyclically forward or backward across `matchCount` matches.
 */
export function stepActiveMatchIndex(
  currentIndex: number,
  matchCount: number,
  direction: 'next' | 'prev'
): number {
  if (matchCount <= 0) {
    return -1
  }
  if (direction === 'next') {
    return currentIndex < 0 ? 0 : (currentIndex + 1) % matchCount
  }
  return currentIndex <= 0 ? matchCount - 1 : currentIndex - 1
}

/**
 * Extracts a usable single-line find query from a selection string, returning `null` for empty or multi-line text.
 */
export function extractSingleLineFindQuery(selectedText: string | null | undefined): string | null {
  if (!selectedText || selectedText.length === 0 || /[\r\n]/.test(selectedText)) {
    return null
  }
  return selectedText
}

/**
 * Reads a single-line non-empty selection from a CodeMirror 6 EditorView, or `null` if none/multi-line.
 */
export function readRawEditorSingleLineSelection(view: EditorView | null): string | null {
  if (!view) {
    return null
  }
  const { from, to, empty } = view.state.selection.main
  if (empty) {
    return null
  }
  return extractSingleLineFindQuery(view.state.doc.sliceString(from, to))
}

const SINGLE_LINE_BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, dt, dd, summary'

export const PREVIEW_SEARCH_CHROME_SELECTOR =
  '.code-block-header, .mermaid-diagram-block, .markdown-preview-empty'

export interface DomSingleLineSelectionInspection {
  inBoundary: boolean
  value: string | null
}

/**
 * Inspects the active browser DOM selection relative to `container` and `guardBoundary`,
 * distinguishing whether the selection touches `guardBoundary` (`inBoundary`) from chrome-blocked or non-single-line values.
 */
export function inspectDomSingleLineSelection(
  container: Element | null,
  excludedSelector: string = PREVIEW_SEARCH_CHROME_SELECTOR,
  guardBoundary: Element | null = container
): DomSingleLineSelectionInspection {
  if (!container || typeof window === 'undefined') {
    return { inBoundary: false, value: null }
  }
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return { inBoundary: false, value: null }
  }
  const range = selection.getRangeAt(0)
  const boundary = guardBoundary ?? container
  if (!boundary.contains(range.startContainer) && !boundary.contains(range.endContainer)) {
    return { inBoundary: false, value: null }
  }

  const startEl =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  const endEl =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (
    startEl?.closest(excludedSelector) ||
    endEl?.closest(excludedSelector) ||
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return { inBoundary: true, value: null }
  }

  const startBlock = startEl?.closest(SINGLE_LINE_BLOCK_SELECTOR) ?? null
  const endBlock = endEl?.closest(SINGLE_LINE_BLOCK_SELECTOR) ?? null
  if (startBlock !== endBlock) {
    return { inBoundary: true, value: null }
  }

  const fragment = range.cloneContents()
  if (fragment.querySelector('br')) {
    return { inBoundary: true, value: null }
  }
  if (!startBlock && fragment.querySelector(SINGLE_LINE_BLOCK_SELECTOR)) {
    return { inBoundary: true, value: null }
  }

  return { inBoundary: true, value: extractSingleLineFindQuery(range.toString()) }
}

/**
 * Reads a single-line DOM selection contained within `container`, excluding UI chrome and cross-block ranges.
 */
export function readDomSingleLineSelection(
  container: HTMLElement | null,
  excludedSelector: string = PREVIEW_SEARCH_CHROME_SELECTOR
): string | null {
  return inspectDomSingleLineSelection(container, excludedSelector).value
}

/**
 * Resolves Find Bar navigation/close shortcuts (`Enter`, `Shift+Enter`, `F3`, `Shift+F3`, `Escape`).
 */
export function resolveFindBarKeyAction(
  event: DocumentFindKeyboardEvent,
  options: { allowEnter?: boolean } = {}
): FindBarKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isKeyboardEventComposing(event)) {
    return null
  }
  if (event.key === 'Escape') {
    return 'close'
  }
  if (event.key === 'F3') {
    return event.shiftKey ? 'prev' : 'next'
  }
  if (options.allowEnter && event.key === 'Enter') {
    return event.shiftKey ? 'prev' : 'next'
  }
  return null
}

/**
 * Resolves a Find Bar key action from a DOM or React keyboard event and dispatches
 * the matching handler while suppressing default browser handling when handled.
 */
export function dispatchFindBarKeyAction(
  event: DocumentFindKeyboardEvent,
  options: { allowEnter?: boolean },
  handlers: FindBarKeyHandlers
): boolean {
  const action = resolveFindBarKeyAction(event, options)
  if (!action) {
    return false
  }
  event.preventDefault?.()
  event.stopPropagation?.()
  if (action === 'next') {
    handlers.onNextMatch()
  } else if (action === 'prev') {
    handlers.onPreviousMatch()
  } else {
    handlers.onClose()
  }
  return true
}
