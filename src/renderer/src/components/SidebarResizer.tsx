import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { clampSidebarWidth, type SidebarWidthBounds } from '../utils/sidebarWidth'

export type SidebarResizerEdge = 'left' | 'right'

const KEYBOARD_RESIZE_STEP = 20

const MOVE_EVENTS = ['pointermove', 'mousemove'] as const
const END_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'blur'] as const

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
  const [isDragging, setIsDragging] = useState(false)
  const dragOriginRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const direction = edge === 'right' ? 1 : -1

  const resizeConstraintsRef = useRef({ direction, bounds, onResize })
  resizeConstraintsRef.current = { direction, bounds, onResize }

  useEffect(() => {
    if (!isDragging) return

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.classList.add('is-resizing-sidebar')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (event: Event): void => {
      const origin = dragOriginRef.current
      if (!origin || typeof (event as MouseEvent).clientX !== 'number') return
      const {
        direction: activeDir,
        bounds: activeBounds,
        onResize: activeOnResize
      } = resizeConstraintsRef.current
      const delta = ((event as MouseEvent).clientX - origin.startX) * activeDir
      activeOnResize(clampSidebarWidth(origin.startWidth + delta, activeBounds))
    }

    const handleEnd = (): void => {
      dragOriginRef.current = null
      setIsDragging(false)
    }

    for (const name of MOVE_EVENTS) {
      window.addEventListener(name, handleMove)
    }
    for (const name of END_EVENTS) {
      window.addEventListener(name, handleEnd)
    }

    return () => {
      dragOriginRef.current = null
      document.body.classList.remove('is-resizing-sidebar')
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      for (const name of MOVE_EVENTS) {
        window.removeEventListener(name, handleMove)
      }
      for (const name of END_EVENTS) {
        window.removeEventListener(name, handleEnd)
      }
    }
  }, [isDragging])

  const handleDragStart = (event: {
    button?: number
    clientX: number
    preventDefault: () => void
  }): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    // Real browsers fire pointerdown before mousedown; avoid restarting the same drag session.
    if (dragOriginRef.current === null) {
      dragOriginRef.current = { startX: event.clientX, startWidth: width }
      setIsDragging(true)
    }
  }

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
