import { memo, useRef } from 'react'
import type { SidebarDocumentContext } from '../hooks/useDocumentOutline'
import { ACCORDION_RESET_RATIO, computeTwoSectionLayout } from '../utils/accordionSplit'
import {
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
  document: SidebarDocumentContext
  splitState: RightSidebarSplitState
  onToggleOutlineCollapsed: () => void
  onTogglePropertiesCollapsed: () => void
  onResizeOutlineRatio: (nextRatio: number) => void
  outlineProps: Omit<
    DocumentOutlinePanelProps,
    'document' | 'isExpanded' | 'flexRatio' | 'onToggleExpanded'
  >
  propertiesProps: Omit<
    DocumentPropertiesSectionProps,
    'document' | 'isExpanded' | 'flexRatio' | 'onToggleExpanded'
  >
}

/**
 * Right sidebar 2-tier accordion hosting Document Outline (top, default 35%) and
 * Document Properties (bottom, default 65%) separated by an accessible horizontal resizer.
 */
export const RightSidebarPanel = memo(function RightSidebarPanel({
  document,
  splitState,
  onToggleOutlineCollapsed,
  onTogglePropertiesCollapsed,
  onResizeOutlineRatio,
  outlineProps,
  propertiesProps
}: RightSidebarPanelProps) {
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const layout = computeTwoSectionLayout(
    splitState.isOutlineCollapsed,
    splitState.isPropertiesCollapsed,
    splitState.outlineHeightRatio,
    RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO
  )

  return (
    <div ref={splitContainerRef} className="right-sidebar-split-container">
      <DocumentOutlinePanel
        document={document}
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
        document={document}
        {...propertiesProps}
        isExpanded={layout.showBottomBody}
        flexRatio={layout.bottomFlexRatio}
        onToggleExpanded={onTogglePropertiesCollapsed}
      />
    </div>
  )
})
