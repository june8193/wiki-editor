import { useCallback, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ThemeMode } from '@shared/config'
import { DEFAULT_SEARCH_MATCH_OPTIONS } from '@shared/search'
import type { DocumentFindHighlightQuery } from '../editor/documentFind'
import { parseMarkdownHeadings } from '../editor/MarkdownTocEngine'
import type { HeadingScrollSpySample } from '../editor/outlineScrollSpy'
import { filterManualDocument, parseManualDocument } from '../utils/manualDocument'
import { MarkdownPreview, type PreviewScrollRequest } from './MarkdownPreview'
import { ModalDialog } from './ModalDialog'

interface ManualModalProps {
  content: string
  theme: ThemeMode
  isDismissDisabled?: boolean
  onClose: () => void
}

/**
 * Large modal displaying the bundled user manual with a clickable TOC sidebar and keyword search.
 */
export function ManualModal({
  content,
  theme,
  isDismissDisabled = false,
  onClose
}: ManualModalProps) {
  const [query, setQuery] = useState('')
  const [scrollRequest, setScrollRequest] = useState<PreviewScrollRequest | null>(null)
  const [activeHeadingSlug, setActiveHeadingSlug] = useState<string | null>(null)
  const scrollNonceRef = useRef(0)

  const parsed = useMemo(() => parseManualDocument(content), [content])
  const filtered = useMemo(() => filterManualDocument(parsed, query), [parsed, query])
  const allRenderedHeadings = useMemo(
    () => (filtered.markdown ? parseMarkdownHeadings(filtered.markdown) : []),
    [filtered.markdown]
  )
  const trimmedQuery = query.trim()

  const findHighlight = useMemo<DocumentFindHighlightQuery | null>(() => {
    if (!trimmedQuery) {
      return null
    }
    return {
      isActive: true,
      criteria: {
        query: trimmedQuery,
        options: DEFAULT_SEARCH_MATCH_OPTIONS
      },
      activeIndex: -1,
      scrollNonce: 0
    }
  }, [trimmedQuery])

  const handleSelectTocItem = useCallback((slug: string, index: number): void => {
    scrollNonceRef.current += 1
    setActiveHeadingSlug(slug)
    setScrollRequest({
      slug,
      index,
      nonce: scrollNonceRef.current
    })
  }, [])

  const handleActiveHeadingChange = useCallback(
    (sample: HeadingScrollSpySample): void => {
      if (sample.headingIndex === null) {
        return
      }
      const matched = allRenderedHeadings[sample.headingIndex]
      if (matched && (matched.level === 2 || matched.level === 3)) {
        setActiveHeadingSlug(matched.slug)
      }
    },
    [allRenderedHeadings]
  )

  const effectiveActiveSlug = activeHeadingSlug ?? filtered.tocItems[0]?.slug ?? null

  return (
    <ModalDialog
      backdropClassName="manual-modal-backdrop"
      dialogClassName="manual-modal"
      ariaLabel="사용자 매뉴얼"
      autoFocusDialog
      isDismissDisabled={isDismissDisabled}
      onClose={onClose}
    >
      <div className="manual-modal-header">
        <h2 className="manual-modal-title">사용자 매뉴얼</h2>
        <div className="manual-modal-search">
          <Search className="manual-modal-search-icon" size={14} aria-hidden="true" />
          <input
            type="search"
            className="manual-modal-search-input"
            aria-label="매뉴얼 검색"
            placeholder="단축키 또는 기능 검색..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filtered.isFiltered && (
            <>
              <span className="manual-modal-search-count">
                {filtered.matchedSectionCount} / {filtered.totalSectionCount}개 섹션
              </span>
              <button
                type="button"
                className="manual-modal-search-clear"
                aria-label="검색어 지우기"
                onClick={() => setQuery('')}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <button type="button" className="btn" onClick={onClose}>
          닫기
        </button>
      </div>

      <div className="manual-modal-body">
        <nav className="manual-modal-toc" aria-label="매뉴얼 목차">
          {filtered.tocItems.length === 0 ? (
            <p className="manual-modal-toc-empty">표시할 목차가 없습니다.</p>
          ) : (
            <ul className="manual-modal-toc-list">
              {filtered.tocItems.map((item, index) => {
                const isActive = effectiveActiveSlug === item.slug
                return (
                  <li key={`${item.slug}-${item.line}`}>
                    <button
                      type="button"
                      className={`manual-modal-toc-item is-level-${item.level}${
                        isActive ? ' is-active' : ''
                      }`}
                      aria-current={isActive ? 'location' : undefined}
                      onClick={() => handleSelectTocItem(item.slug, index)}
                    >
                      {item.title}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>

        <div className="manual-modal-content">
          {filtered.isFiltered && filtered.matchedSectionCount === 0 ? (
            <div className="manual-modal-empty-state">
              <p>일치하는 매뉴얼 항목이 없습니다.</p>
            </div>
          ) : (
            <MarkdownPreview
              content={filtered.markdown}
              scrollTop={0}
              theme={theme}
              scrollRequest={scrollRequest}
              findHighlight={findHighlight}
              testId="manual-markdown-preview"
              onActiveHeadingChange={handleActiveHeadingChange}
            />
          )}
        </div>
      </div>
    </ModalDialog>
  )
}
