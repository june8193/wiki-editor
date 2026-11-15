import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react'
import {
  clampChangesHeightRatio,
  GIT_PANEL_CHANGES_RATIO_STEP,
  GIT_PANEL_DEFAULT_CHANGES_RATIO,
  GIT_PANEL_MAX_CHANGES_RATIO,
  GIT_PANEL_MIN_CHANGES_RATIO,
  stepChangesHeightRatio,
  toChangesHeightPercent
} from '../utils/gitPanelSplit'

const MOVE_EVENTS = ['pointermove', 'mousemove'] as const
const END_EVENTS = ['pointerup', 'pointercancel', 'mouseup', 'blur'] as const

const MIN_PERCENT = toChangesHeightPercent(GIT_PANEL_MIN_CHANGES_RATIO)
const MAX_PERCENT = toChangesHeightPercent(GIT_PANEL_MAX_CHANGES_RATIO)

export interface GitSectionResizerProps {
  changesHeightRatio: number
  containerRef: RefObject<HTMLDivElement | null>
  onResizeRatio: (nextRatio: number) => void
}

/**
 * Accessible horizontal splitter between the Git Changes and Graph accordion sections.
 */
export function GitSectionResizer({
  changesHeightRatio,
  containerRef,
  onResizeRatio
}: GitSectionResizerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const latestRef = useRef({ containerRef, onResizeRatio })
  latestRef.current = { containerRef, onResizeRatio }

  useEffect(() => {
    if (!isDragging) return

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.classList.add('is-resizing-git-sections')
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const handleMove = (event: Event): void => {
      if (!isDraggingRef.current || typeof (event as MouseEvent).clientY !== 'number') return
      const container = latestRef.current.containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (rect.height <= 0) return
      const nextRatio = clampChangesHeightRatio(((event as MouseEvent).clientY - rect.top) / rect.height)
      latestRef.current.onResizeRatio(nextRatio)
    }

    const handleEnd = (): void => {
      isDraggingRef.current = false
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
      document.body.classList.remove('is-resizing-git-sections')
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

  const handleDragStart = (event: { button?: number; preventDefault: () => void }): void => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    // Real browsers fire pointerdown before mousedown; avoid restarting the active drag session.
    if (!isDraggingRef.current) {
      isDraggingRef.current = true
      setIsDragging(true)
    }
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const keySign = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (keySign === 0) return
    event.preventDefault()
    onResizeRatio(
      stepChangesHeightRatio(changesHeightRatio, GIT_PANEL_CHANGES_RATIO_STEP * keySign)
    )
  }

  const handleDoubleClick = (): void => {
    onResizeRatio(GIT_PANEL_DEFAULT_CHANGES_RATIO)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Git 섹션 높이 조절"
      aria-orientation="horizontal"
      aria-valuemin={MIN_PERCENT}
      aria-valuemax={MAX_PERCENT}
      aria-valuenow={toChangesHeightPercent(changesHeightRatio)}
      className={`git-section-resizer${isDragging ? ' is-dragging' : ''}`}
      onPointerDown={handleDragStart}
      onMouseDown={handleDragStart}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  )
}
