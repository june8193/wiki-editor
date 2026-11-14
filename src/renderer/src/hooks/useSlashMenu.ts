import { useCallback, useEffect, useRef, useState } from 'react'
import type { CustomCommandConfig } from '@shared/config'
import { filterSlashCommands, type SlashQueryMatch } from '../editor/SlashCommandEngine'

export interface CaretRectCoords {
  left: number
  top: number
  bottom: number
}

export interface SlashMenuPosition {
  top: number
  left: number
}

export interface SlashMenuState {
  isOpen: boolean
  query: string
  rangeFrom: number
  rangeTo: number
  items: CustomCommandConfig[]
  selectedIndex: number
  position: SlashMenuPosition
}

const MENU_ESTIMATED_WIDTH = 300
const MENU_ESTIMATED_HEIGHT = 240
const MENU_EDGE_PADDING = 8
const MENU_VERTICAL_GAP = 4

const CLOSED_MENU_STATE: SlashMenuState = {
  isOpen: false,
  query: '',
  rangeFrom: 0,
  rangeTo: 0,
  items: [],
  selectedIndex: 0,
  position: { top: 24, left: 16 }
}

export function computeSlashMenuPosition(
  shellEl: HTMLElement | null,
  coords: CaretRectCoords | null
): SlashMenuPosition {
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

/**
 * Shared state machine for editor slash command autocomplete menus (Raw & WYSIWYG).
 * Maintains a synchronous ref mirror so keydown handlers see immediate keyboard state updates.
 */
export function useSlashMenu(commands: readonly CustomCommandConfig[]) {
  const [menuState, setMenuState] = useState<SlashMenuState>(CLOSED_MENU_STATE)
  const stateRef = useRef<SlashMenuState>(CLOSED_MENU_STATE)
  const commandsRef = useRef<readonly CustomCommandConfig[]>(commands)
  commandsRef.current = commands

  const commitState = useCallback((next: SlashMenuState) => {
    stateRef.current = next
    setMenuState(next)
  }, [])

  const dismiss = useCallback((): boolean => {
    if (!stateRef.current.isOpen) {
      return false
    }
    commitState(CLOSED_MENU_STATE)
    return true
  }, [commitState])

  const updateFromMatch = useCallback(
    (
      match: SlashQueryMatch | null,
      coords: CaretRectCoords | null,
      shellEl: HTMLElement | null
    ): void => {
      if (!match) {
        if (stateRef.current.isOpen) {
          commitState(CLOSED_MENU_STATE)
        }
        return
      }

      const items = filterSlashCommands(commandsRef.current, match.query)
      if (items.length === 0) {
        if (stateRef.current.isOpen) {
          commitState(CLOSED_MENU_STATE)
        }
        return
      }

      const prev = stateRef.current
      const prevTrigger = prev.isOpen ? prev.items[prev.selectedIndex]?.trigger : undefined
      const preservedIdx = prevTrigger
        ? items.findIndex((item) => item.trigger === prevTrigger)
        : -1

      commitState({
        isOpen: true,
        query: match.query,
        rangeFrom: match.rangeFrom,
        rangeTo: match.rangeTo,
        items,
        selectedIndex: preservedIdx >= 0 ? preservedIdx : 0,
        position: computeSlashMenuPosition(shellEl, coords)
      })
    },
    [commitState]
  )

  const moveSelection = useCallback(
    (delta: 1 | -1): boolean => {
      const current = stateRef.current
      if (!current.isOpen || current.items.length === 0) {
        return false
      }
      const nextIndex = (current.selectedIndex + delta + current.items.length) % current.items.length
      commitState({ ...current, selectedIndex: nextIndex })
      return true
    },
    [commitState]
  )

  const setSelectedIndex = useCallback(
    (index: number): void => {
      const current = stateRef.current
      if (!current.isOpen || index < 0 || index >= current.items.length) {
        return
      }
      if (current.selectedIndex === index) {
        return
      }
      commitState({ ...current, selectedIndex: index })
    },
    [commitState]
  )

  useEffect(() => {
    const current = stateRef.current
    if (!current.isOpen) {
      return
    }
    const items = filterSlashCommands(commands, current.query)
    if (items.length === 0) {
      commitState(CLOSED_MENU_STATE)
      return
    }
    const prevTrigger = current.items[current.selectedIndex]?.trigger
    const preservedIdx = prevTrigger
      ? items.findIndex((item) => item.trigger === prevTrigger)
      : -1
    commitState({
      ...current,
      items,
      selectedIndex: preservedIdx >= 0 ? preservedIdx : 0
    })
  }, [commands, commitState])

  return {
    menuState,
    stateRef,
    updateFromMatch,
    moveSelection,
    setSelectedIndex,
    dismiss
  }
}
