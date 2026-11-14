import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CustomCommandConfig } from '@shared/config'
import { filterSlashCommands, type SlashQueryMatch } from '../editor/SlashCommandEngine'

export interface CaretRectCoords {
  left: number
  top: number
  bottom: number
}

export interface CoordsProvider {
  coordsAtPos: (pos: number) => { left: number; top: number; bottom: number } | null
}

export interface SlashMenuRange {
  rangeFrom: number
  rangeTo: number
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

/**
 * Safely queries caret viewport coordinates from either CodeMirror or ProseMirror views.
 */
export function readSafeCaretCoords(view: CoordsProvider, pos: number): CaretRectCoords | null {
  try {
    const rect = view.coordsAtPos(pos)
    return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null
  } catch {
    return null
  }
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

function preserveSelectedIndex(
  items: readonly CustomCommandConfig[],
  prev: Pick<SlashMenuState, 'isOpen' | 'items' | 'selectedIndex'>
): number {
  const prevTrigger = prev.isOpen ? prev.items[prev.selectedIndex]?.trigger : undefined
  if (!prevTrigger) {
    return 0
  }
  const preservedIdx = items.findIndex((item) => item.trigger === prevTrigger)
  return preservedIdx >= 0 ? preservedIdx : 0
}

/**
 * Shared state machine and editor bridge for slash command autocomplete menus (Raw & WYSIWYG).
 * Keeps a synchronous ref mirror so editor keydown handlers read latest state immediately.
 */
export function useSlashMenu(
  commands: readonly CustomCommandConfig[],
  onApplyCommand?: (command: CustomCommandConfig, range?: SlashMenuRange) => boolean
) {
  const [menuState, setMenuState] = useState<SlashMenuState>(CLOSED_MENU_STATE)
  const stateRef = useRef<SlashMenuState>(CLOSED_MENU_STATE)
  const commandsRef = useRef<readonly CustomCommandConfig[]>(commands)
  commandsRef.current = commands
  const onApplyRef = useRef(onApplyCommand)
  onApplyRef.current = onApplyCommand

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
        dismiss()
        return
      }

      const items = filterSlashCommands(commandsRef.current, match.query)
      if (items.length === 0) {
        dismiss()
        return
      }

      commitState({
        isOpen: true,
        query: match.query,
        rangeFrom: match.rangeFrom,
        rangeTo: match.rangeTo,
        items,
        selectedIndex: preserveSelectedIndex(items, stateRef.current),
        position: computeSlashMenuPosition(shellEl, coords)
      })
    },
    [commitState, dismiss]
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

  const applySelected = useCallback((): boolean => {
    const current = stateRef.current
    if (!current.isOpen || current.items.length === 0 || !onApplyRef.current) {
      return false
    }
    const selected = current.items[current.selectedIndex] ?? current.items[0]
    if (!selected) {
      return false
    }
    const applied = onApplyRef.current(selected, {
      rangeFrom: current.rangeFrom,
      rangeTo: current.rangeTo
    })
    if (applied) {
      dismiss()
    }
    return applied
  }, [dismiss])

  const selectCommand = useCallback(
    (command: CustomCommandConfig): void => {
      if (!onApplyRef.current) return
      const current = stateRef.current
      const applied = onApplyRef.current(
        command,
        current.isOpen ? { rangeFrom: current.rangeFrom, rangeTo: current.rangeTo } : undefined
      )
      if (applied) {
        dismiss()
      }
    },
    [dismiss]
  )

  const dismissIfSelectionOutside = useCallback(
    (from: number, to: number, empty: boolean): void => {
      const current = stateRef.current
      if (!current.isOpen) return
      if (!empty || from < current.rangeFrom || to > current.rangeTo) {
        dismiss()
      }
    },
    [dismiss]
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
    commitState({
      ...current,
      items,
      selectedIndex: preserveSelectedIndex(items, current)
    })
  }, [commands, commitState])

  const controlsRef = useRef({
    stateRef,
    updateFromMatch,
    moveSelection,
    applySelected,
    dismiss,
    dismissIfSelectionOutside
  })

  const menuProps = useMemo(
    () => ({
      isOpen: menuState.isOpen,
      items: menuState.items,
      selectedIndex: menuState.selectedIndex,
      position: menuState.position,
      onSelect: selectCommand,
      onHoverIndex: setSelectedIndex,
      onDismiss: dismiss
    }),
    [dismiss, menuState, selectCommand, setSelectedIndex]
  )

  return {
    menuState,
    menuProps,
    controlsRef,
    stateRef,
    updateFromMatch,
    moveSelection,
    setSelectedIndex,
    dismiss,
    applySelected,
    selectCommand,
    dismissIfSelectionOutside
  }
}
