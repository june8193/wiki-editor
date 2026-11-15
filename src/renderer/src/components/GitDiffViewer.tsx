import { useMemo } from 'react'
import type { GitDiffRequest, GitFileDiff } from '@shared/git'
import type { GitDiffViewMode } from '../stores/PaneTabStore'
import {
  formatGitFileLabel,
  getGitDiffContextLabel,
  getGitFileBadgeModifier
} from '../utils/gitFilePresentation'
import {
  buildInlineDiffRows,
  buildSideBySideDiffRows,
  parseUnifiedDiff,
  type UnifiedDiffSideCell
} from '../utils/unifiedDiff'

export type GitDiffContentState =
  | { status: 'loading' }
  | { status: 'loaded'; diff: GitFileDiff }
  | { status: 'error'; errorMessage: string }

interface GitDiffViewerProps {
  request: GitDiffRequest
  viewMode: GitDiffViewMode
  state: GitDiffContentState
  onChangeViewMode: (nextMode: GitDiffViewMode) => void
  onOpenFile: (repoRelativePath: string) => void
}

function SideCell({ cell, side }: { cell: UnifiedDiffSideCell | null; side: 'old' | 'new' }) {
  if (!cell) {
    return (
      <>
        <td className={`git-diff-gutter is-empty is-${side}`} />
        <td className={`git-diff-code is-empty is-${side}`} />
      </>
    )
  }

  const lineClass =
    cell.type === 'delete'
      ? ' is-delete'
      : cell.type === 'add'
        ? ' is-add'
        : cell.type === 'note'
          ? ' is-note'
          : ''

  return (
    <>
      <td className={`git-diff-gutter${lineClass} is-${side}`}>
        {cell.lineNumber ?? ''}
      </td>
      <td className={`git-diff-code${lineClass} is-${side}`}>
        <span className="git-diff-marker" aria-hidden="true">
          {cell.marker}
        </span>
        <span className="git-diff-line-text">{cell.content}</span>
      </td>
    </>
  )
}

export function GitDiffViewer({
  request,
  viewMode,
  state,
  onChangeViewMode,
  onOpenFile
}: GitDiffViewerProps) {
  const loadedDiff = state.status === 'loaded' ? state.diff : null
  const displayFile = loadedDiff ?? request
  const displayPath = formatGitFileLabel(displayFile)
  const contextLabel = getGitDiffContextLabel(request)
  const canOpenFile = loadedDiff?.existsInWorkspace === true

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
            onClick={() => onOpenFile(displayFile.path)}
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
                    <SideCell cell={row.oldCell} side="old" />
                    <SideCell cell={row.newCell} side="new" />
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
                  <tr
                    key={`row-${idx}`}
                    className={`git-diff-row${
                      row.lineType === 'delete'
                        ? ' is-delete'
                        : row.lineType === 'add'
                          ? ' is-add'
                          : row.lineType === 'note'
                            ? ' is-note'
                            : ''
                    }`}
                  >
                    <td className="git-diff-gutter">{row.oldLineNumber ?? ''}</td>
                    <td className="git-diff-gutter">{row.newLineNumber ?? ''}</td>
                    <td className="git-diff-code">
                      <span className="git-diff-marker" aria-hidden="true">
                        {row.marker}
                      </span>
                      <span className="git-diff-line-text">{row.content}</span>
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
