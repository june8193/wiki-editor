import { memo, useRef } from 'react'
import { ACCORDION_RESET_RATIO } from '../utils/accordionSplit'
import {
  computeRightSidebarSectionLayout,
  RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO,
  type RightSidebarSplitState
} from '../utils/rightSidebarSplit'
import { DocumentOutlinePanel, type DocumentOutlinePanelProps } from './DocumentOutlinePanel'
import {
  DocumentPropertiesSection,
  type DocumentPropertiesSectionProps
} from './DocumentPropertiesSection'
import { HorizontalSectionResizer } from './HorizontalSectionResizer'

export interface RightSidebarPanelProps {
  splitState: RightSidebarSplitState
  onToggleOutlineCollapsed: () => void
  onTogglePropertiesCollapsed: () => void
  onResizeOutlineRatio: (nextRatio: number) => void
  outlineProps: Omit<DocumentOutlinePanelProps, 'isExpanded' | 'flexRatio' | 'onToggleExpanded'>
  propertiesProps: Omit<
    DocumentPropertiesSectionProps,
    'isExpanded' | 'flexRatio' | 'onToggleExpanded'
  >
}

/**
 * Right sidebar 2-tier accordion hosting Document Outline (top, default 35%) and
 * Document Properties (bottom, default 65%) separated by an accessible horizontal resizer.
 */
export const RightSidebarPanel = memo(function RightSidebarPanel({
  splitState,
  onToggleOutlineCollapsed,
  onTogglePropertiesCollapsed,
  onResizeOutlineRatio,
  outlineProps,
  propertiesProps
}: RightSidebarPanelProps) {
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const layout = computeRightSidebarSectionLayout(splitState)

  return (
    <div ref={splitContainerRef} className="right-sidebar-split-container">
      <DocumentOutlinePanel
        {...outlineProps}
        isExpanded={layout.showTopBody}
        flexRatio={layout.topFlexRatio}
        onToggleExpanded={onToggleOutlineCollapsed}
      />

      {layout.showResizer && (
        <HorizontalSectionResizer
          ratio={splitState.outlineHeightRatio}
          fallbackRatio={RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO}
          resetRatio={ACCORDION_RESET_RATIO}
          containerRef={splitContainerRef}
          ariaLabel="우측 사이드바 섹션 높이 조절"
          bodyClassName="is-resizing-right-sections"
          onResizeRatio={onResizeOutlineRatio}
        />
      )}

      <DocumentPropertiesSection
        {...propertiesProps}
        isExpanded={layout.showBottomBody}
        flexRatio={layout.bottomFlexRatio}
        onToggleExpanded={onTogglePropertiesCollapsed}
      />
    </div>
  )
})
