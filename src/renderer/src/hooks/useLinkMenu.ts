import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildHeadingLinkCandidates,
  filterAndRankLinkCandidates,
  type HeadingLinkCandidate,
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
  candidates: HeadingLinkCandidate[]
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
  syncDocMatch: (
    match: TMatch | null,
    coordsProvider: CoordsProvider,
    shellEl: HTMLElement | null,
    overrideContent?: string
  ) => boolean
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
  onSelectCandidate: (candidate: HeadingLinkCandidate, match: TMatch) => void
  onOpenMenu?: () => void
}

const CLOSED_LINK_MENU_STATE: LinkMenuState<never> = {
  isOpen: false,
  candidates: [],
  selectedIndex: 0,
  match: null,
  position: { top: 0, left: 0 }
}

/** Manages link autocomplete popup state, ranking, keyboard/hover selection, and dismissal. */
export function useLinkMenu<TMatch extends LinkQueryMatch = LinkQueryMatch>({
  documentContent,
  onSelectCandidate,
  onOpenMenu
}: UseLinkMenuOptions<TMatch>) {
  const [state, setState] = useState<LinkMenuState<TMatch>>(CLOSED_LINK_MENU_STATE)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<LinkMenuState<TMatch>>(state)
  const documentContentRef = useRef(documentContent)
  const onSelectCandidateRef = useRef(onSelectCandidate)
  const onOpenMenuRef = useRef(onOpenMenu)

  stateRef.current = state
  documentContentRef.current = documentContent
  onSelectCandidateRef.current = onSelectCandidate
  onOpenMenuRef.current = onOpenMenu

  const commitState = useCallback((next: LinkMenuState<TMatch>) => {
    stateRef.current = next
    setState(next)
  }, [])

  const dismiss = useCallback((): boolean => {
    if (!stateRef.current.isOpen) {
      return false
    }
    commitState(CLOSED_LINK_MENU_STATE)
    return true
  }, [commitState])

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
      if (candidates.length === 0) {
        dismiss()
        return
      }

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

      commitState({
        isOpen: true,
        candidates,
        selectedIndex: nextIndex,
        match,
        position
      })

      if (!wasOpen) {
        onOpenMenuRef.current?.()
      }
    },
    [commitState, dismiss]
  )

  const syncDocMatch = useCallback(
    (
      match: TMatch | null,
      coordsProvider: CoordsProvider,
      shellEl: HTMLElement | null,
      overrideContent?: string
    ): boolean => {
      if (!match) {
        dismiss()
        return false
      }
      const coords = readSafeCaretCoords(coordsProvider, match.rangeFrom)
      updateFromMatch(match, coords, shellEl, overrideContent)
      return true
    },
    [dismiss, updateFromMatch]
  )

  const moveSelection = useCallback(
    (delta: -1 | 1): boolean => {
      const current = stateRef.current
      if (!current.isOpen || current.candidates.length === 0) {
        return false
      }
      const len = current.candidates.length
      const nextIndex = (current.selectedIndex + delta + len) % len
      commitState({ ...current, selectedIndex: nextIndex })
      return true
    },
    [commitState]
  )

  const setSelectedIndex = useCallback(
    (index: number): void => {
      const current = stateRef.current
      if (!current.isOpen || index < 0 || index >= current.candidates.length) {
        return
      }
      if (current.selectedIndex === index) {
        return
      }
      commitState({ ...current, selectedIndex: index })
    },
    [commitState]
  )

  const selectCandidate = useCallback(
    (candidate: HeadingLinkCandidate) => {
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
    syncDocMatch,
    syncOpenSelection,
    moveSelection,
    applySelected,
    dismiss
  })

  useEffect(() => {
    controlsRef.current = {
      stateRef,
      updateFromMatch,
      syncDocMatch,
      syncOpenSelection,
      moveSelection,
      applySelected,
      dismiss
    }
  }, [updateFromMatch, syncDocMatch, syncOpenSelection, moveSelection, applySelected, dismiss])

  const linkMenuProps = useMemo(
    () => ({
      isOpen: state.isOpen,
      candidates: state.candidates,
      selectedIndex: state.selectedIndex,
      position: state.position,
      menuRef,
      onSelect: selectCandidate,
      onHoverIndex: setSelectedIndex,
      onDismiss: dismiss
    }),
    [dismiss, selectCandidate, setSelectedIndex, state]
  )

  return {
    linkControlsRef: controlsRef,
    linkMenuProps
  }
}
