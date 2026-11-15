import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { usePointerDragSession } from '../hooks/usePointerDragSession'
import { clampSidebarWidth, type SidebarWidthBounds } from '../utils/sidebarWidth'

export type SidebarResizerEdge = 'left' | 'right'

const KEYBOARD_RESIZE_STEP = 20

export interface SidebarResizerProps {
  edge: SidebarResizerEdge
  width: number
  bounds: SidebarWidthBounds
  ariaLabel: string
  onResize: (nextWidth: number) => void
}

/**
 * Accessible vertical resize handle shared by sidebars.
 * `edge` identifies which edge of the sidebar holds the handle (`right` for left sidebar, `left` for right sidebar).
 */
export function SidebarResizer({
  edge,
  width,
  bounds,
  ariaLabel,
  onResize
}: SidebarResizerProps) {
  const dragOriginRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const direction = edge === 'right' ? 1 : -1

  const resizeConstraintsRef = useRef({ direction, bounds, onResize })
  resizeConstraintsRef.current = { direction, bounds, onResize }

  const { isDragging, handleDragStart } = usePointerDragSession({
    bodyClassName: 'is-resizing-sidebar',
    cursor: 'col-resize',
    onDragStart: (event) => {
      dragOriginRef.current = { startX: event.clientX, startWidth: width }
    },
    onDragMove: (event) => {
      const origin = dragOriginRef.current
      if (!origin || typeof event.clientX !== 'number') return
      const {
        direction: activeDir,
        bounds: activeBounds,
        onResize: activeOnResize
      } = resizeConstraintsRef.current
      const delta = (event.clientX - origin.startX) * activeDir
      activeOnResize(clampSidebarWidth(origin.startWidth + delta, activeBounds))
    },
    onDragEnd: () => {
      dragOriginRef.current = null
    }
  })

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keySign = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (keySign === 0) return
    event.preventDefault()
    onResize(clampSidebarWidth(width + KEYBOARD_RESIZE_STEP * direction * keySign, bounds))
  }

  const handleDoubleClick = (): void => {
    onResize(clampSidebarWidth(bounds.defaultWidth, bounds))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      className={`sidebar-resizer is-${edge}${isDragging ? ' is-dragging' : ''}`}
      onPointerDown={handleDragStart}
      onMouseDown={handleDragStart}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
