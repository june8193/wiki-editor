import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { clampSidebarWidth } from '../utils/sidebarWidth'

export type SidebarResizerEdge = 'left' | 'right'

const KEYBOARD_RESIZE_STEP = 20

const MOVE_EVENTS = ['pointermove', 'mousemove'] as const
const END_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'blur'] as const

export interface SidebarResizerProps {
  edge: SidebarResizerEdge
  width: number
  minWidth: number
  maxWidth: number
  defaultWidth: number
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
  minWidth,
  maxWidth,
  defaultWidth,
  ariaLabel,
  onResize
}: SidebarResizerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragOriginRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const direction = edge === 'right' ? 1 : -1

  const resizeConstraintsRef = useRef({ direction, minWidth, maxWidth, onResize })
  resizeConstraintsRef.current = { direction, minWidth, maxWidth, onResize }

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
        minWidth: activeMin,
        maxWidth: activeMax,
        onResize: activeOnResize
      } = resizeConstraintsRef.current
      const delta = ((event as MouseEvent).clientX - origin.startX) * activeDir
      activeOnResize(clampSidebarWidth(origin.startWidth + delta, activeMin, activeMax))
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

  const startDrag = (clientX: number): void => {
    dragOriginRef.current = { startX: clientX, startWidth: width }
    setIsDragging(true)
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    if (dragOriginRef.current === null) {
      startDrag(event.clientX)
    }
  }

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    // Real browsers fire pointerdown before mousedown; avoid restarting the same drag session.
    if (dragOriginRef.current === null) {
      startDrag(event.clientX)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onResize(clampSidebarWidth(width + KEYBOARD_RESIZE_STEP * direction, minWidth, maxWidth))
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onResize(clampSidebarWidth(width - KEYBOARD_RESIZE_STEP * direction, minWidth, maxWidth))
    }
  }

  const handleDoubleClick = (): void => {
    onResize(clampSidebarWidth(defaultWidth, minWidth, maxWidth))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      className={`sidebar-resizer is-${edge}${isDragging ? ' is-dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
