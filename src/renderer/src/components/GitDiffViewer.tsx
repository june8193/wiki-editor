import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import type { CodeBlockHighlightSpan, CodeParser } from '../editor/codeBlockHighlight'
import type { GitDiffViewMode } from '../stores/PaneTabStore'
import {
  getDiffLineSyntaxSpans,
  loadDiffLanguageParser,
  resolveDiffLanguageParserSync
} from '../utils/diffSyntaxHighlight'
import {
  formatGitFileLabel,
  getGitDiffContextLabel,
  getGitFileBadgeModifier
} from '../utils/gitFilePresentation'
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

interface GitDiffViewerProps {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
  state: GitDiffContentState
  onChangeViewMode: (nextMode: GitDiffViewMode) => void
  onOpenFile?: (repoRelativePath: string) => void
  navigation?: GitDiffNavigationProps
}

const DIFF_ROW_TYPE_CLASS: Record<UnifiedDiffSideCell['type'], string> = {
  context: '',
  delete: ' is-delete',
  add: ' is-add',
  note: ' is-note'
}

function addRangeBoundaries(
  boundarySet: Set<number>,
  ranges: readonly { from: number; to: number }[] | undefined,
  maxLength: number
): void {
  if (!ranges) {
    return
  }
  for (const range of ranges) {
    if (range.from >= 0 && range.from <= maxLength) {
      boundarySet.add(range.from)
    }
    if (range.to >= 0 && range.to <= maxLength) {
      boundarySet.add(range.to)
    }
  }
}

function renderHighlightedContent(
  content: string,
  wordHighlights?: DiffTextRange[],
  syntaxSpans?: CodeBlockHighlightSpan[]
) {
  if (!content) {
    return content
  }
  const hasWordHighlights = Boolean(wordHighlights && wordHighlights.length > 0)
  const hasSyntaxSpans = Boolean(syntaxSpans && syntaxSpans.length > 0)
  if (!hasWordHighlights && !hasSyntaxSpans) {
    return content
  }

  const boundarySet = new Set<number>([0, content.length])
  addRangeBoundaries(boundarySet, wordHighlights, content.length)
  addRangeBoundaries(boundarySet, syntaxSpans, content.length)

  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)
  const nodes: ReactNode[] = []

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const segFrom = boundaries[i]
    const segTo = boundaries[i + 1]
    if (segTo <= segFrom) {
      continue
    }
    const text = content.slice(segFrom, segTo)
    const isWordChanged =
      wordHighlights?.some((range) => range.from <= segFrom && segTo <= range.to) ?? false
    const syntaxClass =
      syntaxSpans?.find((span) => span.from <= segFrom && segTo <= span.to)?.className ?? null

    if (isWordChanged) {
      nodes.push(
        <mark
          key={i}
          className={
            syntaxClass ? `git-diff-word-highlight ${syntaxClass}` : 'git-diff-word-highlight'
          }
        >
          {text}
        </mark>
      )
    } else if (syntaxClass) {
      nodes.push(
        <span key={i} className={syntaxClass}>
          {text}
        </span>
      )
    } else {
      nodes.push(text)
    }
  }

  return nodes
}

function DiffCodeContent({
  marker,
  content,
  wordHighlights,
  syntaxSpans
}: {
  marker: string
  content: string
  wordHighlights?: DiffTextRange[]
  syntaxSpans?: CodeBlockHighlightSpan[]
}) {
  return (
    <>
      <span className="git-diff-marker" aria-hidden="true">
        {marker}
      </span>
      <span className="git-diff-line-text">
        {renderHighlightedContent(content, wordHighlights, syntaxSpans)}
      </span>
    </>
  )
}

function SideCell({
  cell,
  side,
  filePath,
  syntaxParser
}: {
  cell: UnifiedDiffSideCell | null
  side: 'old' | 'new'
  filePath: string
  syntaxParser: CodeParser | null
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
        />
      </td>
    </>
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
    areNavigationPropsEqual(prev.navigation, next.navigation)
  )
}

function GitDiffViewerInner({
  request,
  viewMode,
  state,
  onChangeViewMode,
  onOpenFile,
  navigation
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
        <div className="git-diff-scroll" data-testid="diff-side-by-side">
          <table className="git-diff-table git-diff-table--split">
            <colgroup>
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
            </colgroup>
            <tbody>
              {sideBySideRows.map((row, idx) =>
                row.kind === 'hunk' ? (
                  <tr key={`hunk-${idx}`} className="git-diff-hunk-row">
                    <td colSpan={4} className="git-diff-hunk-cell">
                      {row.header}
                    </td>
                  </tr>
                ) : (
                  <tr key={`row-${idx}`} className="git-diff-row">
                    <SideCell
                      cell={row.oldCell}
                      side="old"
                      filePath={displayFile.path}
                      syntaxParser={activeSyntaxParser}
                    />
                    <SideCell
                      cell={row.newCell}
                      side="new"
                      filePath={displayFile.path}
                      syntaxParser={activeSyntaxParser}
                    />
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="git-diff-scroll" data-testid="diff-inline">
          <table className="git-diff-table git-diff-table--inline">
            <colgroup>
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-gutter" />
              <col className="git-diff-col-code" />
            </colgroup>
            <tbody>
              {inlineRows.map((row, idx) =>
                row.kind === 'hunk' ? (
                  <tr key={`hunk-${idx}`} className="git-diff-hunk-row">
                    <td colSpan={3} className="git-diff-hunk-cell">
                      {row.header}
                    </td>
                  </tr>
                ) : (
                  <tr key={`row-${idx}`} className={`git-diff-row${DIFF_ROW_TYPE_CLASS[row.lineType]}`}>
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
                      />
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export const GitDiffViewer = memo(GitDiffViewerInner, areGitDiffViewerPropsEqual)
