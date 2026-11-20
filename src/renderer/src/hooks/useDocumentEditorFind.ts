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
import type { TextMatchSpan } from '@shared/search'
import type { DocumentFindBarProps } from '../components/DocumentFindBar'
import {
  areDocumentFindCriteriaEqual,
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  createDocumentFindActions,
  dispatchFindBarKeyAction,
  type DocumentFindActionHandlers,
  type DocumentFindCriteria,
  type DocumentFindHighlightQuery,
  type DocumentFindResultReport,
  type DocumentFindState,
  findTextMatchesInDocument,
  inspectDomSingleLineSelection,
  readDomSingleLineSelection,
  readRawEditorSingleLineSelection,
  stepActiveMatchIndex
} from '../editor/documentFind'
import { findPreviewSearchMatches } from '../editor/markdownPreview'
import { PREVIEW_SEARCH_CHROME_SELECTOR } from '../editor/previewSearchHighlight'
import type { RawFindHighlightRequest } from '../editor/rawSearchHighlight'
import { readWysiwygSingleLineSelection } from '../editor/wysiwygSearchHighlight'
import type { EditorMode } from '../stores/PaneTabStore'
import { isDocumentFindShortcut } from '../utils/workspaceSearch'

export interface DocumentEditorFindControl extends DocumentFindActionHandlers {
  state: DocumentFindState
  onRegisterSelectionReader?: (reader: (() => string | null) | null) => void
  onConsumeFocusNonce?: (nonce: number) => boolean
}

type FindSearchSource = 'raw' | 'wysiwyg' | 'preview'

interface FindSnapshot {
  isOpen: boolean
  criteria: DocumentFindCriteria
}

interface MatchCursorState {
  index: number
  scrollNonce: number
  snapshot: FindSnapshot
}

export interface DocumentFindDomRefs {
  rawEditorViewRef: RefObject<EditorView | null>
  wysiwygEditorRef?: RefObject<Editor | null>
  previewContainerRef?: RefObject<HTMLDivElement | null>
  splitPreviewContainerRef?: RefObject<HTMLDivElement | null>
  editorBodyRef: RefObject<HTMLDivElement | null>
}

interface ModeHighlightOutputs {
  raw: RawFindHighlightRequest | null
  wysiwyg: DocumentFindHighlightQuery | null
  preview: DocumentFindHighlightQuery | null
}

interface ModeHighlightContext {
  rawMatches: readonly TextMatchSpan[]
  activeIndex: number
  scrollNonce: number
  criteria: DocumentFindCriteria
}

interface ModeFindStrategy {
  source: FindSearchSource
  focus: (dom: DocumentFindDomRefs) => void
  readSelection: (dom: DocumentFindDomRefs) => string | null
  buildHighlights: (ctx: ModeHighlightContext) => ModeHighlightOutputs
}

interface SourceMatchSummary {
  matchCount: number
  errorMessage: string | null
  rawMatches: readonly TextMatchSpan[]
  isPending: boolean
}

const EMPTY_RAW_MATCHES: readonly TextMatchSpan[] = []

const INACTIVE_MATCH_SUMMARY: SourceMatchSummary = {
  matchCount: 0,
  errorMessage: null,
  rawMatches: EMPTY_RAW_MATCHES,
  isPending: false
}

const EMPTY_HIGHLIGHT_OUTPUTS: ModeHighlightOutputs = {
  raw: null,
  wysiwyg: null,
  preview: null
}

function buildRichHighlightQuery(
  criteria: DocumentFindCriteria,
  activeIndex: number,
  scrollNonce: number
): DocumentFindHighlightQuery {
  return {
    isActive: true,
    criteria,
    activeIndex,
    scrollNonce
  }
}

function buildRawHighlightRequest(ctx: ModeHighlightContext): RawFindHighlightRequest {
  return {
    isActive: true,
    matches: ctx.rawMatches,
    activeIndex: ctx.activeIndex,
    scrollNonce: ctx.scrollNonce
  }
}

