import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { EditorView } from '@codemirror/view'
import type { SearchMatchOptions } from '@shared/search'
import type { DocumentFindBarProps } from '../components/DocumentFindBar'
import {
  applyCloseDocumentFind,
  applyOpenDocumentFind,
  applyQueryDocumentFind,
  applyToggleDocumentFind,
  applyToggleOptionDocumentFind,
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  dispatchFindBarKeyAction,
  type DocumentFindState,
  findTextMatchesInDocument,
  isDocumentFindShortcut,
  readRawEditorSingleLineSelection,
  stepActiveMatchIndex
} from '../editor/documentFind'
import type { RawFindHighlightRequest } from '../editor/rawSearchHighlight'
import type { EditorMode } from '../stores/PaneTabStore'

export interface DocumentEditorFindControl {
  state: DocumentFindState
  onOpen: (initialQuery?: string | null) => void
  onToggle: () => void
  onClose: () => void
  onChangeQuery: (query: string) => void
  onToggleOption: (optionKey: keyof SearchMatchOptions) => void
  onRegisterSelectionReader?: (reader: (() => string | null) | null) => void
  onConsumeFocusNonce?: (nonce: number) => boolean
}

interface FindCriteriaSnapshot {
  wasOpen: boolean
  query: string
  options: SearchMatchOptions
  mode: EditorMode
}

interface MatchCursorState {
  index: number
  scrollNonce: number
  criteria: FindCriteriaSnapshot
}

function areQueryOrOpenChanged(prev: FindCriteriaSnapshot, next: FindCriteriaSnapshot): boolean {
  if (!prev.wasOpen && next.wasOpen) {
    return true
  }
  return next.wasOpen && (prev.query !== next.query || prev.options !== next.options)
}

function areCriteriaEqual(a: FindCriteriaSnapshot, b: FindCriteriaSnapshot): boolean {
  return (
    a.wasOpen === b.wasOpen &&
    a.query === b.query &&
    a.options === b.options &&
    a.mode === b.mode
  )
}

export interface UseDocumentEditorFindOptions {
  content: string
  effectiveMode: EditorMode
  isImage: boolean
  findControl?: DocumentEditorFindControl
  rawEditorViewRef: RefObject<EditorView | null>
  editorBodyRef: RefObject<HTMLDivElement | null>
}

/**
 * Coordinates controlled/uncontrolled Find Bar state, active match cursor tracking,
 * Raw/Split search decorations, and in-editor `Ctrl+F`/`F3`/`Escape` shortcuts.
 */
