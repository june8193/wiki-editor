import { useEffect, useRef } from 'react'
import type { SymbolCandidateMatch } from '@shared/symbol'
import { useDismissable } from '../hooks/useDismissable'

export interface SymbolCandidatePopoverState {
  symbolName: string
  candidates: readonly SymbolCandidateMatch[]
  x: number
  y: number
}

export interface SymbolNotFoundTooltipState {
  symbolName: string
  x: number
  y: number
}

interface SymbolCandidatePopoverProps {
  popover: SymbolCandidatePopoverState | null
  notFoundNotice: SymbolNotFoundTooltipState | null
  onSelectCandidate: (candidate: SymbolCandidateMatch) => void
  onDismiss: () => void
}

function clampViewportPosition(
  x: number,
  y: number,
  widthMargin: number,
  heightMargin: number,
  yOffset: number
): { left: number; top: number } {
  const maxWidth = typeof window !== 'undefined' ? window.innerWidth : 1200
  const maxHeight = typeof window !== 'undefined' ? window.innerHeight : 800
  return {
    left: Math.max(8, Math.min(x, maxWidth - widthMargin)),
    top: Math.max(8, Math.min(y + yOffset, maxHeight - heightMargin))
  }
}

export function SymbolCandidatePopover({
  popover,
  notFoundNotice,
  onSelectCandidate,
  onDismiss
}: SymbolCandidatePopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  useDismissable(popover !== null, popoverRef, onDismiss)

  useEffect(() => {
    if (!popover) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, popover])

  if (popover) {
    const { left, top } = clampViewportPosition(popover.x, popover.y, 380, 260, 12)

    return (
      <div
        ref={popoverRef}
        className="symbol-candidate-popover"
        role="dialog"
        aria-label={`${popover.symbolName} 선언 후보 선택`}
        data-testid="symbol-candidate-popover"
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <div className="symbol-candidate-popover-header">
          <span>선언 후보 ({popover.candidates.length})</span>
          <span className="symbol-candidate-popover-name">{popover.symbolName}</span>
        </div>
        <div className="symbol-candidate-popover-list" role="listbox">
          {popover.candidates.map((candidate, index) => (
            <button
              key={`${candidate.path}:${candidate.lineNumber}:${index}`}
              type="button"
              role="option"
              aria-selected={index === 0}
              className="symbol-candidate-item"
              onClick={() => onSelectCandidate(candidate)}
            >
              <span className="symbol-candidate-location">
                {candidate.path}:{candidate.lineNumber}
              </span>
              <span className="symbol-candidate-line">{candidate.lineText.trim()}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (notFoundNotice) {
    const { left, top } = clampViewportPosition(notFoundNotice.x, notFoundNotice.y, 240, 48, 14)
    return (
      <div
        className="symbol-not-found-tooltip"
        role="status"
        data-testid="symbol-not-found-tooltip"
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        "{notFoundNotice.symbolName}" 선언을 찾을 수 없습니다.
      </div>
    )
  }

  return null
}
