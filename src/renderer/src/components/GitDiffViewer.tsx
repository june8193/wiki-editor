import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import type { CodeBlockHighlightSpan, CodeParser } from '../editor/codeBlockHighlight'
import { isSymbolSupportedFile } from '../editor/codeSymbolExtractor'
import {
  type HoveredSymbolRange,
  renderSyntaxLineWithHover,
  type SymbolNavigateRequest
} from '../editor/symbolHoverDom'
import { isSymbolModifierPressed } from '../editor/symbolNavigation'
import type { GitDiffViewMode } from '../stores/PaneTabStore'
import {
  getDiffLineSyntaxSpans,
  loadDiffLanguageParser,
  resolveDiffLanguageParserSync
} from '../utils/diffSyntaxHighlight'
import {
  formatGitDiffTabKey,
  formatGitFileLabel,
  getGitDiffContextLabel,
  getGitFileBadgeModifier
} from '../utils/gitFilePresentation'
import { useDiffVirtualScroll } from '../hooks/useDiffVirtualScroll'
import { useLineSymbolHover } from '../hooks/useSymbolHoverCleanup'
import {
  buildInlineDiffRows,
  buildSideBySideDiffRows,
  parseUnifiedDiff,
  type DiffTextRange,
  type UnifiedDiffSideCell
} from '../utils/unifiedDiff'

export type GitDiffContentState =
  | { status: 'loading' }
  | { status: 'loaded'; diff: GitFileDiff }
  | { status: 'error'; errorMessage: string }

export interface GitDiffNavigationProps {
  /** 1-based index of the current file in the navigation list */
  currentIndex: number
  totalCount: number
  onPrevFile: () => void
  onNextFile: () => void
}

export interface DiffJumpRequest {
  lineNumber: number
  side?: 'old' | 'new'
  nonce: number
}

interface GitDiffViewerProps {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
  state: GitDiffContentState
  onChangeViewMode: (nextMode: GitDiffViewMode) => void
  onOpenFile?: (repoRelativePath: string) => void
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
  navigation?: GitDiffNavigationProps
  jumpRequest?: DiffJumpRequest | null
}

const DIFF_ROW_TYPE_CLASS: Record<UnifiedDiffSideCell['type'], string> = {
  context: '',
  delete: ' is-delete',
  add: ' is-add',
  note: ' is-note'
}

function DiffCodeContent({
  marker,
  content,
  wordHighlights,
  syntaxSpans,
  hoverRange,
  onMouseMove,
  onMouseLeave,
  onClick
}: {
  marker: string
  content: string
  wordHighlights?: DiffTextRange[]
  syntaxSpans?: CodeBlockHighlightSpan[]
  hoverRange?: { columnStart: number; columnEnd: number } | null
  onMouseMove?: (event: React.MouseEvent<HTMLSpanElement>) => void
  onMouseLeave?: () => void
  onClick?: (event: React.MouseEvent<HTMLSpanElement>) => void
}) {
  return (
    <>
      <span className="git-diff-marker" aria-hidden="true">
        {marker}
      </span>
      <span
        className="git-diff-line-text"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      >
        {renderSyntaxLineWithHover(content, syntaxSpans, hoverRange ?? null, wordHighlights)}
      </span>
    </>
  )
}

