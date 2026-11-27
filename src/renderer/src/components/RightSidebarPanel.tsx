import { memo, useRef } from 'react'
import type { SidebarDocumentContext } from '../editor/editorModes'
import { computeTwoSectionLayout, type TwoSectionSplitState } from '../utils/accordionSplit'
import { DocumentOutlinePanel, type DocumentOutlinePanelProps } from './DocumentOutlinePanel'
import {
  DocumentPropertiesSection,
  type DocumentPropertiesSectionProps
} from './DocumentPropertiesSection'
import { HorizontalSectionResizer } from './HorizontalSectionResizer'
import {
  IDLE_REFERENCES_STATE,
  isCodeReferencesDocument,
  ReferencesSection,
  type ReferencesSectionProps
} from './ReferencesSection'

export const RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO = 0.35

export interface RightSidebarPanelProps {
  document: SidebarDocumentContext
  splitState: TwoSectionSplitState
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
  referencesProps?: Omit<
    ReferencesSectionProps,
    'isExpanded' | 'flexRatio' | 'onToggleExpanded'
  >
}

/**
 * Right sidebar 2-tier accordion hosting Document Outline (top, default 35%) and
 * Document Properties or Code References (bottom, default 65%) separated by an accessible horizontal resizer.
 */
export const RightSidebarPanel = memo(function RightSidebarPanel({
  document,
  splitState,
  onToggleOutlineCollapsed,
  onTogglePropertiesCollapsed,
  onResizeOutlineRatio,
  outlineProps,
  propertiesProps,
  referencesProps
}: RightSidebarPanelProps) {
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const layout = computeTwoSectionLayout(splitState, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)
  const showReferences = isCodeReferencesDocument(document)

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
          ratio={splitState.topHeightRatio}
          fallbackRatio={RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO}
          containerRef={splitContainerRef}
          ariaLabel="우측 사이드바 섹션 높이 조절"
          bodyClassName="is-resizing-right-sections"
          onResizeRatio={onResizeOutlineRatio}
        />
      )}

      {showReferences ? (
        <ReferencesSection
          state={referencesProps?.state ?? IDLE_REFERENCES_STATE}
          isExpanded={layout.showBottomBody}
          flexRatio={layout.bottomFlexRatio}
          onToggleExpanded={onTogglePropertiesCollapsed}
        />
      ) : (
        <DocumentPropertiesSection
          document={document}
          {...propertiesProps}
          isExpanded={layout.showBottomBody}
          flexRatio={layout.bottomFlexRatio}
          onToggleExpanded={onTogglePropertiesCollapsed}
        />
      )}
    </div>
  )
})
