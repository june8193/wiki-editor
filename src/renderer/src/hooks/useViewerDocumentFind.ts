import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { compileSearchMatcher, type CompiledSearchMatcher } from '@shared/search'
import type { DocumentFindBarProps } from '../components/DocumentFindBar'
import {
  areDocumentFindCriteriaEqual,
  clampActiveMatchIndex,
  createDefaultDocumentFindState,
  createDocumentFindActions,
  type DocumentFindCriteria,
  type DocumentFindState,
  inspectDomSingleLineSelection,
  scrollMatchElementIntoView,
  stepActiveMatchIndex
} from '../editor/documentFind'
import { isDocumentFindShortcut } from '../utils/workspaceSearch'
import type { FindHighlightSpan } from '../editor/symbolHoverDom'
import type { DocumentEditorFindControl } from './useDocumentEditorFind'

/**
 * Groups flat viewer find matches into per-line or per-cell `FindHighlightSpan[]` arrays.
 */
export function groupFindHighlightsByKey<
  TMatch extends { start: number; end: number },
  TKey
>(
  matches: readonly TMatch[],
  activeMatchIndex: number,
  getKey: (match: TMatch) => TKey
): Map<TKey, FindHighlightSpan[]> {
  const map = new Map<TKey, FindHighlightSpan[]>()
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const key = getKey(match)
    let list = map.get(key)
    if (!list) {
      list = []
      map.set(key, list)
    }
    list.push({ from: match.start, to: match.end, isActive: i === activeMatchIndex })
  }
  return map
}

export interface UseViewerDocumentFindOptions<TMatch> {
  findControl?: DocumentEditorFindControl
  isActive?: boolean
  isShortcutDisabled?: boolean
  selectionContainerRef: RefObject<HTMLElement | null>
  excludedSelectionSelector: string
  computeMatches: (matcher: CompiledSearchMatcher) => TMatch[]
  onScrollToMatch?: (match: TMatch, container: HTMLElement | null) => Element | null
}

export interface UseViewerDocumentFindResult<TMatch> {
  matches: TMatch[]
  activeMatchIndex: number
  scrollNonce: number
  findBarProps: DocumentFindBarProps | null
}

/**
 * Manages Find Bar state, match computation, active-match stepping, and standalone `Ctrl+F`
 * shortcut handling for line-based read-only viewers (`SnapshotViewer` and `GitDiffViewer`).
 */