function SideCell({
  cell,
  side,
  filePath,
  syntaxParser,
  hoveredSymbol,
  onLineMouseMove,
  onLineMouseLeave,
  onLineClick
}: {
  cell: UnifiedDiffSideCell | null
  side: 'old' | 'new'
  filePath: string
  syntaxParser: CodeParser | null
  hoveredSymbol: HoveredSymbolRange | null
  onLineMouseMove?: (
    lineText: string,
    lineNumber: number,
    side: 'old' | 'new',
    event: React.MouseEvent<HTMLSpanElement>
  ) => void
  onLineMouseLeave?: (lineNumber: number, side: 'old' | 'new') => void
  onLineClick?: (
    lineText: string,
    lineNumber: number,
    side: 'old' | 'new',
    event: React.MouseEvent<HTMLSpanElement>
  ) => void
}) {
  if (!cell) {
    return (
      <>
        <td className={`git-diff-gutter is-empty is-${side}`} />
        <td className={`git-diff-code is-empty is-${side}`} />
      </>
    )
  }

  const lineClass = DIFF_ROW_TYPE_CLASS[cell.type]
  const syntaxSpans =
    cell.type === 'note' ? undefined : getDiffLineSyntaxSpans(cell.content, filePath, syntaxParser)
  const lineNumber = cell.lineNumber
  const hoverRange =
    lineNumber !== null &&
    hoveredSymbol &&
    hoveredSymbol.lineNumber === lineNumber &&
    hoveredSymbol.side === side
      ? { columnStart: hoveredSymbol.columnStart, columnEnd: hoveredSymbol.columnEnd }
      : null

  return (
    <>
      <td className={`git-diff-gutter${lineClass} is-${side}`}>
        {cell.lineNumber ?? ''}
      </td>
      <td className={`git-diff-code${lineClass} is-${side}`}>
        <DiffCodeContent
          marker={cell.marker}
          content={cell.content}
          wordHighlights={cell.wordHighlights}
          syntaxSpans={syntaxSpans}
          hoverRange={hoverRange}
          onMouseMove={
            lineNumber !== null && cell.type !== 'note' && onLineMouseMove
              ? (event) => onLineMouseMove(cell.content, lineNumber, side, event)
              : undefined
          }
          onMouseLeave={
            lineNumber !== null && onLineMouseLeave
              ? () => onLineMouseLeave(lineNumber, side)
              : undefined
          }
          onClick={
            lineNumber !== null && cell.type !== 'note' && onLineClick
              ? (event) => onLineClick(cell.content, lineNumber, side, event)
              : undefined
          }
        />
      </td>
    </>
  )
}

function DiffSpacerRow({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) {
    return null
  }
  return (
    <tr className="git-diff-spacer-row" aria-hidden="true">
      <td colSpan={colSpan} style={{ height: `${height}px`, padding: 0, border: 0 }} />
    </tr>
  )
}

function VirtualizedDiffBody<TRow>({
  rows,
  colSpan,
  isVirtualized,
  startIndex,
  topSpacerHeight,
  bottomSpacerHeight,
  renderRow
}: {
  rows: readonly TRow[]
  colSpan: number
  isVirtualized: boolean
  startIndex: number
  topSpacerHeight: number
  bottomSpacerHeight: number
  renderRow: (row: TRow, idx: number, dataRowIndex: number | undefined) => ReactNode
}) {
  return (
    <tbody>
      {isVirtualized && <DiffSpacerRow height={topSpacerHeight} colSpan={colSpan} />}
      {rows.map((row, offset) => {
        const idx = isVirtualized ? startIndex + offset : offset
        return renderRow(row, idx, idx)
      })}
      {isVirtualized && <DiffSpacerRow height={bottomSpacerHeight} colSpan={colSpan} />}
    </tbody>
  )
}

function areNavigationPropsEqual(
  prev: GitDiffNavigationProps | undefined,
  next: GitDiffNavigationProps | undefined
): boolean {
  if (prev === next) {
    return true
  }
  if (!prev || !next) {
    return false
  }
  return (
    prev.currentIndex === next.currentIndex &&
    prev.totalCount === next.totalCount &&
    prev.onPrevFile === next.onPrevFile &&
    prev.onNextFile === next.onNextFile
  )
}

function areGitDiffViewerPropsEqual(
  prev: GitDiffViewerProps,
  next: GitDiffViewerProps
): boolean {
  return (
    prev.request === next.request &&
    prev.viewMode === next.viewMode &&
    prev.state === next.state &&
    prev.onChangeViewMode === next.onChangeViewMode &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onSymbolNavigate === next.onSymbolNavigate &&
    prev.jumpRequest === next.jumpRequest &&
    areNavigationPropsEqual(prev.navigation, next.navigation)
  )
}

function findDiffJumpRowIndex<TRow>(
  rows: readonly TRow[],
  getLineNumbers: (row: TRow) => { oldLine: number | null; newLine: number | null } | null,
  lineNumber: number,
  targetSide: 'old' | 'new'
): number {
  const exactIndex = rows.findIndex((row) => {
    const lines = getLineNumbers(row)
    if (!lines) return false
    return targetSide === 'old' ? lines.oldLine === lineNumber : lines.newLine === lineNumber
  })
  if (exactIndex >= 0) {
    return exactIndex
  }
  return rows.findIndex((row) => {
    const lines = getLineNumbers(row)
    return Boolean(lines && (lines.newLine === lineNumber || lines.oldLine === lineNumber))
  })
}

