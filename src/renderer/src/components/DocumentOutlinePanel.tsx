import { memo, useMemo, useState } from 'react'
import {
  type MarkdownHeading,
  parseMarkdownHeadings,
  stripInlineMarkdown
} from '../editor/MarkdownTocEngine'

export interface DocumentOutlinePanelProps {
  documentName: string | null
  content: string
  isMarkdownDocument: boolean
  showHeadingNumbers: boolean
  onToggleHeadingNumbers: () => void
  onSelectHeading: (heading: MarkdownHeading, index: number) => void
  onInsertToc: () => void
  onApplyHeadingNumbers: () => void
  onStripHeadingNumbers: () => void
}

function formatHeadingDisplayTitle(heading: MarkdownHeading, showHeadingNumbers: boolean): string {
  if (!showHeadingNumbers && heading.hasExplicitNumber) {
    return stripInlineMarkdown(heading.rawTitle) || heading.rawTitle
  }
  return heading.title
}

/**
 * Collapsible sidebar panel displaying the live document heading outline,
 * dynamic numbering toggle, click-to-scroll triggers, and explicit TOC/numbering actions.
 */
export const DocumentOutlinePanel = memo(function DocumentOutlinePanel({
  documentName,
  content,
  isMarkdownDocument,
  showHeadingNumbers,
  onToggleHeadingNumbers,
  onSelectHeading,
  onInsertToc,
  onApplyHeadingNumbers,
  onStripHeadingNumbers
}: DocumentOutlinePanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)

  const headings = useMemo(() => {
    if (!documentName || !isMarkdownDocument) return []
    return parseMarkdownHeadings(content)
  }, [content, documentName, isMarkdownDocument])

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
        {headings.map((heading, index) => (
          <li
            key={`${heading.line}-${heading.slug}`}
            className="outline-item"
            style={{ paddingLeft: `${heading.depth * 12}px` }}
          >
            <button
              type="button"
              className="outline-item-btn"
              title={`L${heading.line}: ${heading.title}`}
              onClick={() => onSelectHeading(heading, index)}
            >
              {showHeadingNumbers && (
                <span className="outline-item-number">{heading.number}</span>
              )}
              <span className="outline-item-title">
                {formatHeadingDisplayTitle(heading, showHeadingNumbers)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section className="outline-sidebar" aria-label="문서 목차 (Outline)">
      <div className="outline-header">
        <button
          type="button"
          className="outline-collapse-btn"
          aria-expanded={!isCollapsed}
          onClick={() => setIsCollapsed((prev) => !prev)}
        >
          <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
          <span>Outline</span>
          <span className="outline-count">{headings.length}</span>
        </button>

        <button
          type="button"
          className={`btn btn-sm outline-number-toggle${showHeadingNumbers ? ' is-active' : ''}`}
          aria-label="헤딩 번호 표시"
          aria-pressed={showHeadingNumbers}
          title="동적 헤딩 번호 표시 토글 (원본 파일 미변경)"
          onClick={onToggleHeadingNumbers}
        >
          1.1
        </button>
      </div>

      {!isCollapsed && (
        <div className="outline-body">
          <div className="outline-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!documentName || !isMarkdownDocument}
              onClick={onInsertToc}
            >
              본문에 목차(/toc) 삽입
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!documentName || !isMarkdownDocument}
              onClick={onApplyHeadingNumbers}
            >
              본문 헤딩 번호 쓰기
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!documentName || !isMarkdownDocument}
              onClick={onStripHeadingNumbers}
            >
              본문 헤딩 번호 제거
            </button>
          </div>
          <div className="outline-list-container">{renderBodyContent()}</div>
        </div>
      )}
    </section>
  )
})