export function useViewerDocumentFind<TMatch>({
  findControl,
  isActive = true,
  isShortcutDisabled = false,
  selectionContainerRef,
  excludedSelectionSelector,
  computeMatches,
  onScrollToMatch
}: UseViewerDocumentFindOptions<TMatch>): UseViewerDocumentFindResult<TMatch> {
  const [standaloneState, setStandaloneState] = useState<DocumentFindState>(
    createDefaultDocumentFindState
  )
  const standaloneNonceRef = useRef(0)
  const handledStandaloneNonceRef = useRef(0)

  const nextStandaloneNonce = useCallback(() => {
    standaloneNonceRef.current += 1
    return standaloneNonceRef.current
  }, [])

  const standaloneActions = useMemo(
    () => createDocumentFindActions(nextStandaloneNonce, setStandaloneState),
    [nextStandaloneNonce]
  )

  const consumeStandaloneFocusNonce = useCallback((nonce: number): boolean => {
    if (nonce === 0 || handledStandaloneNonceRef.current === nonce) {
      return false
    }
    handledStandaloneNonceRef.current = nonce
    return true
  }, [])

  const effectiveState = findControl?.state ?? standaloneState
  const effectiveActions = findControl ?? standaloneActions
  const effectiveConsumeFocusNonce = findControl?.onConsumeFocusNonce ?? consumeStandaloneFocusNonce

  const readSelection = useCallback((): string | null => {
    return inspectDomSingleLineSelection(
      selectionContainerRef.current,
      excludedSelectionSelector
    ).value
  }, [excludedSelectionSelector, selectionContainerRef])

  const readSelectionRef = useRef(readSelection)
  readSelectionRef.current = readSelection
  const onRegisterSelectionReader = findControl?.onRegisterSelectionReader

  useEffect(() => {
    if (!onRegisterSelectionReader) return
    onRegisterSelectionReader(() => readSelectionRef.current())
    return () => {
      onRegisterSelectionReader(null)
    }
  }, [onRegisterSelectionReader])

  const isStandaloneActiveRef = useRef(!findControl && isActive && !isShortcutDisabled)
  isStandaloneActiveRef.current = !findControl && isActive && !isShortcutDisabled

  useEffect(() => {
    if (findControl) return
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isStandaloneActiveRef.current) return
      if (!isDocumentFindShortcut(event)) return
      event.preventDefault()
      standaloneActions.onOpen(readSelectionRef.current())
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [findControl, standaloneActions])

  const { matches, errorMessage } = useMemo<{
    matches: TMatch[]
    errorMessage: string | null
  }>(() => {
    if (!effectiveState.isOpen || effectiveState.query.length === 0) {
      return { matches: [], errorMessage: null }
    }
    const compiled = compileSearchMatcher(effectiveState.query, effectiveState.options)
    if (!compiled.ok) {
      return { matches: [], errorMessage: compiled.error }
    }
    return {
      matches: computeMatches(compiled.matcher),
      errorMessage: null
    }
  }, [computeMatches, effectiveState.isOpen, effectiveState.options, effectiveState.query])

  const [cursor, setCursor] = useState<{
    index: number
    scrollNonce: number
    wasOpen: boolean
  }>(() => ({
    index: -1,
    scrollNonce: 0,
    wasOpen: effectiveState.isOpen
  }))

  const prevCriteriaRef = useRef<DocumentFindCriteria>({
    query: effectiveState.query,
    options: effectiveState.options
  })
  const prevWasOpenRef = useRef(effectiveState.isOpen)

  useEffect(() => {
    const nextCriteria: DocumentFindCriteria = {
      query: effectiveState.query,
      options: effectiveState.options
    }
    const activated = !prevWasOpenRef.current && effectiveState.isOpen
    const criteriaChanged =
      effectiveState.isOpen && !areDocumentFindCriteriaEqual(prevCriteriaRef.current, nextCriteria)
    prevWasOpenRef.current = effectiveState.isOpen
    prevCriteriaRef.current = nextCriteria

    if (!effectiveState.isOpen) {
      setCursor((prev) => (prev.wasOpen ? { ...prev, wasOpen: false } : prev))
      return
    }

    if (activated || criteriaChanged) {
      const nextIndex = matches.length > 0 ? 0 : -1
      setCursor((prev) => ({
        index: nextIndex,
        scrollNonce: nextIndex >= 0 ? prev.scrollNonce + 1 : prev.scrollNonce,
        wasOpen: true
      }))
      return
    }

    setCursor((prev) => {
      const clamped = clampActiveMatchIndex(prev.index, matches.length)
      if (clamped === prev.index && prev.wasOpen) return prev
      return {
        ...prev,
        index: clamped,
        wasOpen: true
      }
    })
  }, [effectiveState.isOpen, effectiveState.query, effectiveState.options, matches.length])

  const handleNextMatch = useCallback(() => {
    if (matches.length <= 0) return
    setCursor((prev) => ({
      ...prev,
      index: stepActiveMatchIndex(prev.index, matches.length, 'next'),
      scrollNonce: prev.scrollNonce + 1
    }))
  }, [matches.length])

  const handlePreviousMatch = useCallback(() => {
    if (matches.length <= 0) return
    setCursor((prev) => ({
      ...prev,
      index: stepActiveMatchIndex(prev.index, matches.length, 'prev'),
      scrollNonce: prev.scrollNonce + 1
    }))
  }, [matches.length])

  const activeMatchIndex = effectiveState.isOpen
    ? clampActiveMatchIndex(cursor.index, matches.length)
    : -1
  const lastScrolledNonceRef = useRef(0)

  useLayoutEffect(() => {
    if (cursor.scrollNonce <= 0 || cursor.scrollNonce === lastScrolledNonceRef.current) {
      return
    }
    const activeMatch = matches[activeMatchIndex]
    if (!activeMatch) {
      return
    }
    lastScrolledNonceRef.current = cursor.scrollNonce
    const container = selectionContainerRef.current
    const fallbackTarget = onScrollToMatch?.(activeMatch, container) ?? null
    const targetEl = container?.querySelector('.viewer-search-match.is-active') ?? fallbackTarget
    if (targetEl) {
      scrollMatchElementIntoView(targetEl, container)
    }
  }, [cursor.scrollNonce, matches, activeMatchIndex, selectionContainerRef, onScrollToMatch])

  const findBarProps: DocumentFindBarProps | null = effectiveState.isOpen
    ? {
        query: effectiveState.query,
        options: effectiveState.options,
        matchCount: matches.length,
        activeMatchIndex,
        errorMessage,
        focusRequest: effectiveState.focusRequest,
        onConsumeFocusNonce: effectiveConsumeFocusNonce,
        onQueryChange: effectiveActions.onChangeQuery,
        onToggleOption: effectiveActions.onToggleOption,
        onNextMatch: handleNextMatch,
        onPreviousMatch: handlePreviousMatch,
        onClose: effectiveActions.onClose
      }
    : null

  return {
    matches,
    activeMatchIndex,
    scrollNonce: cursor.scrollNonce,
    findBarProps
  }
}