function GitDiffViewerInner({
  request,
  viewMode,
  state,
  onChangeViewMode,
  onOpenFile,
  onSymbolNavigate,
  navigation,
  jumpRequest = null
}: GitDiffViewerProps) {
  const loadedDiff = state.status === 'loaded' ? state.diff : null
  const displayFile = loadedDiff ?? request
  const displayPath = formatGitFileLabel(displayFile)
  const contextLabel = getGitDiffContextLabel(request)
  const canOpenFile = loadedDiff?.existsInWorkspace === true && displayFile.status !== 'D'

  const syncParserResolution = useMemo(
    () => resolveDiffLanguageParserSync(displayFile.path),
    [displayFile.path]
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
    const targetPath = displayFile.path
    void loadDiffLanguageParser(targetPath).then((parser) => {
      if (!cancelled) {
        setLoadedParserState({ path: targetPath, parser })
      }
    })
    return () => {
      cancelled = true
    }
  }, [displayFile.path, syncParserResolution.needsAsyncLoad])

  const activeSyntaxParser =
    syncParserResolution.parser ??
    (loadedParserState.path === displayFile.path ? loadedParserState.parser : null)

  const parsed = useMemo(
    () => (loadedDiff && !loadedDiff.isBinary ? parseUnifiedDiff(loadedDiff.rawPatch) : null),
    [loadedDiff]
  )
  const sideBySideRows = useMemo(
    () => (parsed && viewMode === 'side-by-side' ? buildSideBySideDiffRows(parsed) : []),
    [parsed, viewMode]
  )
  const inlineRows = useMemo(
    () => (parsed && viewMode === 'inline' ? buildInlineDiffRows(parsed) : []),
    [parsed, viewMode]
  )
  const fileKey = useMemo(() => formatGitDiffTabKey(request), [request])
  const totalRows = viewMode === 'side-by-side' ? sideBySideRows.length : inlineRows.length
  const {
    isVirtualized,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    scrollContainerRef,
    scrollToRowIndex
  } = useDiffVirtualScroll({
    totalRows,
    fileKey,
    viewMode,
    patchIdentity: parsed
  })

  const [highlightedRowIndex, setHighlightedRowIndex] = useState<number | null>(null)
  const isSymbolNavEnabled = isSymbolSupportedFile(displayFile.path) && activeSyntaxParser !== null
  const {
    hoveredSymbol,
    clearHover,
    handleLineMouseMove,
    handleLineMouseLeave,
    handleLineClick
  } = useLineSymbolHover({
    isSymbolNavEnabled,
    activeSyntaxParser,
    onSymbolNavigate
  })

  useEffect(() => {
    setHighlightedRowIndex(null)
    clearHover()
  }, [clearHover, fileKey])

  useEffect(() => {
    if (!jumpRequest || jumpRequest.nonce <= 0 || totalRows === 0) {
      return
    }
    const targetSide = jumpRequest.side ?? 'new'
    const matchedIndex =
      viewMode === 'side-by-side'
        ? findDiffJumpRowIndex(
            sideBySideRows,
            (row) =>
              row.kind === 'pair'
                ? {
                    oldLine: row.oldCell?.lineNumber ?? null,
                    newLine: row.newCell?.lineNumber ?? null
                  }
                : null,
            jumpRequest.lineNumber,
            targetSide
          )
        : findDiffJumpRowIndex(
            inlineRows,
            (row) =>
              row.kind === 'line'
                ? { oldLine: row.oldLineNumber, newLine: row.newLineNumber }
                : null,
            jumpRequest.lineNumber,
            targetSide
          )

    if (matchedIndex >= 0) {
      setHighlightedRowIndex(matchedIndex)
      scrollToRowIndex(matchedIndex)
    }
  }, [jumpRequest, totalRows, viewMode, sideBySideRows, inlineRows, scrollToRowIndex])
  const visibleSideBySideRows = isVirtualized
    ? sideBySideRows.slice(startIndex, endIndex)
    : sideBySideRows
  const visibleInlineRows = isVirtualized ? inlineRows.slice(startIndex, endIndex) : inlineRows

  return (
    <section className="git-diff-viewer" aria-label={`${displayFile.path} Diff 뷰어`}>
      <header className="git-diff-header">
        <div className="git-diff-meta">
          <span className={`git-badge git-badge--${getGitFileBadgeModifier(displayFile.status)}`}>
            {displayFile.status}
          </span>
          <span className="git-diff-file-path" title={displayPath}>
            {displayPath}
          </span>
          <span className="git-diff-context-badge">{contextLabel}</span>
        </div>

        <div className="git-diff-actions">
          {navigation && navigation.totalCount > 0 && (
            <div className="git-diff-nav" role="group" aria-label="파일 탐색">
              <button
                type="button"
                className="git-diff-nav-btn"
                aria-label="이전 파일"
                title="이전 파일"
                disabled={navigation.currentIndex <= 1}
                onClick={navigation.onPrevFile}
              >
                ↑
              </button>
              <span className="git-diff-nav-counter">
                {`${navigation.currentIndex} / ${navigation.totalCount}`}
              </span>
              <button
                type="button"
                className="git-diff-nav-btn"
                aria-label="다음 파일"
                title="다음 파일"
                disabled={navigation.currentIndex >= navigation.totalCount}
                onClick={navigation.onNextFile}
              >
                ↓
              </button>
            </div>
          )}
          <div className="git-diff-mode-toggle" role="group" aria-label="Diff 보기 방식">
            <button
              type="button"
              className={`git-diff-toggle-btn${viewMode === 'side-by-side' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'side-by-side'}
              onClick={() => onChangeViewMode('side-by-side')}
            >
              좌우 비교
            </button>
            <button
              type="button"
              className={`git-diff-toggle-btn${viewMode === 'inline' ? ' is-active' : ''}`}
              aria-pressed={viewMode === 'inline'}
              onClick={() => onChangeViewMode('inline')}
            >
              인라인
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm git-diff-open-btn"
            disabled={!canOpenFile}
            onClick={() => onOpenFile?.(displayFile.path)}
          >
            파일 열기
          </button>
        </div>
      </header>

      {loadedDiff?.isTruncated && (
        <div className="git-diff-warning-banner" role="status">
          1MB를 초과하는 대용량 Diff이므로 앞부분 1MB만 표시합니다.
        </div>
      )}

      {state.status === 'loading' ? (
        <div className="git-diff-empty-state">Diff 불러오는 중...</div>
      ) : state.status === 'error' ? (
        <div className="git-diff-empty-state is-error" role="alert">
          {state.errorMessage}
        </div>
      ) : loadedDiff?.isBinary ? (
        <div className="git-diff-empty-state">바이너리 파일은 Diff 미리보기를 지원하지 않습니다.</div>
      ) : !parsed || parsed.hunks.length === 0 ? (
        <div className="git-diff-empty-state">표시할 텍스트 변경 사항이 없습니다.</div>
      ) : viewMode === 'side-by-side' ? (
        <div
          ref={scrollContainerRef}
          className="git-diff-scroll"
          data-testid="diff-side-by-side"
        >
          <table className="git-diff-table git-diff-table--split">
            <colgroup>
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
            </colgroup>
            <VirtualizedDiffBody
              rows={visibleSideBySideRows}
              colSpan={4}
              isVirtualized={isVirtualized}
              startIndex={startIndex}
              topSpacerHeight={topSpacerHeight}
              bottomSpacerHeight={bottomSpacerHeight}
              renderRow={(row, idx, dataRowIndex) =>
                row.kind === 'hunk' ? (
                  <tr
                    key={`hunk-${idx}`}
                    data-row-index={dataRowIndex}
                    className="git-diff-hunk-row"
                  >
                    <td colSpan={4} className="git-diff-hunk-cell">
                      {row.header}
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={`row-${idx}`}
                    data-row-index={dataRowIndex}
                    className={`git-diff-row${highlightedRowIndex === idx ? ' is-jump-highlight' : ''}`}
                  >
                    <SideCell
                      cell={row.oldCell}
                      side="old"
                      filePath={displayFile.path}
                      syntaxParser={activeSyntaxParser}
                      hoveredSymbol={hoveredSymbol}
                      onLineMouseMove={handleLineMouseMove}
                      onLineMouseLeave={handleLineMouseLeave}
                      onLineClick={handleLineClick}
                    />
                    <SideCell
                      cell={row.newCell}
                      side="new"
                      filePath={displayFile.path}
                      syntaxParser={activeSyntaxParser}
                      hoveredSymbol={hoveredSymbol}
                      onLineMouseMove={handleLineMouseMove}
                      onLineMouseLeave={handleLineMouseLeave}
                      onLineClick={handleLineClick}
                    />
                  </tr>
                )
              }
            />
          </table>
        </div>
      ) : (
        <div ref={scrollContainerRef} className="git-diff-scroll" data-testid="diff-inline">
          <table className="git-diff-table git-diff-table--inline">
            <colgroup>
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
            </colgroup>
            <VirtualizedDiffBody
              rows={visibleInlineRows}
              colSpan={3}
              isVirtualized={isVirtualized}
              startIndex={startIndex}
              topSpacerHeight={topSpacerHeight}
              bottomSpacerHeight={bottomSpacerHeight}
              renderRow={(row, idx, dataRowIndex) => {
                if (row.kind === 'hunk') {
                  return (
                    <tr
                      key={`hunk-${idx}`}
                      data-row-index={dataRowIndex}
                      className="git-diff-hunk-row"
                    >
                      <td colSpan={3} className="git-diff-hunk-cell">
                        {row.header}
                      </td>
                    </tr>
                  )
                }
                const inlineSide: 'old' | 'new' = row.lineType === 'delete' ? 'old' : 'new'
                  const inlineLineNumber =
                    inlineSide === 'old' ? row.oldLineNumber : row.newLineNumber
                  const inlineHoverRange =
                    inlineLineNumber !== null &&
                    hoveredSymbol &&
                    hoveredSymbol.lineNumber === inlineLineNumber &&
                    hoveredSymbol.side === inlineSide
                      ? {
                          columnStart: hoveredSymbol.columnStart,
                          columnEnd: hoveredSymbol.columnEnd
                        }
                      : null
                  return (
                    <tr
                      key={`row-${idx}`}
                      data-row-index={dataRowIndex}
                      className={`git-diff-row${DIFF_ROW_TYPE_CLASS[row.lineType]}${highlightedRowIndex === idx ? ' is-jump-highlight' : ''}`}
                    >
                      <td className="git-diff-gutter">{row.oldLineNumber ?? ''}</td>
                      <td className="git-diff-gutter">{row.newLineNumber ?? ''}</td>
                      <td className="git-diff-code">
                        <DiffCodeContent
                          marker={row.marker}
                          content={row.content}
                          wordHighlights={row.wordHighlights}
                          syntaxSpans={
                            row.lineType === 'note'
                              ? undefined
                              : getDiffLineSyntaxSpans(
                                  row.content,
                                  displayFile.path,
                                  activeSyntaxParser
                                )
                          }
                          hoverRange={inlineHoverRange}
                          onMouseMove={
                            inlineLineNumber !== null && row.lineType !== 'note'
                              ? (event) =>
                                  handleLineMouseMove(
                                    row.content,
                                    inlineLineNumber,
                                    inlineSide,
                                    event
                                  )
                              : undefined
                          }
                          onMouseLeave={
                            inlineLineNumber !== null
                              ? () => handleLineMouseLeave(inlineLineNumber, inlineSide)
                              : undefined
                          }
                          onClick={
                            inlineLineNumber !== null && row.lineType !== 'note'
                              ? (event) =>
                                  handleLineClick(
                                    row.content,
                                    inlineLineNumber,
                                    inlineSide,
                                    event
                                  )
                              : undefined
                          }
                        />
                      </td>
                    </tr>
                  )
              }}
            />
          </table>
        </div>
      )}
    </section>
  )
}

export const GitDiffViewer = memo(GitDiffViewerInner, areGitDiffViewerPropsEqual)
