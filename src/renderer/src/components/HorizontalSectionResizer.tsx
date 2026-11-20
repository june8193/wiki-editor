import { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { usePointerDragSession } from '../hooks/usePointerDragSession'
import {
  ACCORDION_MAX_TOP_RATIO,
  ACCORDION_MIN_TOP_RATIO,
  ACCORDION_RATIO_STEP,
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  stepSectionHeightRatio,
  toSectionHeightPercent
} from '../utils/accordionSplit'

const MIN_PERCENT = toSectionHeightPercent(ACCORDION_MIN_TOP_RATIO)
const MAX_PERCENT = toSectionHeightPercent(ACCORDION_MAX_TOP_RATIO)

export interface HorizontalSectionResizerProps {
  ratio: number
  fallbackRatio?: number
  containerRef: RefObject<HTMLDivElement | null>
  ariaLabel: string
  bodyClassName: string
  onResizeRatio: (nextRatio: number) => void
}

/**
 * Accessible horizontal section resizer between two vertically stacked accordion sections.
 */
export function HorizontalSectionResizer({
  ratio,
  fallbackRatio = ACCORDION_RESET_RATIO,
  containerRef,
  ariaLabel,
  bodyClassName,
  onResizeRatio
}: HorizontalSectionResizerProps) {
  const { isDragging, handleDragStart } = usePointerDragSession({
    bodyClassName,
    cursor: 'row-resize',
    onDragMove: (event) => {
      if (typeof event.clientY !== 'number') return
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (rect.height <= 0) return
      onResizeRatio(clampSectionHeightRatio((event.clientY - rect.top) / rect.height, fallbackRatio))
    }
  })

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keySign = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (keySign === 0) return
    event.preventDefault()
    onResizeRatio(
      stepSectionHeightRatio(ratio, ACCORDION_RATIO_STEP * keySign, fallbackRatio)
    )
  }

  const handleDoubleClick = (): void => {
    onResizeRatio(ACCORDION_RESET_RATIO)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-valuemin={MIN_PERCENT}
      aria-valuemax={MAX_PERCENT}
      aria-valuenow={toSectionHeightPercent(ratio, fallbackRatio)}
      className={`section-resizer${isDragging ? ' is-dragging' : ''}`}
      onPointerDown={handleDragStart}
      onMouseDown={handleDragStart}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
