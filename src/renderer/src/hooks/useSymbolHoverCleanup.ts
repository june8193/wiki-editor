import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { CodeParser } from '../editor/codeBlockHighlight'
import {
  type HoveredSymbolRange,
  resolveSingleLineSymbolAtEvent,
  type SymbolNavigateRequest
} from '../editor/symbolHoverDom'
import { isFindReferencesShortcut, isSymbolModifierPressed } from '../editor/symbolNavigation'

/**
 * Clears an active Ctrl/Cmd hover underline when the modifier key is released or the window loses focus.
 */
export function useSymbolHoverCleanup(
  hasHoveredSymbol: boolean,
  onClearHover: () => void
): void {
  useEffect(() => {
    if (!hasHoveredSymbol) return
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!isSymbolModifierPressed(event)) {
        onClearHover()
      }
    }
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', onClearHover)
    return () => {
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', onClearHover)
    }
  }, [hasHoveredSymbol, onClearHover])
}

function buildSymbolRequest(
  resolved: HoveredSymbolRange,
  side: 'old' | 'new' | undefined,
  event: Pick<MouseEvent, 'clientX' | 'clientY' | 'shiftKey'>
): SymbolNavigateRequest {
  return {
    symbolName: resolved.name,
    lineNumber: resolved.lineNumber,
    ...(side ? { side } : {}),
    columnStart: resolved.columnStart,
    columnEnd: resolved.columnEnd,
    clientX: event.clientX,
    clientY: event.clientY,
    shiftKey: event.shiftKey
  }
}

/**
 * Shared line-level Ctrl/Cmd hover, click, right-click context menu, and Shift+F12
 * symbol-navigation controller for `GitDiffViewer` and `SnapshotViewer`.
 */
export function useLineSymbolHover({
  isSymbolNavEnabled,
  activeSyntaxParser,
  onSymbolNavigate,
  onSymbolContextMenu,
  onFindReferences
}: {
  isSymbolNavEnabled: boolean
  activeSyntaxParser: CodeParser | null
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
  onSymbolContextMenu?: (request: SymbolNavigateRequest) => void
  onFindReferences?: (request: SymbolNavigateRequest) => void
}) {
  const [hoveredSymbol, setHoveredSymbol] = useState<HoveredSymbolRange | null>(null)
  const activeSymbolRef = useRef<SymbolNavigateRequest | null>(null)
  const clearHover = useCallback(() => setHoveredSymbol(null), [])

  useSymbolHoverCleanup(hoveredSymbol !== null, clearHover)

  const handleLineMouseMove = useCallback(
    (
      lineText: string,
      lineNumber: number,
      side: 'old' | 'new' | undefined,
      event: ReactMouseEvent<HTMLElement>
    ): void => {
      if (!isSymbolNavEnabled || !isSymbolModifierPressed(event.nativeEvent)) {
        setHoveredSymbol((prev) => (prev ? null : prev))
        return
      }
      const resolved = resolveSingleLineSymbolAtEvent(
        lineText,
        lineNumber,
        side,
        event.nativeEvent,
        event.currentTarget,
        activeSyntaxParser
      )
      if (resolved) {
        activeSymbolRef.current = buildSymbolRequest(resolved, side, event)
      }
      setHoveredSymbol(resolved)
    },
    [activeSyntaxParser, isSymbolNavEnabled]
  )

  const handleLineMouseLeave = useCallback(
    (lineNumber: number, side?: 'old' | 'new'): void => {
      setHoveredSymbol((prev) =>
        prev && prev.lineNumber === lineNumber && prev.side === side ? null : prev
      )
    },
    []
  )

  const handleLineClick = useCallback(
    (
      lineText: string,
      lineNumber: number,
      side: 'old' | 'new' | undefined,
      event: ReactMouseEvent<HTMLElement>
    ): void => {
      if (!isSymbolNavEnabled) {
        return
      }
      const resolved = resolveSingleLineSymbolAtEvent(
        lineText,
        lineNumber,
        side,
        event.nativeEvent,
        event.currentTarget,
        activeSyntaxParser
      )
      if (resolved) {
        activeSymbolRef.current = buildSymbolRequest(resolved, side, event)
      }
      if (!onSymbolNavigate || !isSymbolModifierPressed(event.nativeEvent) || !resolved) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onSymbolNavigate(buildSymbolRequest(resolved, side, event))
    },
    [activeSyntaxParser, isSymbolNavEnabled, onSymbolNavigate]
  )

  const handleLineContextMenu = useCallback(
    (
      lineText: string,
      lineNumber: number,
      side: 'old' | 'new' | undefined,
      event: ReactMouseEvent<HTMLElement>
    ): void => {
      if (!onSymbolContextMenu || !isSymbolNavEnabled) {
        return
      }
      const resolved = resolveSingleLineSymbolAtEvent(
        lineText,
        lineNumber,
        side,
        event.nativeEvent,
        event.currentTarget,
        activeSyntaxParser
      )
      if (!resolved) {
        return
      }
      const request = buildSymbolRequest(resolved, side, event)
      activeSymbolRef.current = request
      event.preventDefault()
      event.stopPropagation()
      onSymbolContextMenu(request)
    },
    [activeSyntaxParser, isSymbolNavEnabled, onSymbolContextMenu]
  )

  const handleViewerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (!onFindReferences || !isSymbolNavEnabled || !isFindReferencesShortcut(event)) {
        return
      }
      const active = activeSymbolRef.current
      if (!active) return
      event.preventDefault()
      event.stopPropagation()
      onFindReferences(active)
    },
    [isSymbolNavEnabled, onFindReferences]
  )

  return {
    hoveredSymbol,
    clearHover,
    handleLineMouseMove,
    handleLineMouseLeave,
    handleLineClick,
    handleLineContextMenu,
    handleViewerKeyDown
  }
}
