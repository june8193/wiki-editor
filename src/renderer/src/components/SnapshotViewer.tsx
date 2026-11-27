import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CompiledSearchMatcher } from '@shared/search'
import type { GitBlobSnapshot, GitBlobSnapshotRequest } from '@shared/symbol'
import type { CodeParser } from '../editor/codeBlockHighlight'
import { isSymbolSupportedFile } from '../editor/codeSymbolExtractor'
import {
  type FindHighlightSpan,
  renderSyntaxLineWithHover,
  type SymbolNavigateRequest
} from '../editor/symbolHoverDom'
import type { DocumentEditorFindControl } from '../hooks/useDocumentEditorFind'
import { useLineSymbolHover } from '../hooks/useSymbolHoverCleanup'
import { groupFindHighlightsByKey, useViewerDocumentFind } from '../hooks/useViewerDocumentFind'
import {
  getDiffLineSyntaxSpans,
  loadDiffLanguageParser,
  resolveDiffLanguageParserSync
} from '../utils/diffSyntaxHighlight'
import { DocumentFindBar } from './DocumentFindBar'

export type SnapshotContentState =
  | { status: 'loading' }
  | { status: 'loaded'; snapshot: GitBlobSnapshot }
  | { status: 'error'; errorMessage: string }

export interface SnapshotJumpRequest {
  lineNumber: number
  nonce: number
}

export interface SnapshotViewerProps {
  request: GitBlobSnapshotRequest
  state: SnapshotContentState
  scrollTop?: number
  jumpRequest?: SnapshotJumpRequest | null
  isActive?: boolean
  isShortcutDisabled?: boolean
  findControl?: DocumentEditorFindControl
  onScrollTopChange?: (scrollTop: number) => void
  onOpenLocalFile?: (repoRelativePath: string) => void
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
  onSymbolContextMenu?: (request: SymbolNavigateRequest) => void
  onFindReferences?: (request: SymbolNavigateRequest) => void
}

interface SnapshotFindMatch {
  lineNumber: number
  start: number
  end: number
}

