import { useEffect, useRef, useState } from 'react'

const MOVE_EVENTS = ['pointermove', 'mousemove'] as const
const END_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'blur'] as const

export interface PointerDragStartEvent {
  button?: number
  clientX: number
  clientY: number
  preventDefault: () => void
}

export interface PointerDragSessionOptions {
  bodyClassName: string
  cursor: 'col-resize' | 'row-resize' | 'grabbing'
  onDragStart?: (event: PointerDragStartEvent) => void
  onDragMove: (event: MouseEvent) => void
  onDragEnd?: () => void
}

export interface PointerDragSession {
  isDragging: boolean
  handleDragStart: (event: PointerDragStartEvent) => void
}

/**
 * Manages global pointer/mouse drag listeners and body cursor/selection locks for resize handles.
 */
export function usePointerDragSession({
  bodyClassName,
  cursor,
  onDragStart,
  onDragMove,
  onDragEnd
}: PointerDragSessionOptions): PointerDragSession {
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const latestRef = useRef({ bodyClassName, cursor, onDragStart, onDragMove, onDragEnd })
  latestRef.current = { bodyClassName, cursor, onDragStart, onDragMove, onDragEnd }

  useEffect(() => {
    if (!isDragging) return

    const { bodyClassName: activeBodyClass, cursor: activeCursor } = latestRef.current
    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.classList.add(activeBodyClass)
    document.body.style.cursor = activeCursor
    document.body.style.userSelect = 'none'

    const handleMove = (event: Event): void => {
      if (!isDraggingRef.current) return
      const pointerEvent = event as MouseEvent
      if (typeof pointerEvent.clientX !== 'number' && typeof pointerEvent.clientY !== 'number') {
        return
      }
      latestRef.current.onDragMove(pointerEvent)
    }

    const handleEnd = (): void => {
      isDraggingRef.current = false
      latestRef.current.onDragEnd?.()
      setIsDragging(false)
    }

    for (const name of MOVE_EVENTS) {
      window.addEventListener(name, handleMove)
    }
    for (const name of END_EVENTS) {
      window.addEventListener(name, handleEnd)
    }

    return () => {
      isDraggingRef.current = false
      latestRef.current.onDragEnd?.()
      document.body.classList.remove(activeBodyClass)
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

  const handleDragStart = (event: PointerDragStartEvent): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    // Real browsers fire pointerdown before mousedown; avoid restarting the same drag session.
    if (!isDraggingRef.current) {
      isDraggingRef.current = true
      latestRef.current.onDragStart?.(event)
      setIsDragging(true)
    }
  }

  return { isDragging, handleDragStart }
}