const MODE_FIND_STRATEGIES: Record<EditorMode, ModeFindStrategy> = {
  raw: {
    source: 'raw',
    focus: ({ rawEditorViewRef }) => rawEditorViewRef.current?.focus(),
    readSelection: ({ rawEditorViewRef }) =>
      readRawEditorSingleLineSelection(rawEditorViewRef.current),
    buildHighlights: (ctx) => ({
      raw: buildRawHighlightRequest(ctx),
      wysiwyg: null,
      preview: null
    })
  },
  split: {
    source: 'raw',
    focus: ({ rawEditorViewRef }) => rawEditorViewRef.current?.focus(),
    readSelection: ({ rawEditorViewRef, splitPreviewContainerRef }) => {
      const previewSelection = inspectDomSingleLineSelection(
        splitPreviewContainerRef?.current ?? null,
        PREVIEW_SEARCH_CHROME_SELECTOR
      )
      if (previewSelection.inBoundary) {
        return previewSelection.value
      }
      return readRawEditorSingleLineSelection(rawEditorViewRef.current)
    },
    buildHighlights: (ctx) => ({
      raw: buildRawHighlightRequest(ctx),
      wysiwyg: null,
      preview: buildRichHighlightQuery(ctx.criteria, -1, 0)
    })
  },
  wysiwyg: {
    source: 'wysiwyg',
    focus: ({ wysiwygEditorRef, editorBodyRef }) => {
      const editor = wysiwygEditorRef?.current
      if (editor && !editor.isDestroyed) {
        editor.view.focus()
        return
      }
      editorBodyRef.current?.querySelector<HTMLElement>('[data-testid="document-editor"]')?.focus()
    },
    readSelection: ({ wysiwygEditorRef }) =>
      readWysiwygSingleLineSelection(wysiwygEditorRef?.current ?? null),
    buildHighlights: (ctx) => ({
      raw: null,
      wysiwyg: buildRichHighlightQuery(ctx.criteria, ctx.activeIndex, ctx.scrollNonce),
      preview: null
    })
  },
  preview: {
    source: 'preview',
    focus: ({ previewContainerRef }) => previewContainerRef?.current?.focus(),
    readSelection: ({ previewContainerRef }) =>
      readDomSingleLineSelection(
        previewContainerRef?.current ?? null,
        PREVIEW_SEARCH_CHROME_SELECTOR
      ),
    buildHighlights: (ctx) => ({
      raw: null,
      wysiwyg: null,
      preview: buildRichHighlightQuery(ctx.criteria, ctx.activeIndex, ctx.scrollNonce)
    })
  }
}

function didFindSnapshotActivateOrChange(prev: FindSnapshot, next: FindSnapshot): boolean {
  if (!prev.isOpen && next.isOpen) {
    return true
  }
  return next.isOpen && !areDocumentFindCriteriaEqual(prev.criteria, next.criteria)
}

function areFindSnapshotsEqual(a: FindSnapshot, b: FindSnapshot): boolean {
  return a.isOpen === b.isOpen && areDocumentFindCriteriaEqual(a.criteria, b.criteria)
}

function resolveActiveMatchIndex(params: {
  isFindActive: boolean
  isPending: boolean
  criteriaActivatedOrChanged: boolean
  snapshotsEqual: boolean
  hasQuery: boolean
  cursorIndex: number
  matchCount: number
}): number {
  if (!params.isFindActive) {
    return -1
  }
  if (params.isPending) {
    if (!params.criteriaActivatedOrChanged && params.cursorIndex >= 0) {
      return params.cursorIndex
    }
    return params.hasQuery ? 0 : -1
  }
  if (!params.snapshotsEqual) {
    return params.matchCount > 0 ? 0 : -1
  }
  return clampActiveMatchIndex(params.cursorIndex, params.matchCount)
}

