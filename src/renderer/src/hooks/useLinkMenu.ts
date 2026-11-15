import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceEntry } from '@shared/workspace'
import {
  buildFileLinkCandidates,
  buildHeadingLinkCandidates,
  filterAndRankLinkCandidates,
  type LinkCandidate,
  type LinkQueryMatch
} from '../editor/LinkAutocompleteEngine'
export interface CaretRectCoords {
  left: number
  top: number
  bottom: number
}

export interface CoordsProvider {
  coordsAtPos: (pos: number) => { left: number; top: number; bottom: number } | null
}

export interface LinkMenuPosition {
  top: number
  left: number
}

const MENU_ESTIMATED_WIDTH = 300
const MENU_ESTIMATED_HEIGHT = 240
const MENU_EDGE_PADDING = 8
const MENU_VERTICAL_GAP = 4

export function readSafeCaretCoords(view: CoordsProvider, pos: number): CaretRectCoords | null {
  try {
    const rect = view.coordsAtPos(pos)
    return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null
  } catch {
    return null
  }
}

export function computeLinkMenuPosition(
  shellEl: HTMLElement | null,
  coords: CaretRectCoords | null
): LinkMenuPosition {
  if (!shellEl || !coords) {
    return { top: 24, left: 16 }
  }
  const shellRect = shellEl.getBoundingClientRect()
  if (shellRect.width === 0 && shellRect.height === 0) {
    const rawTop = coords.bottom - shellRect.top + MENU_VERTICAL_GAP
    const rawLeft = coords.left - shellRect.left
    return {
      top: Math.round(Math.max(24, Number.isFinite(rawTop) ? rawTop : 24)),
      left: Math.round(Math.max(16, Number.isFinite(rawLeft) ? rawLeft : 16))
    }
  }
  const maxLeft = Math.max(MENU_EDGE_PADDING, shellRect.width - MENU_ESTIMATED_WIDTH - MENU_EDGE_PADDING)
  const left = Math.max(MENU_EDGE_PADDING, Math.min(coords.left - shellRect.left, maxLeft))
  let top = coords.bottom - shellRect.top + MENU_VERTICAL_GAP
  if (shellRect.height > 0 && top + MENU_ESTIMATED_HEIGHT > shellRect.height) {
    const aboveTop = coords.top - shellRect.top - MENU_ESTIMATED_HEIGHT - MENU_VERTICAL_GAP
    top =
      aboveTop >= MENU_EDGE_PADDING
        ? aboveTop
        : Math.max(MENU_EDGE_PADDING, shellRect.height - MENU_ESTIMATED_HEIGHT - MENU_EDGE_PADDING)
  }
  return {
    top: Math.round(Math.max(MENU_EDGE_PADDING, top)),
    left: Math.round(left)
  }
}

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
  workspaceMarkdownFiles?: readonly WorkspaceEntry[]
  activeFilePath?: string | null
  onSelectCandidate: (candidate: LinkCandidate, match: TMatch) => void
  onOpenMenu?: () => void
}

const EMPTY_MARKDOWN_FILES: readonly WorkspaceEntry[] = []

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
  workspaceMarkdownFiles = EMPTY_MARKDOWN_FILES,
  activeFilePath = null,
  onSelectCandidate,
  onOpenMenu
}: UseLinkMenuOptions<TMatch>) {
  const [state, setState] = useState<LinkMenuState<TMatch>>(CLOSED_LINK_MENU_STATE)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef<LinkMenuState<TMatch>>(state)
  const fileCandidates = useMemo(
    () => buildFileLinkCandidates(workspaceMarkdownFiles, activeFilePath),
    [workspaceMarkdownFiles, activeFilePath]
  )
  const documentContentRef = useRef(documentContent)
  const fileCandidatesRef = useRef(fileCandidates)
  const onSelectCandidateRef = useRef(onSelectCandidate)
  const onOpenMenuRef = useRef(onOpenMenu)

  stateRef.current = state
  documentContentRef.current = documentContent
  fileCandidatesRef.current = fileCandidates
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
      const allCandidates: LinkCandidate[] = [
        ...buildHeadingLinkCandidates(content),
        ...fileCandidatesRef.current
      ]
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
        coords !== null || !wasOpen ? computeLinkMenuPosition(shellEl, coords) : prev.position

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

  useEffect(() => {
    const current = stateRef.current
    if (!current.isOpen || !current.match) {
      return
    }
    updateFromMatch(current.match, null, null)
  }, [fileCandidates, updateFromMatch])

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
