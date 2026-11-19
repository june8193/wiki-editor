import { memo, useMemo } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderTree,
  List,
  Minus,
  Plus,
  RefreshCw,
  Undo2
} from 'lucide-react'
import type { GitChangedFile } from '@shared/git'
import { canOpenGitChangedFile } from '../utils/gitFilePresentation'
import {
  buildCompressedGitFileTree,
  type GitChangesGroupKey,
  type GitChangesViewMode,
  type GitChangesViewState,
  type GitFileTreeNode
} from '../utils/gitFileTree'
import {
  GitChangedFileRow,
  getGitTreeIndentStyle,
  type GitFileRowActionKind
} from './GitChangedFileRow'

export interface GitChangesHeaderActionsProps {
  viewMode: GitChangesViewMode
  isBusy: boolean
  isCommitDisabled: boolean
  onToggleViewMode: () => void
  onHeaderCommit: () => void
  onRefresh: () => void
}

/**
 * Renders the VS Code icon toolbar (list/tree toggle, Commit ✓, Refresh ↻) on the Changes accordion header.
 */
export const GitChangesHeaderActions = memo(function GitChangesHeaderActions({
  viewMode,
  isBusy,
  isCommitDisabled,
  onToggleViewMode,
  onHeaderCommit,
  onRefresh
}: GitChangesHeaderActionsProps) {
  const viewToggleLabel = viewMode === 'list' ? '트리 보기로 전환' : '리스트 보기로 전환'

  return (
    <div className="git-accordion-actions">
      <button
        type="button"
        className="git-icon-btn"
        aria-label={viewToggleLabel}
        title={viewToggleLabel}
        onClick={onToggleViewMode}
      >
        {viewMode === 'list' ? (
          <FolderTree size={13} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <List size={13} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="git-icon-btn"
        aria-label="변경 사항 커밋"
        title="변경 사항 커밋 (Commit)"
        disabled={isCommitDisabled}
        onClick={onHeaderCommit}
      >
        <Check size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="git-icon-btn"
        aria-label="변경 사항 새로고침"
        title="변경 사항 새로고침"
        disabled={isBusy}
        onClick={onRefresh}
      >
        <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
})

interface GitChangesSubgroupProps {
  groupKey: GitChangesGroupKey
  title: 'Staged Changes' | 'Changes'
  files: readonly GitChangedFile[]
  emptyText?: string
  viewMode: GitChangesViewMode
  isCollapsed: boolean
  collapsedTreeDirs: ReadonlySet<string>
  isBusy: boolean
  repoRoot: string | null
  workspaceRootPath: string | null
  itemAction: GitFileRowActionKind
  bulkActionLabel: string
  onToggleCollapsed: () => void
  onToggleTreeDir: (dirKey: string) => void
  onBulkAction: () => void
  onBulkDiscard?: () => void
  onSelectFile: (file: GitChangedFile) => void
  onOpenWorkspaceFile: (repoRelativePath: string) => void
  onItemAction: (file: GitChangedFile) => void
  onDiscardFile?: (file: GitChangedFile) => void
}

function GitChangesSubgroup({
  groupKey,
  title,
  files,
  emptyText,
  viewMode,
  isCollapsed,
  collapsedTreeDirs,
  isBusy,
  repoRoot,
  workspaceRootPath,
  itemAction,
  bulkActionLabel,
  onToggleCollapsed,
  onToggleTreeDir,
  onBulkAction,
  onBulkDiscard,
  onSelectFile,
  onOpenWorkspaceFile,
  onItemAction,
  onDiscardFile
}: GitChangesSubgroupProps) {
  const treeNodes = useMemo(
    () => (viewMode === 'tree' ? buildCompressedGitFileTree(files) : []),
    [files, viewMode]
  )

  const renderTreeNodes = (nodes: readonly GitFileTreeNode[], depth: number) =>
    nodes.map((node) => {
      if (node.kind === 'file') {
        return (
          <GitChangedFileRow
            key={`${groupKey}:${node.file.status}:${node.file.origPath ?? ''}:${node.file.path}`}
            file={node.file}
            displayMode="tree"
            indentDepth={depth}
            isBusy={isBusy}
            canOpenFile={canOpenGitChangedFile(node.file, repoRoot, workspaceRootPath)}
            itemAction={itemAction}
            onSelectFile={onSelectFile}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            onDiscardFile={onDiscardFile}
            onItemAction={onItemAction}
          />
        )
      }

      const dirKey = `${groupKey}:${node.path}`
      const isDirExpanded = !collapsedTreeDirs.has(dirKey)
      return (
        <li key={`dir:${dirKey}`} className="git-tree-dir-item">
          <button
            type="button"
            className="git-tree-dir-btn"
            aria-expanded={isDirExpanded}
            title={node.path}
            style={getGitTreeIndentStyle(depth)}
            onClick={() => onToggleTreeDir(dirKey)}
          >
            <span className="git-tree-chevron" aria-hidden="true">
              {isDirExpanded ? (
                <ChevronDown size={12} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={12} strokeWidth={1.75} />
              )}
            </span>
            <span className="git-tree-folder-icon" aria-hidden="true">
              {isDirExpanded ? (
                <FolderOpen size={13} strokeWidth={1.75} />
              ) : (
                <Folder size={13} strokeWidth={1.75} />
              )}
            </span>
            <span className="git-tree-dir-label">{node.label}</span>
          </button>
          {isDirExpanded && (
            <ul className="git-file-list" role="list">
              {renderTreeNodes(node.children, depth + 1)}
            </ul>
          )}
        </li>
      )
    })

  return (
    <div className="git-section" role="group" aria-label={title}>
      <div className="git-section-header">
        <button
          type="button"
          className="git-section-toggle"
          aria-expanded={!isCollapsed}
          onClick={onToggleCollapsed}
        >
          <span className="git-section-chevron" aria-hidden="true">
            {isCollapsed ? (
              <ChevronRight size={12} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={12} strokeWidth={1.75} />
            )}
          </span>
          <span className="git-section-title">{title}</span>
        </button>

        <div className="git-section-actions">
          {onBulkDiscard && (
            <button
              type="button"
              className="git-hover-icon-btn"
              aria-label="전체 변경 사항 롤백"
              title="전체 변경 사항 롤백"
              disabled={isBusy || files.length === 0}
              onClick={onBulkDiscard}
            >
              <Undo2 size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="git-hover-icon-btn"
            aria-label={bulkActionLabel}
            title={bulkActionLabel}
            disabled={isBusy || files.length === 0}
            onClick={onBulkAction}
          >
            {itemAction === 'stage' ? (
              <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>

        <span className="git-section-badge">{files.length}</span>
      </div>

      {!isCollapsed &&
        (files.length === 0 ? (
          emptyText ? <p className="git-empty-subtext">{emptyText}</p> : null
        ) : (
          <ul className="git-file-list" role="list">
            {viewMode === 'tree'
              ? renderTreeNodes(treeNodes, 0)
              : files.map((file) => (
                  <GitChangedFileRow
                    key={`${groupKey}:${file.status}:${file.origPath ?? ''}:${file.path}`}
                    file={file}
                    displayMode="list"
                    isBusy={isBusy}
                    canOpenFile={canOpenGitChangedFile(file, repoRoot, workspaceRootPath)}
                    itemAction={itemAction}
                    onSelectFile={onSelectFile}
                    onOpenWorkspaceFile={onOpenWorkspaceFile}
                    onDiscardFile={onDiscardFile}
                    onItemAction={onItemAction}
                  />
                ))}
          </ul>
        ))}
    </div>
  )
}

export interface GitChangesFileGroupsProps {
  stagedFiles: readonly GitChangedFile[]
  unstagedAndUntracked: readonly GitChangedFile[]
  viewState: GitChangesViewState
  isBusy: boolean
  repoRoot: string | null
  workspaceRootPath: string | null
  onToggleGroupCollapsed: (group: GitChangesGroupKey) => void
  onToggleTreeDir: (dirKey: string) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardAll: () => void
  onSelectStagedFile: (file: GitChangedFile) => void
  onSelectWorkingFile: (file: GitChangedFile) => void
  onOpenWorkspaceFile: (repoRelativePath: string) => void
  onStageFile: (file: GitChangedFile) => void
  onUnstageFile: (file: GitChangedFile) => void
  onDiscardFile: (file: GitChangedFile) => void
}

/**
 * Renders the collapsible `Staged Changes` (auto-hidden when empty) and `Changes` subgroups
 * in either flat list mode or path-compressed folder tree mode.
 */
export const GitChangesFileGroups = memo(function GitChangesFileGroups({
  stagedFiles,
  unstagedAndUntracked,
  viewState,
  isBusy,
  repoRoot,
  workspaceRootPath,
  onToggleGroupCollapsed,
  onToggleTreeDir,
  onStageAll,
  onUnstageAll,
  onDiscardAll,
  onSelectStagedFile,
  onSelectWorkingFile,
  onOpenWorkspaceFile,
  onStageFile,
  onUnstageFile,
  onDiscardFile
}: GitChangesFileGroupsProps) {
  return (
    <>
      {stagedFiles.length > 0 && (
        <GitChangesSubgroup
          groupKey="staged"
          title="Staged Changes"
          files={stagedFiles}
          viewMode={viewState.viewMode}
          isCollapsed={viewState.isStagedCollapsed}
          collapsedTreeDirs={viewState.collapsedTreeDirs}
          isBusy={isBusy}
          repoRoot={repoRoot}
          workspaceRootPath={workspaceRootPath}
          itemAction="unstage"
          bulkActionLabel="전체 Unstage"
          onToggleCollapsed={() => onToggleGroupCollapsed('staged')}
          onToggleTreeDir={onToggleTreeDir}
          onBulkAction={onUnstageAll}
          onSelectFile={onSelectStagedFile}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onItemAction={onUnstageFile}
        />
      )}

      <GitChangesSubgroup
        groupKey="changes"
        title="Changes"
        files={unstagedAndUntracked}
        emptyText="변경된 파일 없음"
        viewMode={viewState.viewMode}
        isCollapsed={viewState.isChangesCollapsed}
        collapsedTreeDirs={viewState.collapsedTreeDirs}
        isBusy={isBusy}
        repoRoot={repoRoot}
        workspaceRootPath={workspaceRootPath}
        itemAction="stage"
        bulkActionLabel="전체 Stage"
        onToggleCollapsed={() => onToggleGroupCollapsed('changes')}
        onToggleTreeDir={onToggleTreeDir}
        onBulkAction={onStageAll}
        onBulkDiscard={onDiscardAll}
        onSelectFile={onSelectWorkingFile}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onItemAction={onStageFile}
        onDiscardFile={onDiscardFile}
      />
    </>
  )
})
