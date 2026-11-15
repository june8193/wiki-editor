import { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { usePointerDragSession } from '../hooks/usePointerDragSession'
import {
  clampChangesHeightRatio,
  GIT_PANEL_CHANGES_RATIO_STEP,
  GIT_PANEL_DEFAULT_CHANGES_RATIO,
  GIT_PANEL_MAX_CHANGES_RATIO,
  GIT_PANEL_MIN_CHANGES_RATIO,
  stepChangesHeightRatio,
  toChangesHeightPercent
} from '../utils/gitPanelSplit'

const MIN_PERCENT = toChangesHeightPercent(GIT_PANEL_MIN_CHANGES_RATIO)
const MAX_PERCENT = toChangesHeightPercent(GIT_PANEL_MAX_CHANGES_RATIO)

export interface GitSectionResizerProps {
  changesHeightRatio: number
  containerRef: RefObject<HTMLDivElement | null>
  onResizeRatio: (nextRatio: number) => void
}

/**
 * Accessible horizontal section resizer between the Git Changes and Graph accordion sections.
 */
export function GitSectionResizer({
  changesHeightRatio,
  containerRef,
  onResizeRatio
}: GitSectionResizerProps) {
  const { isDragging, handleDragStart } = usePointerDragSession({
    bodyClassName: 'is-resizing-git-sections',
    cursor: 'row-resize',
    onDragMove: (event) => {
      if (typeof event.clientY !== 'number') return
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (rect.height <= 0) return
      onResizeRatio(clampChangesHeightRatio((event.clientY - rect.top) / rect.height))
    }
  })

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
