import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import type { CompiledSearchMatcher } from '@shared/search'
import { DEFAULT_SPLIT_RATIO, roundSplitRatio } from '@shared/window'
import type { CodeBlockHighlightSpan, CodeParser } from '../editor/codeBlockHighlight'
import { isSymbolSupportedFile } from '../editor/codeSymbolExtractor'
import {
  type FindHighlightSpan,
  type HoveredSymbolRange,
  renderSyntaxLineWithHover,
  type SymbolNavigateRequest
} from '../editor/symbolHoverDom'
import { isSymbolModifierPressed } from '../editor/symbolNavigation'
import type { DocumentEditorFindControl } from '../hooks/useDocumentEditorFind'
import { groupFindHighlightsByKey, useViewerDocumentFind } from '../hooks/useViewerDocumentFind'
import type { GitDiffViewMode } from '../stores/PaneTabStore'
import {
  clampDiffSplitRatio,
  getDiffSplitColumnWidths,
  getDiffSplitRatioBounds
} from '../utils/diffSplitRatio'
import { SPLITTER_KEYBOARD_STEP } from './SplitSplitter'
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
import { DocumentFindBar } from './DocumentFindBar'

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
  splitRatio?: number
  onChangeSplitRatio?: (nextRatio: number) => void
  isActive?: boolean
  isShortcutDisabled?: boolean
  findControl?: DocumentEditorFindControl
  onChangeViewMode: (nextMode: GitDiffViewMode) => void
  onOpenFile?: (repoRelativePath: string) => void
  onSymbolNavigate?: (request: SymbolNavigateRequest) => void
  onSymbolContextMenu?: (request: SymbolNavigateRequest) => void
  onFindReferences?: (request: SymbolNavigateRequest) => void
  navigation?: GitDiffNavigationProps
  jumpRequest?: DiffJumpRequest | null
}

