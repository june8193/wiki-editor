import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { PanelRightClose } from 'lucide-react'
import type { DocumentSymbolItem, SymbolKind } from '@shared/symbol'
import type { CodeParser } from '../editor/codeBlockHighlight'
import {
  extractDiffSymbols,
  extractDocumentSymbols,
  isSymbolSupportedFile
} from '../editor/codeSymbolExtractor'
import {
  formatOutlineHeadingTitle,
  type MarkdownHeading,
  parseMarkdownHeadings
} from '../editor/MarkdownTocEngine'
import type { SidebarDocumentContext } from '../editor/editorModes'
import { loadDiffLanguageParser, resolveDiffLanguageParserSync } from '../utils/diffSyntaxHighlight'
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

const SYMBOL_KIND_BADGE: Record<SymbolKind, { short: string; label: string }> = {
  function: { short: 'fn', label: '함수' },
  class: { short: 'cls', label: '클래스' },
  method: { short: 'm', label: '메서드' },
  interface: { short: 'iface', label: '인터페이스' },
  type: { short: 'type', label: '타입' },
  enum: { short: 'enum', label: '열거형' },
  variable: { short: 'var', label: '변수' },
  property: { short: 'prop', label: '속성' }
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
  onSelectSymbol?: (symbol: DocumentSymbolItem) => void
  onCollapse: () => void
}

interface ActiveOutlineScrollTarget {
  documentKey: string
  index: number
}

/**
 * Right sidebar panel displaying the live document heading outline (for Markdown) or
 * code symbol outline with filtering and diff change badges (for code & diff tabs).
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
  onSelectSymbol,
  onCollapse
}: DocumentOutlinePanelProps) {
  const {
    documentName,
    documentKey,
    content,
    isMarkdownDocument,
    diffContext
  } = document
  const itemButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const prevScrollTargetRef = useRef<ActiveOutlineScrollTarget | null>(null)
  const [symbolFilter, setSymbolFilter] = useState('')

  const symbolTargetFile = diffContext ? (diffContext.filePath ?? documentName) : documentName
  const isCodeOutline =
    Boolean(symbolTargetFile) && !isMarkdownDocument && isSymbolSupportedFile(symbolTargetFile)

  const syncParserResolution = useMemo(
    () =>
      isCodeOutline && symbolTargetFile
        ? resolveDiffLanguageParserSync(symbolTargetFile)
        : { parser: null, needsAsyncLoad: false },
    [isCodeOutline, symbolTargetFile]
  )

  const [loadedParserState, setLoadedParserState] = useState<{
    path: string
    parser: CodeParser | null
  }>({ path: '', parser: null })

  useEffect(() => {
    if (!isCodeOutline || !symbolTargetFile || !syncParserResolution.needsAsyncLoad) {
      return
    }
    let cancelled = false
    const targetPath = symbolTargetFile
    void loadDiffLanguageParser(targetPath).then((parser) => {
      if (!cancelled) {
        setLoadedParserState({ path: targetPath, parser })
      }
    })
    return () => {
      cancelled = true
    }
  }, [isCodeOutline, symbolTargetFile, syncParserResolution.needsAsyncLoad])

  const activeCodeParser =
    syncParserResolution.parser ??
    (symbolTargetFile && loadedParserState.path === symbolTargetFile
      ? loadedParserState.parser
      : null)

  const headings = useMemo(() => {
    if (!documentName || !isMarkdownDocument) return []
    return parseMarkdownHeadings(content)
  }, [content, documentName, isMarkdownDocument])

  const symbols = useMemo(() => {
    if (!isCodeOutline || !activeCodeParser) return []
    if (diffContext) {
      return extractDiffSymbols(diffContext.rawPatch ?? '', diffContext.status, activeCodeParser)
    }
    return extractDocumentSymbols(content, activeCodeParser)
  }, [isCodeOutline, activeCodeParser, diffContext, content])

  const normalizedFilter = symbolFilter.trim().toLowerCase()
  const filteredSymbols = useMemo(() => {
    if (!normalizedFilter) return symbols
    return symbols.filter(
      (sym) =>
        sym.name.toLowerCase().includes(normalizedFilter) ||
        (sym.containerName?.toLowerCase().includes(normalizedFilter) ?? false)
    )
  }, [symbols, normalizedFilter])

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
    setSymbolFilter('')
  }, [resolvedDocumentKey])

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

  const renderCodeSymbolBody = () => {
    return (
      <>
        <div className="outline-symbol-filter-row">
          <input
            type="search"
            className="outline-symbol-filter"
            aria-label="심볼 필터"
            placeholder="심볼 필터..."
            value={symbolFilter}
            onChange={(event) => setSymbolFilter(event.target.value)}
          />
        </div>
        {symbols.length === 0 ? (
          <p className="outline-empty-text">표시할 심볼이 없습니다.</p>
        ) : filteredSymbols.length === 0 ? (
          <p className="outline-empty-text">일치하는 심볼이 없습니다.</p>
        ) : (
          <ul className="outline-list outline-symbol-list" role="list">
            {filteredSymbols.map((sym, index) => {
              const badge = SYMBOL_KIND_BADGE[sym.kind]
              return (
                <li
                  key={`${sym.kind}-${sym.name}-${sym.lineNumber}-${index}`}
                  className="outline-item outline-symbol-item"
                >
                  <button
                    type="button"
                    className="outline-item-btn outline-symbol-btn"
                    title={`${badge.label} ${sym.containerName ? `${sym.containerName}.` : ''}${sym.name} (L${sym.lineNumber})`}
                    onClick={() => onSelectSymbol?.(sym)}
                  >
                    <span className={`outline-symbol-kind outline-symbol-kind--${sym.kind}`}>
                      {badge.short}
                    </span>
                    <span className="outline-item-title">
                      {sym.containerName ? `${sym.containerName}.${sym.name}` : sym.name}
                    </span>
                    {sym.diffChange && (
                      <span
                        className={`outline-symbol-diff is-${sym.diffChange}`}
                        aria-label={sym.diffChange === 'added' ? '추가됨' : '수정됨'}
                      >
                        {sym.diffChange === 'added' ? '+' : 'M'}
                      </span>
                    )}
                    <span className="outline-symbol-line">L{sym.lineNumber}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </>
    )
  }

  const renderBodyContent = () => {
    if (!documentName) {
      return <p className="outline-empty-text">열린 문서 없음</p>
    }
    if (isCodeOutline) {
      return renderCodeSymbolBody()
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
      {!isCodeOutline && (
        <button
          type="button"
          className={`btn btn-sm outline-number-toggle${showHeadingNumbers ? ' is-active' : ''}`}
          aria-pressed={showHeadingNumbers}
          title="목차 헤딩 번호 표시 토글 (원본 파일 미변경)"
          onClick={onToggleHeadingNumbers}
        >
          목차 번호 표시
        </button>
      )}

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

  const outlineCount = isCodeOutline ? filteredSymbols.length : headings.length
  const bodyContent = <div className="outline-list-container">{renderBodyContent()}</div>

  if (onToggleExpanded) {
    return (
      <SidebarAccordionSection
        title="Outline"
        ariaLabel="문서 목차 (Outline)"
        badge={<span className="outline-count">{outlineCount}</span>}
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
          <span className="outline-count">{outlineCount}</span>
        </div>
        {headerActions}
      </div>

      <div className="outline-body">{bodyContent}</div>
    </section>
  )
})
