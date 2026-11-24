import { useMemo } from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import type { GitCompareChangedFile } from '@shared/git'
import {
  filterCompareFiles,
  type ComparePanelActions,
  type ComparePanelState
} from '../stores/CompareSession'
import {
  formatGitChangedFileDisplay,
  formatGitTimestamp,
  getGitFileStatusDisplay
} from '../utils/gitFilePresentation'
import { buildCompressedGitFileTree, type GitFileTreeNode } from '../utils/gitFileTree'
import { CompareRefPicker } from './CompareRefPicker'
import { getGitTreeIndentStyle } from './GitChangedFileRow'
import { GitCommitDetailPanel } from './GitDetailPanel'

export interface CompareSidebarPanelProps {
  state: ComparePanelState
  isRepo: boolean | null
  actions: ComparePanelActions
}

/**
 * Left sidebar panel for comparing branches and worktrees (`Base` vs `Compare`)
 * with 3-dot/2-dot mode switching and compressed file tree diff navigation.
 */
export function CompareSidebarPanel({ state, isRepo, actions }: CompareSidebarPanelProps) {
  const hasWorkspace = state.workspaceRootPath !== null
  const isBusy = state.isLoadingRefs || state.isLoadingSummary
  const canCompare = hasWorkspace && isRepo === true

  const filteredFiles = useMemo(
    () => (state.summary ? filterCompareFiles(state.summary.files, state.fileFilter) : []),
    [state.summary, state.fileFilter]
  )
  const treeNodes = useMemo(() => buildCompressedGitFileTree(filteredFiles), [filteredFiles])

  const renderTreeNodes = (nodes: readonly GitFileTreeNode<GitCompareChangedFile>[], depth: number) =>
    nodes.map((node) => {
      if (node.kind === 'dir') {
        const isCollapsed = state.collapsedTreeDirs.has(node.path)
        return (
          <div key={`dir:${node.path}`} className="git-tree-branch">
            <button
              type="button"
              className="git-tree-dir-row"
              style={getGitTreeIndentStyle(depth)}
              aria-expanded={!isCollapsed}
              title={node.path}
              onClick={() => actions.toggleTreeDirCollapsed(node.path)}
            >
              <span className="git-tree-chevron" aria-hidden="true">
                {isCollapsed ? (
                  <ChevronRight size={12} strokeWidth={1.75} />
                ) : (
                  <ChevronDown size={12} strokeWidth={1.75} />
                )}
              </span>
              <span className="git-tree-folder-icon" aria-hidden="true">
                {isCollapsed ? (
                  <Folder size={13} strokeWidth={1.75} />
                ) : (
                  <FolderOpen size={13} strokeWidth={1.75} />
                )}
              </span>
              <span className="git-tree-dir-label">{node.label}</span>
            </button>
            {!isCollapsed && renderTreeNodes(node.children, depth + 1)}
          </div>
        )
      }

      const { file } = node
      const display = formatGitChangedFileDisplay(file)
      const statusDisplay = getGitFileStatusDisplay(file.status)
      return (
        <button
          key={`file:${file.origPath ?? ''}:${file.path}`}
          type="button"
          className="compare-file-row"
          style={getGitTreeIndentStyle(depth)}
          title={display.tooltip}
          onClick={() => actions.openCompareFileDiff(file)}
        >
          <FileText size={13} strokeWidth={1.75} className="git-file-icon" aria-hidden="true" />
          <span
            className={`compare-file-name${statusDisplay.strikethrough ? ' is-deleted' : ''}`}
          >
            {display.fileName}
          </span>
          <span className="compare-file-stats">
            {file.isBinary ? (
              <span className="compare-stat-binary">Binary</span>
            ) : (
              <>
                {file.additions !== null && file.additions > 0 && (
                  <span className="compare-stat-add">+{file.additions}</span>
                )}
                {file.deletions !== null && file.deletions > 0 && (
                  <span className="compare-stat-del">-{file.deletions}</span>
                )}
              </>
            )}
          </span>
          <span
            className={`git-file-status-letter is-${statusDisplay.tone}`}
            title={statusDisplay.label}
          >
            {statusDisplay.displayCode}
          </span>
        </button>
      )
    })

  return (
    <section className="sidebar-panel compare-panel" aria-label="브랜치 비교">
      <header className="sidebar-header compare-panel-header">
        <span className="sidebar-title">Compare</span>
        {canCompare && (
          <div className="git-header-actions">
            <button
              type="button"
              className="git-icon-btn"
              aria-label="비교 새로고침"
              title="새로고침"
              disabled={isBusy}
              onClick={() => void actions.refresh()}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      {!hasWorkspace && (
        <div className="git-empty-state">
          <p>열린 워크스페이스가 없습니다.</p>
          <p className="git-empty-hint">
            워크스페이스 뷰에서 폴더를 열어 브랜치 비교를 시작할 수 있습니다.
          </p>
        </div>
      )}

      {hasWorkspace && isRepo === false && (
        <div className="git-empty-state">
          <p>현재 워크스페이스는 Git 저장소가 아닙니다.</p>
          <p className="git-empty-hint">
            Git 뷰에서 저장소를 초기화한 뒤 브랜치를 비교할 수 있습니다.
          </p>
        </div>
      )}

      {canCompare && (
        <div className="compare-panel-body">
          {state.errorMessage && (
            <div className="git-error-banner" role="alert">
              <span>{state.errorMessage}</span>
              <button
                type="button"
                className="git-error-dismiss"
                aria-label="오류 닫기"
                onClick={actions.dismissError}
              >
                ×
              </button>
            </div>
          )}

          <div className="compare-controls">
            <div className="compare-ref-row">
              <CompareRefPicker
                label="Base"
                triggerAriaLabel="Base 기준 Ref 선택"
                dialogAriaLabel="Base Ref 선택"
                refs={state.refs}
                selectedRef={state.baseRef}
                disabled={isBusy}
                onSelectRef={actions.selectBaseRef}
              />

              <button
                type="button"
                className="git-icon-btn compare-swap-btn"
                aria-label="Base와 Compare 맞바꾸기"
                title="Base와 Compare 맞바꾸기"
                disabled={isBusy || !state.baseRef || !state.compareRef}
                onClick={actions.swapRefs}
              >
                <ArrowLeftRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>

              <CompareRefPicker
                label="Compare"
                triggerAriaLabel="Compare 대상 Ref 선택"
                dialogAriaLabel="Compare Ref 선택"
                refs={state.refs}
                selectedRef={state.compareRef}
                disabled={isBusy}
                onSelectRef={actions.selectCompareRef}
              />
            </div>

            <div className="compare-mode-toggle" role="group" aria-label="비교 방식">
              <button
                type="button"
                className={`compare-mode-btn${state.mode === 'three-dot' ? ' is-active' : ''}`}
                aria-pressed={state.mode === 'three-dot'}
                disabled={isBusy}
                onClick={() => actions.setMode('three-dot')}
              >
                3-dot (PR 방식)
              </button>
              <button
                type="button"
                className={`compare-mode-btn${state.mode === 'two-dot' ? ' is-active' : ''}`}
                aria-pressed={state.mode === 'two-dot'}
                disabled={isBusy}
                onClick={() => actions.setMode('two-dot')}
              >
                2-dot (직접 비교)
              </button>
            </div>
          </div>

          {state.summary && (
            <>
              <div className="compare-summary-bar" role="status" aria-label="비교 요약">
                <span className="compare-summary-files">
                  {state.summary.files.length === 1
                    ? '1 file changed'
                    : `${state.summary.files.length} files changed`}
                </span>
                <span className="compare-summary-diffstats">
                  <span className="compare-stat-add">+{state.summary.totalAdditions}</span>
                  <span className="compare-stat-del">-{state.summary.totalDeletions}</span>
                </span>
              </div>

              <div className="compare-subtabs" role="tablist" aria-label="비교 보기 전환">
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.subTab === 'files'}
                  className={`compare-subtab-btn${state.subTab === 'files' ? ' is-active' : ''}`}
                  onClick={() => actions.setSubTab('files')}
                >
                  Files ({state.summary.files.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.subTab === 'commits'}
                  className={`compare-subtab-btn${state.subTab === 'commits' ? ' is-active' : ''}`}
                  onClick={() => actions.setSubTab('commits')}
                >
                  Commits ({state.summary.commits.length})
                </button>
              </div>

              {state.subTab === 'files' ? (
                <div className="compare-files-section">
                  <div className="compare-filter-wrap">
                    <Search size={13} strokeWidth={1.75} className="compare-filter-icon" aria-hidden="true" />
                    <input
                      type="text"
                      className="compare-filter-input"
                      aria-label="변경 파일 필터"
                      placeholder="파일명 또는 경로 필터..."
                      value={state.fileFilter}
                      onChange={(event) => actions.setFileFilter(event.target.value)}
                    />
                    {state.fileFilter && (
                      <button
                        type="button"
                        className="compare-filter-clear"
                        aria-label="필터 지우기"
                        onClick={() => actions.setFileFilter('')}
                      >
                        <X size={12} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  <div className="compare-files-tree" role="region" aria-label="변경 파일 목록">
                    {state.summary.files.length === 0 ? (
                      <p className="compare-files-empty">두 Ref 사이에 변경된 파일이 없습니다.</p>
                    ) : treeNodes.length === 0 ? (
                      <p className="compare-files-empty">필터와 일치하는 파일이 없습니다.</p>
                    ) : (
                      renderTreeNodes(treeNodes, 0)
                    )}
                  </div>
                </div>
              ) : (
                <div className="compare-commits-section" role="region" aria-label="비교 커밋 목록">
                  {state.summary.commits.length === 0 ? (
                    <p className="compare-files-empty">비교 범위에 포함된 커밋이 없습니다.</p>
                  ) : (
                    <ul className="compare-commit-list">
                      {state.summary.commits.map((commit) => {
                        const isExpanded =
                          state.commitDetail.status !== 'idle' &&
                          state.commitDetail.selectedHash === commit.hash
                        return (
                          <li
                            key={commit.hash}
                            className={`compare-commit-item${isExpanded ? ' is-expanded' : ''}`}
                          >
                            <button
                              type="button"
                              className="compare-commit-row-btn"
                              aria-expanded={isExpanded}
                              onClick={() => actions.toggleCommitDetail(commit.hash)}
                            >
                              <div className="compare-commit-row-top">
                                <code className="compare-commit-hash">{commit.shortHash}</code>
                                <span className="compare-commit-subject">{commit.subject}</span>
                              </div>
                              <div className="compare-commit-row-meta">
                                <span className="compare-commit-author">{commit.authorName}</span>
                                <span className="compare-commit-date">
                                  {formatGitTimestamp(commit.committedAt)}
                                </span>
                              </div>
                            </button>
                            {isExpanded && (
                              <GitCommitDetailPanel
                                shortHash={commit.shortHash}
                                detailState={state.commitDetail}
                                onOpenFileDiff={actions.openCommitFileDiff}
                              />
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