function SnapshotViewerInner({
  request,
  state,
  scrollTop = 0,
  jumpRequest = null,
  isActive = true,
  isShortcutDisabled = false,
  findControl,
  onScrollTopChange,
  onOpenLocalFile,
  onSymbolNavigate,
  onSymbolContextMenu,
  onFindReferences
}: SnapshotViewerProps) {
  const loadedSnapshot = state.status === 'loaded' ? state.snapshot : null
  const displayRef = request.scope.displayRef
  const canOpenLocalFile = loadedSnapshot?.existsInWorkspace === true

  const syncParserResolution = useMemo(
    () => resolveDiffLanguageParserSync(request.path),
    [request.path]
  )
  const [loadedParserState, setLoadedParserState] = useState<{
    path: string
    parser: CodeParser | null
  }>({ path: '', parser: null })

  useEffect(() => {
    if (!syncParserResolution.needsAsyncLoad) {
      return
    }
    let cancelled = false
    const targetPath = request.path
    void loadDiffLanguageParser(targetPath).then((parser) => {
      if (!cancelled) {
        setLoadedParserState({ path: targetPath, parser })
      }
    })
    return () => {
      cancelled = true
    }
  }, [request.path, syncParserResolution.needsAsyncLoad])

  const activeSyntaxParser =
    syncParserResolution.parser ??
    (loadedParserState.path === request.path ? loadedParserState.parser : null)

  const lines = useMemo(() => {
    if (!loadedSnapshot || loadedSnapshot.isBinary) {
      return []
    }
    return loadedSnapshot.content.replace(/\r\n/g, '\n').split('\n')
  }, [loadedSnapshot])

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null)

  const computeSnapshotMatches = useCallback(
    (matcher: CompiledSearchMatcher): SnapshotFindMatch[] => {
      const results: SnapshotFindMatch[] = []
      for (let i = 0; i < lines.length; i += 1) {
        const lineMatches = matcher.findMatches(lines[i])
        for (const span of lineMatches) {
          results.push({ lineNumber: i + 1, start: span.start, end: span.end })
        }
      }
      return results
    },
    [lines]
  )

  const handleScrollToMatch = useCallback(
    (activeMatch: SnapshotFindMatch, container: HTMLElement | null) =>
      container?.querySelector(`[data-line-number="${activeMatch.lineNumber}"]`) ?? null,
    []
  )

  const {
    matches: findMatches,
    activeMatchIndex,
    findBarProps
  } = useViewerDocumentFind({
    findControl,
    isActive,
    isShortcutDisabled,
    selectionContainerRef: scrollContainerRef,
    excludedSelectionSelector: '.snapshot-line-gutter, .document-find-bar',
    computeMatches: computeSnapshotMatches,
    onScrollToMatch: handleScrollToMatch
  })

  const findHighlightsByLine = useMemo(
    () => groupFindHighlightsByKey(findMatches, activeMatchIndex, (m) => m.lineNumber),
    [findMatches, activeMatchIndex]
  )
  const isSymbolNavEnabled = isSymbolSupportedFile(request.path) && activeSyntaxParser !== null
  const {
    hoveredSymbol,
    clearHover,
    handleLineMouseMove,
    handleLineMouseLeave,
    handleLineClick,
    handleLineContextMenu,
    handleViewerKeyDown
  } = useLineSymbolHover({
    isSymbolNavEnabled,
    activeSyntaxParser,
    onSymbolNavigate,
    onSymbolContextMenu,
    onFindReferences
  })

  useEffect(() => {
    clearHover()
  }, [clearHover, request.path, loadedSnapshot])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    if (scrollTop > 0 && container.scrollTop !== scrollTop && !jumpRequest) {
      container.scrollTop = scrollTop
    }
  }, [scrollTop, jumpRequest, loadedSnapshot])

  useLayoutEffect(() => {
    if (!jumpRequest || lines.length === 0) {
      setHighlightedLine(null)
      return
    }
    const clampedLine = Math.max(1, Math.min(jumpRequest.lineNumber, lines.length))
    setHighlightedLine(clampedLine)
    const rowEl = scrollContainerRef.current?.querySelector(
      `[data-line-number="${clampedLine}"]`
    ) as HTMLElement | null
    rowEl?.scrollIntoView?.({ block: 'center' })
  }, [jumpRequest, lines.length])

  return (
    <section
      className="snapshot-viewer"
      data-testid="snapshot-viewer"
      aria-label={`${request.path} 스냅샷 뷰어`}
      tabIndex={-1}
      onKeyDown={handleViewerKeyDown}
    >
      <header className="snapshot-viewer-header">
        <div className="snapshot-viewer-title-group">
          <span className="snapshot-viewer-badge">🔒 {displayRef}</span>
          <span className="snapshot-viewer-path" title={request.path}>
            {request.path}
          </span>
          {loadedSnapshot?.encoding && (
            <span className="snapshot-viewer-encoding">{loadedSnapshot.encoding}</span>
          )}
        </div>
        <div className="snapshot-viewer-actions">
          {canOpenLocalFile && onOpenLocalFile && (
            <button
              type="button"
              className="snapshot-open-local-btn"
              onClick={() => onOpenLocalFile(request.path)}
            >
              로컬 파일 열기
            </button>
          )}
        </div>
      </header>

      <div className="snapshot-readonly-banner" role="status">
        <span>읽기 전용 스냅샷 ({displayRef}) — 로컬 편집 파일과 분리된 과거/비교 시점 코드입니다.</span>
        {loadedSnapshot?.isTruncated && (
          <span className="snapshot-truncated-note">
            {' '}
            (2MB를 초과하는 대용량 파일이므로 앞부분만 표시합니다.)
          </span>
        )}
      </div>

      <div className="viewer-body-container">
        {findBarProps && <DocumentFindBar {...findBarProps} />}
        {state.status === 'loading' ? (
          <div className="snapshot-empty-state">스냅샷 불러오는 중...</div>
        ) : state.status === 'error' ? (
          <div className="snapshot-empty-state is-error" role="alert">
            {state.errorMessage}
          </div>
        ) : loadedSnapshot?.isBinary ? (
          <div className="snapshot-empty-state">바이너리 파일은 텍스트 스냅샷 미리보기를 지원하지 않습니다.</div>
        ) : (
          <div
            ref={scrollContainerRef}
            className="snapshot-code-scroll"
            onScroll={(event) => {
              onScrollTopChange?.(event.currentTarget.scrollTop)
            }}
          >
            <table className="snapshot-code-table">
              <tbody>
                {lines.map((lineText, idx) => {
                  const lineNumber = idx + 1
                  const syntaxSpans = getDiffLineSyntaxSpans(
                    lineText,
                    request.path,
                    activeSyntaxParser
                  )
                  const isHighlighted = highlightedLine === lineNumber
                  const hoverRange =
                    hoveredSymbol && hoveredSymbol.lineNumber === lineNumber
                      ? { columnStart: hoveredSymbol.columnStart, columnEnd: hoveredSymbol.columnEnd }
                      : null
                  const lineFindHighlights = findHighlightsByLine.get(lineNumber)
                  return (
                    <tr
                      key={lineNumber}
                      data-line-number={lineNumber}
                      className={`snapshot-code-row${isHighlighted ? ' is-jump-highlight' : ''}`}
                    >
                      <td className="snapshot-line-gutter">{lineNumber}</td>
                      <td
                        className="snapshot-line-code"
                        onMouseMove={(event) =>
                          handleLineMouseMove(lineText, lineNumber, undefined, event)
                        }
                        onMouseLeave={() => handleLineMouseLeave(lineNumber)}
                        onClick={(event) => handleLineClick(lineText, lineNumber, undefined, event)}
                        onContextMenu={(event) =>
                          handleLineContextMenu(lineText, lineNumber, undefined, event)
                        }
                      >
                        {renderSyntaxLineWithHover(
                          lineText,
                          syntaxSpans,
                          hoverRange,
                          undefined,
                          lineFindHighlights
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export const SnapshotViewer = memo(SnapshotViewerInner)
