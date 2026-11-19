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
export function isDocumentFindShortcut(event: KeyboardEventLike): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.isComposing &&
    event.key.toLowerCase() === 'f'
  )
}

/**
 * Resolves Find Bar navigation/close shortcuts (`Enter`, `Shift+Enter`, `F3`, `Shift+F3`, `Escape`).
 */
export function resolveFindBarKeyAction(
  event: KeyboardEventLike,
  options: { allowEnter?: boolean } = {}
): FindBarKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
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