export interface UseDocumentEditorFindOptions {
  content: string
  effectiveMode: EditorMode
  isImage: boolean
  findControl?: DocumentEditorFindControl
  domRefs: DocumentFindDomRefs
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
  domRefs
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
  const modeStrategy = MODE_FIND_STRATEGIES[effectiveMode]

  const focusActiveEditorBody = useCallback((): void => {
    modeStrategy.focus(domRefs)
  }, [domRefs, modeStrategy])

  const closeFind = useCallback((): void => {
    activeControl.onClose()
    focusActiveEditorBody()
  }, [activeControl, focusActiveEditorBody])

  const readSingleLineSelection = useCallback((): string | null => {
    if (isImage) return null
    return modeStrategy.readSelection(domRefs)
  }, [domRefs, isImage, modeStrategy])

  const registerSelectionReader = findControl?.onRegisterSelectionReader
  useEffect(() => {
    if (!registerSelectionReader) return
    registerSelectionReader(readSingleLineSelection)
    return () => {
      registerSelectionReader(null)
    }
  }, [readSingleLineSelection, registerSelectionReader])

  const isFindActive = !isImage && effectiveFindState.isOpen
  const activeSource = isFindActive ? modeStrategy.source : null
  const effectiveCriteria = useMemo<DocumentFindCriteria>(
    () => ({
      query: effectiveFindState.query,
      options: effectiveFindState.options
    }),
    [effectiveFindState.options, effectiveFindState.query]
  )
  const [wysiwygFindReport, setWysiwygFindReport] = useState<DocumentFindResultReport | null>(null)
  const rawFindResult = useMemo(
    () =>
      activeSource === 'raw'
        ? findTextMatchesInDocument(content, effectiveCriteria.query, effectiveCriteria.options)
        : { matches: EMPTY_RAW_MATCHES, errorMessage: null },
    [activeSource, content, effectiveCriteria]
  )
  const previewFindResult = useMemo(
    () =>
      activeSource === 'preview'
        ? findPreviewSearchMatches(content, effectiveCriteria)
        : { matchCount: 0, errorMessage: null },
    [activeSource, content, effectiveCriteria]
  )

  const resolvedWysiwygReport =
    activeSource === 'wysiwyg' &&
    wysiwygFindReport !== null &&
    areDocumentFindCriteriaEqual(wysiwygFindReport.criteria, effectiveCriteria)
      ? wysiwygFindReport
      : null

  const matchSummary = useMemo<SourceMatchSummary>(() => {
    if (!activeSource) {
      return INACTIVE_MATCH_SUMMARY
    }
    const summariesBySource: Record<FindSearchSource, SourceMatchSummary> = {
      raw: {
        matchCount: rawFindResult.matches.length,
        errorMessage: rawFindResult.errorMessage,
        rawMatches: rawFindResult.matches,
        isPending: false
      },
      preview: {
        matchCount: previewFindResult.matchCount,
        errorMessage: previewFindResult.errorMessage,
        rawMatches: EMPTY_RAW_MATCHES,
        isPending: false
      },
      wysiwyg: resolvedWysiwygReport
        ? {
            matchCount: resolvedWysiwygReport.matchCount,
            errorMessage: resolvedWysiwygReport.errorMessage,
            rawMatches: EMPTY_RAW_MATCHES,
            isPending: false
          }
        : {
            matchCount: 0,
            errorMessage: null,
            rawMatches: EMPTY_RAW_MATCHES,
            isPending: true
          }
    }
    return summariesBySource[activeSource]
  }, [activeSource, previewFindResult, rawFindResult, resolvedWysiwygReport])

  const currentSnapshot = useMemo<FindSnapshot>(
    () => ({
      isOpen: isFindActive,
      criteria: effectiveCriteria
    }),
    [effectiveCriteria, isFindActive]
  )

  const [matchCursor, setMatchCursor] = useState<MatchCursorState>(() => ({
    index: isFindActive && matchSummary.matchCount > 0 ? 0 : -1,
    scrollNonce: 0,
    snapshot: currentSnapshot
  }))

