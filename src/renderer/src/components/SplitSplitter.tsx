import { KeyboardEvent as ReactKeyboardEvent, RefObject, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  SplitDirection,
  normalizeSplitRatio
} from '../stores/PaneTabStore'

export const SPLITTER_KEYBOARD_STEP = 0.05

interface SplitSplitterProps {
  containerRef: RefObject<HTMLElement | null>
  direction: SplitDirection
  ratio: number
  ariaLabel: string
  onChangeRatio: (nextRatio: number) => void
  allowReset?: boolean
}

/**
 * Accessible drag- and keyboard-resizable splitter between two split areas.
 */
export function SplitSplitter({
  containerRef,
  direction,
  ratio,
  ariaLabel,
  onChangeRatio,
  allowReset = false
}: SplitSplitterProps) {
  const [isDragging, setIsDragging] = useState(false)
  const onChangeRatioRef = useRef(onChangeRatio)
  onChangeRatioRef.current = onChangeRatio

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event: MouseEvent): void => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const rawRatio =
        direction === 'horizontal'
          ? rect.width > 0
            ? (event.clientX - rect.left) / rect.width
            : null
          : rect.height > 0
            ? (event.clientY - rect.top) / rect.height
            : null
      if (rawRatio === null) return
      onChangeRatioRef.current(normalizeSplitRatio(rawRatio))
    }

    const handleDragEnd = (): void => {
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleDragEnd)
    window.addEventListener('blur', handleDragEnd)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleDragEnd)
      window.removeEventListener('blur', handleDragEnd)
    }
  }, [containerRef, direction, isDragging])

  const isHorizontal = direction === 'horizontal'
  const decKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
  const incKey = isHorizontal ? 'ArrowRight' : 'ArrowDown'

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== decKey && event.key !== incKey) return
    event.preventDefault()
    event.stopPropagation()
    const delta = event.key === decKey ? -SPLITTER_KEYBOARD_STEP : SPLITTER_KEYBOARD_STEP
    onChangeRatio(normalizeSplitRatio(ratio + delta))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={Math.round(MIN_SPLIT_RATIO * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_RATIO * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      className={`split-divider is-${direction}${isDragging ? ' is-dragging' : ''}`}
      onMouseDown={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDoubleClick={allowReset ? () => onChangeRatio(DEFAULT_SPLIT_RATIO) : undefined}
      onKeyDown={handleKeyDown}
    />
  )
}
