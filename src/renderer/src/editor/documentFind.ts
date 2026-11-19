import type { EditorView } from '@codemirror/view'
import {
  compileSearchMatcher,
  DEFAULT_SEARCH_MATCH_OPTIONS,
  type SearchMatchOptions,
  type TextMatchSpan
} from '@shared/search'
import type { KeyboardEventLike, SearchFocusRequest } from '../utils/workspaceSearch'

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

export interface DocumentFindKeyboardEvent extends KeyboardEventLike {
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface FindBarKeyHandlers {
  onNextMatch: () => void
  onPreviousMatch: () => void
  onClose: () => void
}

function isEventComposing(event: DocumentFindKeyboardEvent): boolean {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)
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
  return state.isOpen
    ? { ...state, isOpen: false }
    : { ...state, isOpen: true, focusRequest: { nonce: focusNonce, selectAll: true } }
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
 * Normalizes CRLF and CR line endings to LF so text match offsets align with CodeMirror 6 docs.
 */
export function normalizeRawDocText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
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
    matches: compiled.matcher.findMatches(normalizeRawDocText(content)),
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
 * Reads the current single-line selection from a mounted CodeMirror 6 EditorView, or `null` if none/multi-line.
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

/**
 * Returns true when a keyboard event matches the in-document find shortcut (`Ctrl+F` / `Cmd+F` without Shift/Alt).
 */
export function isDocumentFindShortcut(event: DocumentFindKeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !isEventComposing(event) &&
    event.key.toLowerCase() === 'f'
  )
}

/**
 * Resolves Find Bar navigation/close shortcuts (`Enter`, `Shift+Enter`, `F3`, `Shift+F3`, `Escape`).
 */
export function resolveFindBarKeyAction(
  event: DocumentFindKeyboardEvent,
  options: { allowEnter?: boolean } = {}
): FindBarKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isEventComposing(event)) {
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