  const resolvedActiveMatchIndex = resolveActiveMatchIndex({
    isFindActive,
    isPending: matchSummary.isPending,
    criteriaActivatedOrChanged: didFindSnapshotActivateOrChange(
      matchCursor.snapshot,
      currentSnapshot
    ),
    snapshotsEqual: areFindSnapshotsEqual(matchCursor.snapshot, currentSnapshot),
    hasQuery: effectiveCriteria.query.length > 0,
    cursorIndex: matchCursor.index,
    matchCount: matchSummary.matchCount
  })

  useLayoutEffect(() => {
    if (activeSource !== 'wysiwyg' && wysiwygFindReport !== null) {
      setWysiwygFindReport(null)
    }

    if (didFindSnapshotActivateOrChange(matchCursor.snapshot, currentSnapshot)) {
      const hasPendingOrMatches = matchSummary.isPending
        ? currentSnapshot.criteria.query.length > 0
        : matchSummary.matchCount > 0
      setMatchCursor((prev) => ({
        index: hasPendingOrMatches ? 0 : -1,
        scrollNonce: hasPendingOrMatches ? prev.scrollNonce + 1 : prev.scrollNonce,
        snapshot: currentSnapshot
      }))
      return
    }

    if (matchCursor.snapshot.isOpen && !currentSnapshot.isOpen) {
      setMatchCursor((prev) => ({
        ...prev,
        index: -1,
        snapshot: currentSnapshot
      }))
      return
    }

    if (!matchSummary.isPending && resolvedActiveMatchIndex !== matchCursor.index) {
      setMatchCursor((prev) => ({
        ...prev,
        index: resolvedActiveMatchIndex,
        snapshot: currentSnapshot
      }))
    }
  }, [
    activeSource,
    currentSnapshot,
    matchCursor.index,
    matchCursor.snapshot,
    matchSummary.isPending,
    matchSummary.matchCount,
    resolvedActiveMatchIndex,
    wysiwygFindReport
  ])

  const stepActiveMatch = useCallback(
    (direction: 'next' | 'prev'): void => {
      if (!isFindActive || matchSummary.matchCount === 0) return
      const nextIndex = stepActiveMatchIndex(
        resolvedActiveMatchIndex,
        matchSummary.matchCount,
        direction
      )
      setMatchCursor((prev) => ({
        index: nextIndex,
        scrollNonce: prev.scrollNonce + 1,
        snapshot: currentSnapshot
      }))
    },
    [currentSnapshot, isFindActive, matchSummary.matchCount, resolvedActiveMatchIndex]
  )

  const handleNextMatch = useCallback((): void => {
    stepActiveMatch('next')
  }, [stepActiveMatch])

  const handlePreviousMatch = useCallback((): void => {
    stepActiveMatch('prev')
  }, [stepActiveMatch])

  const findHighlights = useMemo<ModeHighlightOutputs>(
    () =>
      isFindActive
        ? modeStrategy.buildHighlights({
            rawMatches: matchSummary.rawMatches,
            activeIndex: resolvedActiveMatchIndex,
            scrollNonce: matchCursor.scrollNonce,
            criteria: effectiveCriteria
          })
        : EMPTY_HIGHLIGHT_OUTPUTS,
    [
      effectiveCriteria,
      isFindActive,
      matchCursor.scrollNonce,
      matchSummary.rawMatches,
      modeStrategy,
      resolvedActiveMatchIndex
    ]
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
        matchCount: matchSummary.matchCount,
        activeMatchIndex: resolvedActiveMatchIndex,
        errorMessage: matchSummary.errorMessage,
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
    rawFindHighlight: findHighlights.raw,
    wysiwygFindHighlight: findHighlights.wysiwyg,
    previewFindHighlight: findHighlights.preview,
    handleWysiwygFindResultChange: setWysiwygFindReport,
    findBarProps,
    handleHeaderToggle,
    handleEditorFindKeyDown
  }
}
