import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { CodeParser } from '../editor/codeBlockHighlight'
import {
  type HoveredSymbolRange,
  resolveSingleLineSymbolAtEvent,
  type SymbolNavigateRequest
} from '../editor/symbolHoverDom'
import { isSymbolModifierPressed } from '../editor/symbolNavigation'

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

/**
 * Shared line-level Ctrl/Cmd hover & click symbol-navigation controller for `GitDiffViewer` and `SnapshotViewer`.
 */
export function useLineSymbolHover({
  isSymbolNavEnabled,
  activeSyntaxParser,
  onSymbolNavigate
}: {
  isSymbolNavEnabled: boolean
  activeSyntaxParser: CodeParser | null
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
}) {
  const [hoveredSymbol, setHoveredSymbol] = useState<HoveredSymbolRange | null>(null)
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
      if (!onSymbolNavigate || !isSymbolNavEnabled || !isSymbolModifierPressed(event.nativeEvent)) {
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
      if (!resolved) return
      event.preventDefault()
      event.stopPropagation()
      onSymbolNavigate({
        symbolName: resolved.name,
        lineNumber: resolved.lineNumber,
        ...(side ? { side } : {}),
        columnStart: resolved.columnStart,
        columnEnd: resolved.columnEnd,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey
      })
    },
    [activeSyntaxParser, isSymbolNavEnabled, onSymbolNavigate]
  )

  return {
    hoveredSymbol,
    clearHover,
    handleLineMouseMove,
    handleLineMouseLeave,
    handleLineClick
  }
}