export function useDocumentEditorFind({
  content,
  effectiveMode,
  isImage,
  findControl,
  rawEditorViewRef,
  editorBodyRef
}: UseDocumentEditorFindOptions) {
  const localFocusNonceRef = useRef(0)
  const [localFindState, setLocalFindState] = useState<DocumentFindState>(
    createDefaultDocumentFindState
  )
  const effectiveFindState = findControl?.state ?? localFindState

  const openFind = useCallback(
    (initialQuery?: string | null): void => {
      if (findControl) {
        findControl.onOpen(initialQuery)
        return
      }
      localFocusNonceRef.current += 1
      const nonce = localFocusNonceRef.current
      setLocalFindState((prev) => applyOpenDocumentFind(prev, nonce, initialQuery))
    },
    [findControl]
  )

  const toggleFind = useCallback((): void => {
    if (findControl) {
      findControl.onToggle()
      return
    }
    localFocusNonceRef.current += 1
    const nonce = localFocusNonceRef.current
    setLocalFindState((prev) => applyToggleDocumentFind(prev, nonce))
  }, [findControl])

  const focusActiveEditorBody = useCallback((): void => {
    if (effectiveMode === 'raw' || effectiveMode === 'split') {
      rawEditorViewRef.current?.focus()
      return
    }
    const target = editorBodyRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"]')
    target?.focus()
  }, [editorBodyRef, effectiveMode, rawEditorViewRef])

  const closeFind = useCallback((): void => {
    if (findControl) {
      findControl.onClose()
    } else {
      setLocalFindState(applyCloseDocumentFind)
    }
    focusActiveEditorBody()
  }, [findControl, focusActiveEditorBody])

  const changeFindQuery = useCallback(
    (nextQuery: string): void => {
      if (findControl) {
        findControl.onChangeQuery(nextQuery)
        return
      }
      setLocalFindState((prev) => applyQueryDocumentFind(prev, nextQuery))
    },
    [findControl]
  )

  const toggleFindOption = useCallback(
    (optionKey: keyof SearchMatchOptions): void => {
      if (findControl) {
        findControl.onToggleOption(optionKey)
        return
      }
      setLocalFindState((prev) => applyToggleOptionDocumentFind(prev, optionKey))
    },
    [findControl]
  )

  const readSingleLineSelection = useCallback((): string | null => {
    if (isImage) return null
    if (effectiveMode === 'raw' || effectiveMode === 'split') {
      return readRawEditorSingleLineSelection(rawEditorViewRef.current)
    }
    return null
  }, [effectiveMode, isImage, rawEditorViewRef])

  const registerSelectionReader = findControl?.onRegisterSelectionReader
  useEffect(() => {
    if (!registerSelectionReader) return
    registerSelectionReader(readSingleLineSelection)
    return () => {
      registerSelectionReader(null)
    }
  }, [readSingleLineSelection, registerSelectionReader])

  const isFindActive = !isImage && effectiveFindState.isOpen
  const isRawFindMode = isFindActive && (effectiveMode === 'raw' || effectiveMode === 'split')
  const rawFindResult = useMemo(
    () =>
      isRawFindMode
        ? findTextMatchesInDocument(content, effectiveFindState.query, effectiveFindState.options)
        : { matches: [], errorMessage: null },
    [content, effectiveFindState.options, effectiveFindState.query, isRawFindMode]
  )

  const findMatches = rawFindResult.matches
  const findMatchCount = findMatches.length
  const findErrorMessage = rawFindResult.errorMessage

  const currentCriteria = useMemo<FindCriteriaSnapshot>(
    () => ({
      wasOpen: isFindActive,
      query: effectiveFindState.query,
      options: effectiveFindState.options,
      mode: effectiveMode
    }),
    [effectiveFindState.options, effectiveFindState.query, effectiveMode, isFindActive]
  )

  const [matchCursor, setMatchCursor] = useState<MatchCursorState>(() => ({
    index: isFindActive && findMatchCount > 0 ? 0 : -1,
    scrollNonce: 0,
    criteria: currentCriteria
  }))

  const resolvedActiveMatchIndex = !isFindActive
    ? -1
    : !areCriteriaEqual(matchCursor.criteria, currentCriteria)
      ? findMatchCount > 0
        ? 0
        : -1
      : clampActiveMatchIndex(matchCursor.index, findMatchCount)

  useLayoutEffect(() => {
    if (areQueryOrOpenChanged(matchCursor.criteria, currentCriteria)) {
      setMatchCursor((prev) => ({
        index: findMatchCount > 0 ? 0 : -1,
        scrollNonce: findMatchCount > 0 ? prev.scrollNonce + 1 : prev.scrollNonce,
        criteria: currentCriteria
      }))
      return
    }

    if (matchCursor.criteria.wasOpen && !currentCriteria.wasOpen) {
      setMatchCursor((prev) => ({
        ...prev,
        index: -1,
        criteria: currentCriteria
      }))
      return
    }

    if (
      matchCursor.criteria.mode !== currentCriteria.mode ||
      resolvedActiveMatchIndex !== matchCursor.index
    ) {
      setMatchCursor((prev) => ({
        ...prev,
        index: resolvedActiveMatchIndex,
        criteria: currentCriteria
      }))
    }
  }, [currentCriteria, findMatchCount, matchCursor.criteria, matchCursor.index, resolvedActiveMatchIndex])

  const stepActiveMatch = useCallback(
    (direction: 'next' | 'prev'): void => {
      if (!isFindActive || findMatchCount === 0) return
      const nextIndex = stepActiveMatchIndex(resolvedActiveMatchIndex, findMatchCount, direction)
      setMatchCursor((prev) => ({
        index: nextIndex,
        scrollNonce: prev.scrollNonce + 1,
        criteria: currentCriteria
      }))
    },
    [currentCriteria, findMatchCount, isFindActive, resolvedActiveMatchIndex]
  )

  const handleNextMatch = useCallback((): void => {
    stepActiveMatch('next')
  }, [stepActiveMatch])

  const handlePreviousMatch = useCallback((): void => {
    stepActiveMatch('prev')
  }, [stepActiveMatch])

  const rawFindHighlight = useMemo<RawFindHighlightRequest | null>(
    () =>
      isRawFindMode
        ? {
            isActive: true,
            matches: findMatches,
            activeIndex: resolvedActiveMatchIndex,
            scrollNonce: matchCursor.scrollNonce
          }
        : null,
    [findMatches, isRawFindMode, matchCursor.scrollNonce, resolvedActiveMatchIndex]
  )

  const handleEditorFindKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): boolean => {
      if (isDocumentFindShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (!isImage) {
          openFind(readSingleLineSelection())
        }
        return true
      }

      if (isFindActive && !event.defaultPrevented) {
        return dispatchFindBarKeyAction(
          event,
          { allowEnter: false },
          {
            onNextMatch: handleNextMatch,
            onPreviousMatch: handlePreviousMatch,
            onClose: closeFind
          }
        )
      }

      return false
    },
    [closeFind, handleNextMatch, handlePreviousMatch, isFindActive, isImage, openFind, readSingleLineSelection]
  )

  const findBarProps: DocumentFindBarProps | null = isFindActive
    ? {
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        matchCount: findMatchCount,
        activeMatchIndex: resolvedActiveMatchIndex,
        errorMessage: findErrorMessage,
        focusRequest: effectiveFindState.focusRequest,
        onConsumeFocusNonce: findControl?.onConsumeFocusNonce,
        onQueryChange: changeFindQuery,
        onToggleOption: toggleFindOption,
        onNextMatch: handleNextMatch,
        onPreviousMatch: handlePreviousMatch,
        onClose: closeFind
      }
    : null

  return {
    isFindActive,
    rawFindHighlight,
    findBarProps,
    handleHeaderToggle: () => {
      if (!isImage) {
        toggleFind()
      }
    },
    handleEditorFindKeyDown
  }
}
