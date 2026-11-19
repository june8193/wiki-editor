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
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  createDocumentFindActions,
  dispatchFindBarKeyAction,
  type DocumentFindActionHandlers,
  type DocumentFindState,
  findTextMatchesInDocument,
  readRawEditorSingleLineSelection,
  stepActiveMatchIndex
} from '../editor/documentFind'
import type { RawFindHighlightRequest } from '../editor/rawSearchHighlight'
import type { EditorMode } from '../stores/PaneTabStore'
import { isDocumentFindShortcut } from '../utils/workspaceSearch'

export interface DocumentEditorFindControl extends DocumentFindActionHandlers {
  state: DocumentFindState
  onRegisterSelectionReader?: (reader: (() => string | null) | null) => void
  onConsumeFocusNonce?: (nonce: number) => boolean
}

interface FindCriteriaSnapshot {
  isOpen: boolean
  query: string
  options: SearchMatchOptions
}

interface MatchCursorState {
  index: number
  scrollNonce: number
  criteria: FindCriteriaSnapshot
}

function didFindCriteriaActivateOrChange(
  prev: FindCriteriaSnapshot,
  next: FindCriteriaSnapshot
): boolean {
  if (!prev.isOpen && next.isOpen) {
    return true
  }
  return next.isOpen && (prev.query !== next.query || prev.options !== next.options)
}

function areCriteriaEqual(a: FindCriteriaSnapshot, b: FindCriteriaSnapshot): boolean {
  return a.isOpen === b.isOpen && a.query === b.query && a.options === b.options
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
  const fallbackActions = useMemo(
    () =>
      createDocumentFindActions(() => {
        localFocusNonceRef.current += 1
        return localFocusNonceRef.current
      }, setLocalFindState),
    []
  )
  const fallbackControl = useMemo<DocumentEditorFindControl>(
    () => ({ state: localFindState, ...fallbackActions }),
    [fallbackActions, localFindState]
  )
  const activeControl = findControl ?? fallbackControl
  const effectiveFindState = activeControl.state
  const isRawBasedMode = effectiveMode === 'raw' || effectiveMode === 'split'

  const focusActiveEditorBody = useCallback((): void => {
    if (isRawBasedMode) {
      rawEditorViewRef.current?.focus()
      return
    }
    const target = editorBodyRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"]')
    target?.focus()
  }, [editorBodyRef, isRawBasedMode, rawEditorViewRef])

  const closeFind = useCallback((): void => {
    activeControl.onClose()
    focusActiveEditorBody()
  }, [activeControl, focusActiveEditorBody])

  const readSingleLineSelection = useCallback((): string | null => {
    if (isImage) return null
    if (isRawBasedMode) {
      return readRawEditorSingleLineSelection(rawEditorViewRef.current)
    }
    return null
  }, [isImage, isRawBasedMode, rawEditorViewRef])

  const registerSelectionReader = findControl?.onRegisterSelectionReader
  useEffect(() => {
    if (!registerSelectionReader) return
    registerSelectionReader(readSingleLineSelection)
    return () => {
      registerSelectionReader(null)
    }
  }, [readSingleLineSelection, registerSelectionReader])

  const isFindActive = !isImage && effectiveFindState.isOpen
  const isRawFindMode = isFindActive && isRawBasedMode
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
      isOpen: isFindActive,
      query: effectiveFindState.query,
      options: effectiveFindState.options
    }),
    [effectiveFindState.options, effectiveFindState.query, isFindActive]
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
    if (didFindCriteriaActivateOrChange(matchCursor.criteria, currentCriteria)) {
      setMatchCursor((prev) => ({
        index: findMatchCount > 0 ? 0 : -1,
        scrollNonce: findMatchCount > 0 ? prev.scrollNonce + 1 : prev.scrollNonce,
        criteria: currentCriteria
      }))
      return
    }

    if (matchCursor.criteria.isOpen && !currentCriteria.isOpen) {
      setMatchCursor((prev) => ({
        ...prev,
        index: -1,
        criteria: currentCriteria
      }))
      return
    }

    if (resolvedActiveMatchIndex !== matchCursor.index) {
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
          const isFromFindBar =
            event.target instanceof Element && event.target.closest('.document-find-bar') !== null
          activeControl.onOpen(isFromFindBar ? null : readSingleLineSelection())
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
    [
      activeControl,
      closeFind,
      handleNextMatch,
      handlePreviousMatch,
      isFindActive,
      isImage,
      readSingleLineSelection
    ]
  )

  const handleHeaderToggle = useCallback((): void => {
    if (!isImage) {
      activeControl.onToggle()
    }
  }, [activeControl, isImage])

  const findBarProps: DocumentFindBarProps | null = isFindActive
    ? {
        query: effectiveFindState.query,
        options: effectiveFindState.options,
        matchCount: findMatchCount,
        activeMatchIndex: resolvedActiveMatchIndex,
        errorMessage: findErrorMessage,
        focusRequest: effectiveFindState.focusRequest,
        onConsumeFocusNonce: activeControl.onConsumeFocusNonce,
        onQueryChange: activeControl.onChangeQuery,
        onToggleOption: activeControl.onToggleOption,
        onNextMatch: handleNextMatch,
        onPreviousMatch: handlePreviousMatch,
        onClose: closeFind
      }
    : null

  return {
    isFindActive,
    rawFindHighlight,
    findBarProps,
    handleHeaderToggle,
    handleEditorFindKeyDown
  }
}
