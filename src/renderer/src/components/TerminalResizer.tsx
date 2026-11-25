import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { usePointerDragSession } from '../hooks/usePointerDragSession'
import { clampTerminalHeight, type TerminalHeightBounds } from '../utils/terminalHeight'

const KEYBOARD_RESIZE_STEP = 20

export interface TerminalResizerProps {
  height: number
  bounds: TerminalHeightBounds
  onResize: (nextHeight: number) => void
}

/**
 * Accessible horizontal resize handle at the top edge of the terminal panel.
 */
export function TerminalResizer({ height, bounds, onResize }: TerminalResizerProps) {
  const dragOriginRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const constraintsRef = useRef({ bounds, onResize })
  constraintsRef.current = { bounds, onResize }

  const { isDragging, handleDragStart } = usePointerDragSession({
    bodyClassName: 'is-resizing-terminal',
    cursor: 'row-resize',
    onDragStart: (event) => {
      dragOriginRef.current = { startY: event.clientY, startHeight: height }
    },
    onDragMove: (event) => {
      const origin = dragOriginRef.current
      if (!origin || typeof event.clientY !== 'number') return
      const { bounds: activeBounds, onResize: activeOnResize } = constraintsRef.current
      const deltaY = origin.startY - event.clientY
      activeOnResize(clampTerminalHeight(origin.startHeight + deltaY, activeBounds))
    },
    onDragEnd: () => {
      dragOriginRef.current = null
    }
  })

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keySign = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
    if (keySign === 0) return
    event.preventDefault()
    onResize(clampTerminalHeight(height + KEYBOARD_RESIZE_STEP * keySign, bounds))
  }

  const handleDoubleClick = (): void => {
    onResize(clampTerminalHeight(bounds.defaultHeight, bounds))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="터미널 패널 높이 조절"
      aria-orientation="horizontal"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={height}
      className={`terminal-resizer${isDragging ? ' is-dragging' : ''}`}
      onPointerDown={handleDragStart}
      onMouseDown={handleDragStart}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
