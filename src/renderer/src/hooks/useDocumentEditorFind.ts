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
import type { Editor } from '@tiptap/core'
import type { SearchMatchOptions } from '@shared/search'
import type { DocumentFindBarProps } from '../components/DocumentFindBar'
import {
  areSearchMatchOptionsEqual,
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  createDocumentFindActions,
  dispatchFindBarKeyAction,
  type DocumentFindActionHandlers,
  type DocumentFindHighlightQuery,
  type DocumentFindResultReport,
  type DocumentFindState,
  findTextMatchesInDocument,
  PREVIEW_SEARCH_CHROME_SELECTOR,
  readDomSingleLineSelection,
  readRawEditorSingleLineSelection,
  stepActiveMatchIndex
} from '../editor/documentFind'
import { findPreviewSearchMatches } from '../editor/markdownPreview'
import type { RawFindHighlightRequest } from '../editor/rawSearchHighlight'
import { readWysiwygSingleLineSelection } from '../editor/wysiwygSearchHighlight'
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
  return (
    next.isOpen &&
    (prev.query !== next.query || !areSearchMatchOptionsEqual(prev.options, next.options))
  )
}

function areCriteriaEqual(a: FindCriteriaSnapshot, b: FindCriteriaSnapshot): boolean {
  return (
    a.isOpen === b.isOpen &&
    a.query === b.query &&
    areSearchMatchOptionsEqual(a.options, b.options)
  )
}

function resolveActiveMatchIndex(params: {
  isFindActive: boolean
  isWysiwygFindPending: boolean
  criteriaActivatedOrChanged: boolean
  criteriaEqual: boolean
  hasQuery: boolean
  cursorIndex: number
  findMatchCount: number
}): number {
  if (!params.isFindActive) {
    return -1
  }
  if (params.isWysiwygFindPending) {
    if (!params.criteriaActivatedOrChanged && params.cursorIndex >= 0) {
      return params.cursorIndex
    }
    return params.hasQuery ? 0 : -1
  }
  if (!params.criteriaEqual) {
    return params.findMatchCount > 0 ? 0 : -1
  }
  return clampActiveMatchIndex(params.cursorIndex, params.findMatchCount)
}

export interface UseDocumentEditorFindOptions {
  content: string
  effectiveMode: EditorMode
  isImage: boolean
  findControl?: DocumentEditorFindControl
  rawEditorViewRef: RefObject<EditorView | null>
  wysiwygEditorRef?: RefObject<Editor | null>
  previewContainerRef?: RefObject<HTMLDivElement | null>
  splitPreviewContainerRef?: RefObject<HTMLDivElement | null>
  editorBodyRef: RefObject<HTMLDivElement | null>
}

/**
 * Coordinates controlled/uncontrolled Find Bar state, active match cursor tracking,
 * Raw/Split/위지윅/Preview search decorations, and in-editor `Ctrl+F`/`F3`/`Escape` shortcuts.
 */
