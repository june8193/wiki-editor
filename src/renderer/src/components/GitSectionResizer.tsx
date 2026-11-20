import { type RefObject } from 'react'
import { GIT_PANEL_DEFAULT_CHANGES_RATIO } from '../utils/gitPanelSplit'
import { HorizontalSectionResizer } from './HorizontalSectionResizer'

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
  return (
    <HorizontalSectionResizer
      ratio={changesHeightRatio}
      fallbackRatio={GIT_PANEL_DEFAULT_CHANGES_RATIO}
      resetRatio={GIT_PANEL_DEFAULT_CHANGES_RATIO}
      containerRef={containerRef}
      ariaLabel="Git 섹션 높이 조절"
      bodyClassName="is-resizing-git-sections"
      className="git-section-resizer"
      onResizeRatio={onResizeRatio}
    />
  )
}
