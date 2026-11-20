import { memo, useEffect, useMemo, useRef } from 'react'
import { PanelRightClose } from 'lucide-react'
import {
  formatOutlineHeadingTitle,
  type MarkdownHeading,
  parseMarkdownHeadings
} from '../editor/MarkdownTocEngine'
import type { SidebarDocumentContext } from '../editor/editorModes'
import {
  type AccordionSectionClassNames,
  SidebarAccordionSection
} from './SidebarAccordionSection'

const OUTLINE_ACCORDION_CLASS_NAMES: AccordionSectionClassNames = {
  section: 'outline-sidebar',
  header: 'outline-header',
  toggle: 'outline-accordion-toggle',
  body: 'outline-body'
}

export interface DocumentOutlinePanelProps {
  document: SidebarDocumentContext
  activeHeadingIndex?: number | null
  showHeadingNumbers: boolean
  isExpanded?: boolean
  flexRatio?: number | null
  onToggleExpanded?: () => void
  onToggleHeadingNumbers: () => void
  onSelectHeading: (heading: MarkdownHeading, index: number) => void
  onCollapse: () => void
}

interface ActiveOutlineScrollTarget {
  documentKey: string
  index: number
}

/**
 * Right sidebar panel displaying the live document heading outline,
 * active heading indicator and auto-scroll, outline numbering toggle,
 * sidebar collapse trigger, optional accordion toggle, and click-to-scroll triggers.
 */
export const DocumentOutlinePanel = memo(function DocumentOutlinePanel({
  document,
  activeHeadingIndex = null,
  showHeadingNumbers,
  isExpanded = true,
  flexRatio = null,
  onToggleExpanded,
  onToggleHeadingNumbers,
  onSelectHeading,
  onCollapse
}: DocumentOutlinePanelProps) {
  const { documentName, documentKey, content, isMarkdownDocument } = document
  const itemButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const prevScrollTargetRef = useRef<ActiveOutlineScrollTarget | null>(null)

  const headings = useMemo(() => {
    if (!documentName || !isMarkdownDocument) return []
    return parseMarkdownHeadings(content)
  }, [content, documentName, isMarkdownDocument])

  const validActiveIndex =
    documentName &&
    isMarkdownDocument &&
    activeHeadingIndex !== null &&
    activeHeadingIndex >= 0 &&
    activeHeadingIndex < headings.length
      ? activeHeadingIndex
      : null

  const resolvedDocumentKey = documentName ? (documentKey ?? documentName) : null

  useEffect(() => {
    if (validActiveIndex === null || resolvedDocumentKey === null) {
      prevScrollTargetRef.current = null
      return
    }
    const prev = prevScrollTargetRef.current
    if (prev?.documentKey === resolvedDocumentKey && prev.index === validActiveIndex) {
      return
    }
    prevScrollTargetRef.current = { documentKey: resolvedDocumentKey, index: validActiveIndex }

    const targetButton = itemButtonRefs.current.get(validActiveIndex)
    if (targetButton && typeof targetButton.scrollIntoView === 'function') {
      targetButton.scrollIntoView({ block: 'nearest' })
    }
  }, [resolvedDocumentKey, validActiveIndex])

  const renderBodyContent = () => {
    if (!documentName) {
      return <p className="outline-empty-text">열린 문서 없음</p>
    }
    if (!isMarkdownDocument) {
      return <p className="outline-empty-text">마크다운 문서에서만 목차를 지원합니다.</p>
    }
    if (headings.length === 0) {
      return <p className="outline-empty-text">표시할 헤딩이 없습니다.</p>
    }

    return (
      <ul className="outline-list" role="list">
        {headings.map((heading, index) => {
          const isActive = validActiveIndex === index
          return (
            <li
              key={`${heading.line}-${heading.slug}`}
              className="outline-item"
              style={{ paddingLeft: `${heading.depth * 12}px` }}
            >
              <button
                ref={(el) => {
                  if (el) {
                    itemButtonRefs.current.set(index, el)
                  } else {
                    itemButtonRefs.current.delete(index)
                  }
                }}
                type="button"
                className={`outline-item-btn${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'location' : undefined}
                title={`L${heading.line}: ${heading.title}`}
                onClick={() => onSelectHeading(heading, index)}
              >
                {showHeadingNumbers && (
                  <span className="outline-item-number">{heading.number}</span>
                )}
                <span className="outline-item-title">
                  {formatOutlineHeadingTitle(heading, showHeadingNumbers)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  const headerActions = (
    <div className="outline-header-actions">
      <button
        type="button"
        className={`btn btn-sm outline-number-toggle${showHeadingNumbers ? ' is-active' : ''}`}
        aria-pressed={showHeadingNumbers}
        title="목차 헤딩 번호 표시 토글 (원본 파일 미변경)"
        onClick={onToggleHeadingNumbers}
      >
        목차 번호 표시
      </button>

      <button
        type="button"
        className="icon-btn outline-collapse-btn"
        aria-label="문서 목차 접기"
        title="문서 목차 접기"
        onClick={onCollapse}
      >
        <PanelRightClose size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )

  const bodyContent = <div className="outline-list-container">{renderBodyContent()}</div>

  if (onToggleExpanded) {
    return (
      <SidebarAccordionSection
        title="Outline"
        ariaLabel="문서 목차 (Outline)"
        badge={<span className="outline-count">{headings.length}</span>}
        headerActions={headerActions}
        isExpanded={isExpanded}
        flexRatio={flexRatio}
        classNames={OUTLINE_ACCORDION_CLASS_NAMES}
        onToggle={onToggleExpanded}
      >
        {bodyContent}
      </SidebarAccordionSection>
    )
  }

  return (
    <section className="outline-sidebar" aria-label="문서 목차 (Outline)">
      <div className="outline-header">
        <div className="outline-title-group">
          <span>Outline</span>
          <span className="outline-count">{headings.length}</span>
        </div>
        {headerActions}
      </div>

      <div className="outline-body">{bodyContent}</div>
    </section>
  )
})