interface DiffFindMatch {
  rowIndex: number
  side: 'old' | 'new'
  start: number
  end: number
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
  findHighlights,
  syntaxSpans,
  hoverRange,
  onMouseMove,
  onMouseLeave,
  onClick,
  onContextMenu
}: {
  marker: string
  content: string
  wordHighlights?: DiffTextRange[]
  findHighlights?: readonly FindHighlightSpan[]
  syntaxSpans?: CodeBlockHighlightSpan[]
  hoverRange?: { columnStart: number; columnEnd: number } | null
  onMouseMove?: (event: React.MouseEvent<HTMLSpanElement>) => void
  onMouseLeave?: () => void
  onClick?: (event: React.MouseEvent<HTMLSpanElement>) => void
  onContextMenu?: (event: React.MouseEvent<HTMLSpanElement>) => void
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
        onContextMenu={onContextMenu}
      >
        {renderSyntaxLineWithHover(
          content,
          syntaxSpans,
          hoverRange ?? null,
          wordHighlights,
          findHighlights
        )}
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
  findHighlights,
  onLineMouseMove,
  onLineMouseLeave,
  onLineClick,
  onLineContextMenu
}: {
  cell: UnifiedDiffSideCell | null
  side: 'old' | 'new'
  filePath: string
  syntaxParser: CodeParser | null
  hoveredSymbol: HoveredSymbolRange | null
  findHighlights?: readonly FindHighlightSpan[]
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
  onLineContextMenu?: (
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
          findHighlights={findHighlights}
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
          onContextMenu={
            lineNumber !== null && cell.type !== 'note' && onLineContextMenu
              ? (event) => onLineContextMenu(cell.content, lineNumber, side, event)
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
    prev.splitRatio === next.splitRatio &&
    prev.onChangeSplitRatio === next.onChangeSplitRatio &&
    prev.isActive === next.isActive &&
    prev.isShortcutDisabled === next.isShortcutDisabled &&
    prev.findControl === next.findControl &&
    prev.onChangeViewMode === next.onChangeViewMode &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onSymbolNavigate === next.onSymbolNavigate &&
    prev.onSymbolContextMenu === next.onSymbolContextMenu &&
    prev.onFindReferences === next.onFindReferences &&
    prev.jumpRequest === next.jumpRequest &&
    areNavigationPropsEqual(prev.navigation, next.navigation)
  )
}

function measureScrollTableWidth(element: HTMLDivElement | null): number {
  if (!element) {
    return 0
  }
  if (element.clientWidth > 0) {
    return element.clientWidth
  }
  return element.getBoundingClientRect().width
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
  splitRatio,
  onChangeSplitRatio,
  isActive = true,
  isShortcutDisabled = false,
  findControl,
  onChangeViewMode,
  onOpenFile,
  onSymbolNavigate,
  onSymbolContextMenu,
  onFindReferences,
  navigation,
  jumpRequest = null
}: GitDiffViewerProps) {
  const [uncontrolledSplitRatio, setUncontrolledSplitRatio] = useState(DEFAULT_SPLIT_RATIO)
  const [observedScrollElement, setObservedScrollElement] = useState<HTMLDivElement | null>(null)
  const [tableWidth, setTableWidth] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)

  const activeSplitRatio = splitRatio ?? uncontrolledSplitRatio
  const handleChangeSplitRatio = useCallback(
    (nextRatio: number) => {
      if (splitRatio === undefined) {
        setUncontrolledSplitRatio(nextRatio)
      }
      onChangeSplitRatio?.(nextRatio)
    },
    [splitRatio, onChangeSplitRatio]
  )
  const handleChangeSplitRatioRef = useRef(handleChangeSplitRatio)
  handleChangeSplitRatioRef.current = handleChangeSplitRatio

  const { effectiveRatio, leftCodeWidth, rightCodeWidth } = useMemo(
    () => getDiffSplitColumnWidths(activeSplitRatio, tableWidth),
    [activeSplitRatio, tableWidth]
  )
  const splitBounds = useMemo(() => getDiffSplitRatioBounds(tableWidth), [tableWidth])
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
    patchIdentity: parsed,
    layoutKey: viewMode === 'side-by-side' ? effectiveRatio : undefined
  })

  const [highlightedRowIndex, setHighlightedRowIndex] = useState<number | null>(null)
  const isSymbolNavEnabled = isSymbolSupportedFile(displayFile.path) && activeSyntaxParser !== null
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

  const combinedScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollElementRef.current = element
      setObservedScrollElement(element)
      scrollContainerRef(element)
    },
    [scrollContainerRef]
  )

  useEffect(() => {
    if (viewMode !== 'side-by-side' || !observedScrollElement) {
      setTableWidth(0)
      return
    }

    const syncWidth = () => {
      const nextWidth = measureScrollTableWidth(observedScrollElement)
      setTableWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }

    syncWidth()

    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      syncWidth()
    })
    observer.observe(observedScrollElement)
    return () => {
      observer.disconnect()
    }
  }, [observedScrollElement, viewMode])

  useEffect(() => {
    if (!isResizing) {
      return
    }

    const handleMouseMove = (event: MouseEvent): void => {
      const scrollEl = scrollElementRef.current
      const tableEl = tableRef.current ?? scrollEl
      if (!scrollEl || !tableEl) {
        return
      }
      const rect = tableEl.getBoundingClientRect()
      const width = scrollEl.clientWidth > 0 ? scrollEl.clientWidth : rect.width
      if (width <= 0) {
        return
      }
      const rawRatio = (event.clientX - rect.left) / width
      handleChangeSplitRatioRef.current(clampDiffSplitRatio(rawRatio, width))
    }

    const handleDragEnd = (): void => {
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleDragEnd)
    window.addEventListener('blur', handleDragEnd)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleDragEnd)
      window.removeEventListener('blur', handleDragEnd)
    }
  }, [isResizing])

  const handleResizerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const delta = event.key === 'ArrowLeft' ? -SPLITTER_KEYBOARD_STEP : SPLITTER_KEYBOARD_STEP
      handleChangeSplitRatio(clampDiffSplitRatio(effectiveRatio + delta, tableWidth))
    },
    [effectiveRatio, handleChangeSplitRatio, tableWidth]
  )

  const computeDiffMatches = useCallback(
    (matcher: CompiledSearchMatcher): DiffFindMatch[] => {
      const results: DiffFindMatch[] = []
      if (viewMode === 'side-by-side') {
        for (let rowIndex = 0; rowIndex < sideBySideRows.length; rowIndex += 1) {
          const row = sideBySideRows[rowIndex]
          if (row.kind !== 'pair') continue
          if (row.oldCell && row.oldCell.type !== 'note') {
            for (const span of matcher.findMatches(row.oldCell.content)) {
              results.push({ rowIndex, side: 'old', start: span.start, end: span.end })
            }
          }
          if (row.newCell && row.newCell.type !== 'note') {
            for (const span of matcher.findMatches(row.newCell.content)) {
              results.push({ rowIndex, side: 'new', start: span.start, end: span.end })
            }
          }
        }
      } else {
        for (let rowIndex = 0; rowIndex < inlineRows.length; rowIndex += 1) {
          const row = inlineRows[rowIndex]
          if (row.kind !== 'line' || row.lineType === 'note') continue
          const side: 'old' | 'new' = row.lineType === 'delete' ? 'old' : 'new'
          for (const span of matcher.findMatches(row.content)) {
            results.push({ rowIndex, side, start: span.start, end: span.end })
          }
        }
      }
      return results
    },
    [viewMode, sideBySideRows, inlineRows]
  )

  const handleScrollToDiffMatch = useCallback(
    (activeMatch: DiffFindMatch) => {
      scrollToRowIndex(activeMatch.rowIndex)
      return null
    },
    [scrollToRowIndex]
  )

  const {
    matches: findMatches,
    activeMatchIndex,
    findBarProps
  } = useViewerDocumentFind({
    findControl,
    isActive,
    isShortcutDisabled,
    selectionContainerRef: scrollElementRef,
    excludedSelectionSelector:
      '.git-diff-gutter, .git-diff-marker, .git-diff-hunk-row, .document-find-bar',
    computeMatches: computeDiffMatches,
    onScrollToMatch: handleScrollToDiffMatch
  })

  const findHighlightsByCell = useMemo(
    () => groupFindHighlightsByKey(findMatches, activeMatchIndex, (m) => `${m.rowIndex}:${m.side}`),
    [findMatches, activeMatchIndex]
  )
  const visibleSideBySideRows = isVirtualized
    ? sideBySideRows.slice(startIndex, endIndex)
    : sideBySideRows
  const visibleInlineRows = isVirtualized ? inlineRows.slice(startIndex, endIndex) : inlineRows

  return (
    <section
      className="git-diff-viewer"
      aria-label={`${displayFile.path} Diff 뷰어`}
      tabIndex={-1}
      onKeyDown={handleViewerKeyDown}
    >
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

      <div className="viewer-body-container">
        {findBarProps && <DocumentFindBar {...findBarProps} />}
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
        ) : (
          <div className="git-diff-split-body">
            <div
              ref={combinedScrollRef}
              className="git-diff-scroll"
              data-testid={viewMode === 'side-by-side' ? 'diff-side-by-side' : 'diff-inline'}
            >
              {viewMode === 'side-by-side' ? (
                <table ref={tableRef} className="git-diff-table git-diff-table--split">
                  <colgroup>
                    <col className="git-diff-col-gutter" />
                    <col className="git-diff-col-code" style={{ width: leftCodeWidth }} />
                    <col className="git-diff-col-gutter" />
                    <col className="git-diff-col-code" style={{ width: rightCodeWidth }} />
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
                            findHighlights={findHighlightsByCell.get(`${idx}:old`)}
                            onLineMouseMove={handleLineMouseMove}
                            onLineMouseLeave={handleLineMouseLeave}
                            onLineClick={handleLineClick}
                            onLineContextMenu={handleLineContextMenu}
                          />
                          <SideCell
                            cell={row.newCell}
                            side="new"
                            filePath={displayFile.path}
                            syntaxParser={activeSyntaxParser}
                            hoveredSymbol={hoveredSymbol}
                            findHighlights={findHighlightsByCell.get(`${idx}:new`)}
                            onLineMouseMove={handleLineMouseMove}
                            onLineMouseLeave={handleLineMouseLeave}
                            onLineClick={handleLineClick}
                            onLineContextMenu={handleLineContextMenu}
                          />
                        </tr>
                      )
                    }
                  />
                </table>
              ) : (
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
                              findHighlights={findHighlightsByCell.get(`${idx}:${inlineSide}`)}
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
                              onContextMenu={
                                inlineLineNumber !== null && row.lineType !== 'note'
                                  ? (event) =>
                                      handleLineContextMenu(
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
              )}
            </div>
            {viewMode === 'side-by-side' && (
              <div
                role="separator"
                tabIndex={0}
                aria-label="Diff 좌우 비교 비율 조절"
                aria-orientation="vertical"
                aria-valuemin={Math.round(splitBounds.min * 100)}
                aria-valuemax={Math.round(splitBounds.max * 100)}
                aria-valuenow={Math.round(effectiveRatio * 100)}
                className={`git-diff-split-resizer${isResizing ? ' is-dragging' : ''}`}
                style={{
                  left:
                    tableWidth > 0
                      ? `${effectiveRatio * tableWidth}px`
                      : `${roundSplitRatio(effectiveRatio * 100)}%`
                }}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setIsResizing(true)
                }}
                onDoubleClick={() => handleChangeSplitRatio(DEFAULT_SPLIT_RATIO)}
                onKeyDown={handleResizerKeyDown}
              />
            )}
          </div>
        )}
      </div>
    </section>
  )
}

export const GitDiffViewer = memo(GitDiffViewerInner, areGitDiffViewerPropsEqual)
