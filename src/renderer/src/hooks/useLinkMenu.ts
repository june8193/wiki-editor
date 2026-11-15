import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildHeadingLinkCandidates,
  filterAndRankLinkCandidates,
  type LinkCandidate,
  type LinkQueryMatch
} from '../editor/LinkAutocompleteEngine'
import {
  computeSlashMenuPosition,
  readSafeCaretCoords,
  type CaretRectCoords,
  type CoordsProvider,
  type SlashMenuPosition
} from './useSlashMenu'

export type LinkMenuPosition = SlashMenuPosition

export interface LinkMenuState<TMatch extends LinkQueryMatch = LinkQueryMatch> {
  isOpen: boolean
  candidates: LinkCandidate[]
  selectedIndex: number
  match: TMatch | null
  position: LinkMenuPosition
}

export interface LinkMenuControls<TMatch extends LinkQueryMatch = LinkQueryMatch> {
  stateRef: React.MutableRefObject<LinkMenuState<TMatch>>
  updateFromMatch: (
    match: TMatch | null,
    coords: CaretRectCoords | null,
    shellEl: HTMLElement | null,
    overrideContent?: string
  ) => void
  syncOpenSelection: (
    match: TMatch | null,
    coordsProvider: CoordsProvider,
    shellEl: HTMLElement | null,
    overrideContent?: string
  ) => void
  moveSelection: (delta: -1 | 1) => boolean
  applySelected: () => boolean
  dismiss: () => boolean
}

export interface UseLinkMenuOptions<TMatch extends LinkQueryMatch = LinkQueryMatch> {
  documentContent: string
  onSelectCandidate: (candidate: LinkCandidate, match: TMatch) => void
  onOpenMenu?: () => void
}

/** Manages link autocomplete popup state, ranking, keyboard selection, and dismissal. */
export function useLinkMenu<TMatch extends LinkQueryMatch = LinkQueryMatch>({
  documentContent,
  onSelectCandidate,
  onOpenMenu
}: UseLinkMenuOptions<TMatch>) {
  const initialState: LinkMenuState<TMatch> = {
    isOpen: false,
    candidates: [],
    selectedIndex: 0,
    match: null,
    position: { top: 0, left: 0 }
  }
  const [state, setState] = useState<LinkMenuState<TMatch>>(initialState)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<LinkMenuState<TMatch>>(state)
  const documentContentRef = useRef(documentContent)
  const onSelectCandidateRef = useRef(onSelectCandidate)
  const onOpenMenuRef = useRef(onOpenMenu)

  stateRef.current = state
  documentContentRef.current = documentContent
  onSelectCandidateRef.current = onSelectCandidate
  onOpenMenuRef.current = onOpenMenu

  const dismiss = useCallback((): boolean => {
    const wasOpen = stateRef.current.isOpen
    if (!wasOpen) {
      return false
    }
    const closedState: LinkMenuState<TMatch> = {
      isOpen: false,
      candidates: [],
      selectedIndex: 0,
      match: null,
      position: { top: 0, left: 0 }
    }
    stateRef.current = closedState
    setState(closedState)
    return true
  }, [])

  const updateFromMatch = useCallback(
    (
      match: TMatch | null,
      coords: CaretRectCoords | null,
      shellEl: HTMLElement | null,
      overrideContent?: string
    ) => {
      if (!match) {
        dismiss()
        return
      }

      const content = overrideContent ?? documentContentRef.current
      const allCandidates = buildHeadingLinkCandidates(content)
      const candidates = filterAndRankLinkCandidates(allCandidates, match.label, match.query)
      const prev = stateRef.current
      const wasOpen = prev.isOpen
      const prevSelectedId = wasOpen ? prev.candidates[prev.selectedIndex]?.id : undefined
      let nextIndex = 0
      if (prevSelectedId) {
        const preservedIndex = candidates.findIndex((item) => item.id === prevSelectedId)
        if (preservedIndex >= 0) {
          nextIndex = preservedIndex
        }
      }
      const position =
        coords !== null || !wasOpen ? computeSlashMenuPosition(shellEl, coords) : prev.position

      const nextState: LinkMenuState<TMatch> = {
        isOpen: true,
        candidates,
        selectedIndex: nextIndex,
        match,
        position
      }
      stateRef.current = nextState
      setState(nextState)

      if (!wasOpen) {
        onOpenMenuRef.current?.()
      }
    },
    [dismiss]
  )

  const moveSelection = useCallback((delta: -1 | 1): boolean => {
    const current = stateRef.current
    if (!current.isOpen || current.candidates.length === 0) {
      return false
    }
    const len = current.candidates.length
    const nextIndex = (current.selectedIndex + delta + len) % len
    const nextState: LinkMenuState<TMatch> = { ...current, selectedIndex: nextIndex }
    stateRef.current = nextState
    setState(nextState)
    return true
  }, [])

  const selectCandidate = useCallback(
    (candidate: LinkCandidate) => {
      const match = stateRef.current.match
      if (!match) {
        dismiss()
        return
      }
      dismiss()
      onSelectCandidateRef.current(candidate, match)
    },
    [dismiss]
  )

  const applySelected = useCallback((): boolean => {
    const current = stateRef.current
    if (!current.isOpen || !current.match) {
      return false
    }
    const selected = current.candidates[current.selectedIndex]
    if (!selected) {
      dismiss()
      return false
    }
    selectCandidate(selected)
    return true
  }, [dismiss, selectCandidate])

  const syncOpenSelection = useCallback(
    (
      match: TMatch | null,
      coordsProvider: CoordsProvider,
      shellEl: HTMLElement | null,
      overrideContent?: string
    ) => {
      const current = stateRef.current
      if (!current.isOpen || !current.match) {
        return
      }
      if (!match || match.rangeFrom !== current.match.rangeFrom) {
        dismiss()
        return
      }
      const coords = readSafeCaretCoords(coordsProvider, match.rangeFrom)
      updateFromMatch(match, coords, shellEl, overrideContent)
    },
    [dismiss, updateFromMatch]
  )

  const controlsRef = useRef<LinkMenuControls<TMatch>>({
    stateRef,
    updateFromMatch,
    syncOpenSelection,
    moveSelection,
    applySelected,
    dismiss
  })

  useEffect(() => {
    controlsRef.current = {
      stateRef,
      updateFromMatch,
      syncOpenSelection,
      moveSelection,
      applySelected,
      dismiss
    }
  }, [updateFromMatch, syncOpenSelection, moveSelection, applySelected, dismiss])

  return {
    linkControlsRef: controlsRef,
    linkMenuProps: {
      isOpen: state.isOpen,
      candidates: state.candidates,
      selectedIndex: state.selectedIndex,
      position: state.position,
      menuRef,
      onSelect: selectCandidate,
      onDismiss: dismiss
    }
  }
}