export function useDocumentEditorFind({
  content,
  effectiveMode,
  isImage,
  findControl,
  rawEditorViewRef,
  wysiwygEditorRef,
  previewContainerRef,
  splitPreviewContainerRef,
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

  const modeHandlers = useMemo<
    Record<EditorMode, { focus: () => void; readSelection: () => string | null }>
  >(
    () => ({
      raw: {
        focus: () => rawEditorViewRef.current?.focus(),
        readSelection: () => readRawEditorSingleLineSelection(rawEditorViewRef.current)
      },
      split: {
        focus: () => rawEditorViewRef.current?.focus(),
        readSelection: () =>
          readRawEditorSingleLineSelection(rawEditorViewRef.current) ??
          readDomSingleLineSelection(
            splitPreviewContainerRef?.current ?? null,
            PREVIEW_SEARCH_CHROME_SELECTOR
          )
      },
      wysiwyg: {
        focus: () => {
          const editor = wysiwygEditorRef?.current
          if (editor && !editor.isDestroyed) {
            editor.view.focus()
            return
          }
          editorBodyRef.current
            ?.querySelector<HTMLElement>('[data-testid="document-editor"]')
            ?.focus()
        },
        readSelection: () => readWysiwygSingleLineSelection(wysiwygEditorRef?.current ?? null)
      },
      preview: {
        focus: () =>
          editorBodyRef.current
            ?.querySelector<HTMLElement>('[data-testid="document-editor"]')
            ?.focus(),
        readSelection: () =>
          readDomSingleLineSelection(
            previewContainerRef?.current ?? null,
            PREVIEW_SEARCH_CHROME_SELECTOR
          )
      }
    }),
    [
      editorBodyRef,
      previewContainerRef,
      rawEditorViewRef,
      splitPreviewContainerRef,
      wysiwygEditorRef
    ]
  )

  const focusActiveEditorBody = useCallback((): void => {
    modeHandlers[effectiveMode].focus()
  }, [effectiveMode, modeHandlers])

  const closeFind = useCallback((): void => {
    activeControl.onClose()
    focusActiveEditorBody()
  }, [activeControl, focusActiveEditorBody])

  const readSingleLineSelection = useCallback((): string | null => {
    if (isImage) return null
    return modeHandlers[effectiveMode].readSelection()
  }, [effectiveMode, isImage, modeHandlers])

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
  const isWysiwygFindMode = isFindActive && effectiveMode === 'wysiwyg'
  const isPreviewFindMode = isFindActive && effectiveMode === 'preview'
  const [wysiwygFindReport, setWysiwygFindReport] = useState<DocumentFindResultReport | null>(null)
  const rawFindResult = useMemo(
    () =>
      isRawFindMode
        ? findTextMatchesInDocument(content, effectiveFindState.query, effectiveFindState.options)
        : { matches: [], errorMessage: null },
    [content, effectiveFindState.options, effectiveFindState.query, isRawFindMode]
  )
  const previewFindResult = useMemo(
    () =>
      isPreviewFindMode
        ? findPreviewSearchMatches(content, effectiveFindState.query, effectiveFindState.options)
        : { matchCount: 0, errorMessage: null },
    [content, effectiveFindState.options, effectiveFindState.query, isPreviewFindMode]
  )

  const resolvedWysiwygReport =
    isWysiwygFindMode &&
    wysiwygFindReport !== null &&
    wysiwygFindReport.query === effectiveFindState.query &&
    areSearchMatchOptionsEqual(wysiwygFindReport.options, effectiveFindState.options)
      ? wysiwygFindReport
      : null
  const isWysiwygFindPending = isWysiwygFindMode && resolvedWysiwygReport === null

  const findMatches = rawFindResult.matches
  const { matchCount: findMatchCount, errorMessage: findErrorMessage } = useMemo(() => {
    if (!isFindActive) {
      return { matchCount: 0, errorMessage: null }
    }
    if (isRawFindMode) {
      return { matchCount: rawFindResult.matches.length, errorMessage: rawFindResult.errorMessage }
    }
    if (isPreviewFindMode) {
      return previewFindResult
    }
    return resolvedWysiwygReport
      ? {
          matchCount: resolvedWysiwygReport.matchCount,
          errorMessage: resolvedWysiwygReport.errorMessage
        }
      : { matchCount: 0, errorMessage: null }
  }, [
    isFindActive,
    isPreviewFindMode,
    isRawFindMode,
    previewFindResult,
    rawFindResult.errorMessage,
    rawFindResult.matches.length,
    resolvedWysiwygReport
  ])

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

  const resolvedActiveMatchIndex = resolveActiveMatchIndex({
    isFindActive,
    isWysiwygFindPending,
    criteriaActivatedOrChanged: didFindCriteriaActivateOrChange(matchCursor.criteria, currentCriteria),
    criteriaEqual: areCriteriaEqual(matchCursor.criteria, currentCriteria),
    hasQuery: effectiveFindState.query.length > 0,
    cursorIndex: matchCursor.index,
    findMatchCount
  })

  useLayoutEffect(() => {
    if (!isWysiwygFindMode && wysiwygFindReport !== null) {
      setWysiwygFindReport(null)
    }

    if (didFindCriteriaActivateOrChange(matchCursor.criteria, currentCriteria)) {
      const hasPendingOrMatches = isWysiwygFindMode
        ? currentCriteria.query.length > 0
        : findMatchCount > 0
      setMatchCursor((prev) => ({
        index: hasPendingOrMatches ? 0 : -1,
        scrollNonce: hasPendingOrMatches ? prev.scrollNonce + 1 : prev.scrollNonce,
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

    if (!isWysiwygFindPending && resolvedActiveMatchIndex !== matchCursor.index) {
      setMatchCursor((prev) => ({
        ...prev,
        index: resolvedActiveMatchIndex,
        criteria: currentCriteria
      }))
    }
  }, [
    currentCriteria,
    findMatchCount,
    isWysiwygFindMode,
    isWysiwygFindPending,
    matchCursor.criteria,
    matchCursor.index,
    resolvedActiveMatchIndex,
    wysiwygFindReport
  ])

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

  const buildRichHighlight = useCallback(
    (activeIndex: number, scrollNonce: number): DocumentFindHighlightQuery => ({
      isActive: true,
      query: effectiveFindState.query,
      options: effectiveFindState.options,
      activeIndex,
      scrollNonce
    }),
    [effectiveFindState.options, effectiveFindState.query]
  )

  const wysiwygFindHighlight = useMemo<DocumentFindHighlightQuery | null>(
    () =>
      isWysiwygFindMode
        ? buildRichHighlight(resolvedActiveMatchIndex, matchCursor.scrollNonce)
        : null,
    [buildRichHighlight, isWysiwygFindMode, matchCursor.scrollNonce, resolvedActiveMatchIndex]
  )

  const previewFindHighlight = useMemo<DocumentFindHighlightQuery | null>(() => {
    if (!isFindActive) {
      return null
    }
    if (effectiveMode === 'preview') {
      return buildRichHighlight(resolvedActiveMatchIndex, matchCursor.scrollNonce)
    }
    if (effectiveMode === 'split') {
      return buildRichHighlight(-1, 0)
    }
    return null
  }, [
    buildRichHighlight,
    effectiveMode,
    isFindActive,
    matchCursor.scrollNonce,
    resolvedActiveMatchIndex
  ])

  const handleWysiwygFindResultChange = useCallback((report: DocumentFindResultReport): void => {
    setWysiwygFindReport(report)
  }, [])

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
    wysiwygFindHighlight,
    previewFindHighlight,
    handleWysiwygFindResultChange,
    findBarProps,
    handleHeaderToggle,
    handleEditorFindKeyDown
  }
}
