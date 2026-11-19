import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import {
  Check,
  ChevronDown,
  CloudUpload,
  GitBranch,
  MoreHorizontal,
  RefreshCw
} from 'lucide-react'
import {
  getGitChangedCount,
  type GitBranchInfo,
  type GitBranchList,
  type GitChangedFile,
  type GitDiffRequest,
  type GitLogScope,
  type GitStatus
} from '@shared/git'
import { useDismissable } from '../hooks/useDismissable'
import type { GitGraphState } from '../hooks/useGitGraphLog'
import { toGitDiffRequest } from '../utils/gitFilePresentation'
import { computeGitSectionLayout, type GitPanelSplitState } from '../utils/gitPanelSplit'
import { GitFileTriggerButton } from './GitFileTriggerButton'
import { GitGraphScopeToggle, GitGraphSection } from './GitGraphSection'
import { GitSectionResizer } from './GitSectionResizer'

export interface GitSidebarPanelProps {
  workspaceRootPath: string | null
  status: GitStatus | null
  branchList: GitBranchList | null
  graphState: GitGraphState
  pendingAction: string | null
  errorMessage: string | null
  splitState: GitPanelSplitState
  onDismissError: () => void
  onRefresh: () => void
  onChangeLogScope: (nextScope: GitLogScope) => void
  onLoadMoreCommits: () => void
  onToggleCommitDetail: (commitHash: string) => void
  onInitRepo: () => void
  onStageFile: (path: string) => void
  onStageAll: () => void
  onUnstageFile: (path: string, origPath?: string) => void
  onUnstageAll: () => void
  onDiscardFile: (path: string) => void
  onDiscardAll: () => void
  onCommit: (message: string) => Promise<boolean> | boolean
  onCheckoutBranch: (branchName: string) => void
  onPull: () => void
  onPush: () => void
  onFetch: () => void
  onSync: () => void
  onOpenFileDiff: (request: GitDiffRequest) => void
  onToggleChangesCollapsed: () => void
  onToggleGraphCollapsed: () => void
  onResizeChangesRatio: (nextRatio: number) => void
}

/**
 * Manages popover open/close state with outside-click/Escape dismissal and workspace/disabled resets.
 */
function useMenuPopover(isDisabled: boolean, resetKey: string | null) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback((): void => {
    setIsOpen(false)
  }, [])

  useDismissable(isOpen, containerRef, close)

  useEffect(() => {
    if (isDisabled) {
      setIsOpen(false)
    }
  }, [isDisabled])

  useEffect(() => {
    setIsOpen(false)
  }, [resetKey])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape' && isOpen) {
        event.stopPropagation()
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    },
    [isOpen]
  )

  return { isOpen, setIsOpen, close, containerRef, triggerRef, handleKeyDown }
}

function getSectionFlexStyle(flexRatio: number | null): CSSProperties | undefined {
  return flexRatio !== null ? { flex: `${flexRatio} 1 0%` } : undefined
}

interface GitFileSectionProps {
  title: string
  files: readonly GitChangedFile[]
  emptyText: string
  bulkButtonText: string
  bulkAriaLabel: string
  itemActionSymbol: '+' | '-'
  itemActionTitle: 'Stage' | 'Unstage'
  isBusy: boolean
  onBulkAction: () => void
  onBulkDiscard?: () => void
  onSelectFile: (file: GitChangedFile) => void
  onItemAction: (file: GitChangedFile) => void
  onDiscardFile?: (file: GitChangedFile) => void
}

function GitFileSection({
  title,
  files,
  emptyText,
  bulkButtonText,
  bulkAriaLabel,
  itemActionSymbol,
  itemActionTitle,
  isBusy,
  onBulkAction,
  onBulkDiscard,
  onSelectFile,
  onItemAction,
  onDiscardFile
}: GitFileSectionProps) {
  return (
    <div className="git-section">
      <div className="git-section-header">
        <span className="git-section-title">
          {title} ({files.length})
        </span>
        <div className="git-section-actions">
          {onBulkDiscard && (
            <button
              type="button"
              className="git-section-action-btn"
              aria-label="전체 변경 사항 롤백"
              title="전체 변경 사항 롤백"
              disabled={isBusy || files.length === 0}
              onClick={onBulkDiscard}
            >
              전체 ↶
            </button>
          )}
          <button
            type="button"
            className="git-section-action-btn"
            aria-label={bulkAriaLabel}
            title={bulkAriaLabel}
            disabled={isBusy || files.length === 0}
            onClick={onBulkAction}
          >
            {bulkButtonText}
          </button>
        </div>
      </div>
      {files.length === 0 ? (
        <p className="git-empty-subtext">{emptyText}</p>
      ) : (
        <ul className="git-file-list" role="list">
          {files.map((file) => (
            <li key={`${itemActionTitle}:${file.status}:${file.path}`} className="git-file-item">
              <GitFileTriggerButton file={file} onClick={() => onSelectFile(file)} />
              {onDiscardFile && (
                <button
                  type="button"
                  className="git-file-action-btn"
                  aria-label={`${file.path} 변경 사항 롤백`}
                  title="변경 사항 롤백"
                  disabled={isBusy}
                  onClick={() => onDiscardFile(file)}
                >
                  ↶
                </button>
              )}
              <button
                type="button"
                className="git-file-action-btn"
                aria-label={`${file.path} ${itemActionTitle}`}
                title={itemActionTitle}
                disabled={isBusy}
                onClick={() => onItemAction(file)}
              >
                {itemActionSymbol}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface GitCommonBannersProps {
  pendingAction: string | null
  errorMessage: string | null
  onDismissError: () => void
}

function GitCommonBanners({ pendingAction, errorMessage, onDismissError }: GitCommonBannersProps) {
  return (
    <>
      {pendingAction && (
        <div className="git-loading-banner" role="status" aria-live="polite">
          {pendingAction} 실행 중...
        </div>
      )}

      {errorMessage && (
        <div className="git-error-banner" role="alert">
          <span className="git-error-text">{errorMessage}</span>
          <button
            type="button"
            className="git-error-close-btn"
            aria-label="Git 오류 닫기"
            onClick={onDismissError}
          >
            ×
          </button>
        </div>
      )}
    </>
  )
}

interface GitAccordionSectionProps {
  title: string
  badgeCount?: number
  headerActions?: ReactNode
  isExpanded: boolean
  flexRatio: number | null
  onToggle: () => void
  children: ReactNode
}

function GitAccordionSection({
  title,
  badgeCount,
  headerActions,
  isExpanded,
  flexRatio,
  onToggle,
  children
}: GitAccordionSectionProps) {
  return (
    <section
      className={`git-accordion-section${isExpanded ? '' : ' is-collapsed'}`}
      aria-label={title}
      style={getSectionFlexStyle(flexRatio)}
    >
      <div className="git-accordion-header">
        <button
          type="button"
          className="git-accordion-toggle"
          aria-expanded={isExpanded}
          onClick={onToggle}
        >
          <span className="git-accordion-chevron" aria-hidden="true">
            {isExpanded ? '▾' : '▸'}
          </span>
          <span className="git-accordion-title">{title}</span>
          {badgeCount !== undefined && <span className="git-accordion-badge">{badgeCount}</span>}
        </button>
        {headerActions}
      </div>
      {isExpanded && <div className="git-accordion-body">{children}</div>}
    </section>
  )
}

interface GitPanelHeaderProps {
  workspaceRootPath: string | null
  isRepo: boolean
  isBusy: boolean
  hasStaged: boolean
  hasUnstagedOrUntracked: boolean
  onRefresh: () => void
  onPull: () => void
  onPush: () => void
  onFetch: () => void
  onSync: () => void
  onStageAll: () => void
  onUnstageAll: () => void
  onDiscardAll: () => void
}

/**
 * Renders the top Git panel header ("Source Control") with refresh and the overflow (...) actions menu.
 */
function GitPanelHeader({
  workspaceRootPath,
  isRepo,
  isBusy,
  hasStaged,
  hasUnstagedOrUntracked,
  onRefresh,
  onPull,
  onPush,
  onFetch,
  onSync,
  onStageAll,
  onUnstageAll,
  onDiscardAll
}: GitPanelHeaderProps) {
  const isMoreDisabled = !workspaceRootPath || !isRepo || isBusy
  const moreMenu = useMenuPopover(isMoreDisabled, workspaceRootPath)

  const moreMenuEntries: ReadonlyArray<
    | { kind: 'separator'; key: string }
    | {
        kind: 'item'
        label: string
        disabled: boolean
        danger?: boolean
        onSelect: () => void
      }
  > = [
    { kind: 'item', label: 'Pull', disabled: isBusy, onSelect: onPull },
    { kind: 'item', label: 'Push', disabled: isBusy, onSelect: onPush },
    { kind: 'item', label: 'Fetch', disabled: isBusy, onSelect: onFetch },
    { kind: 'item', label: 'Sync', disabled: isBusy, onSelect: onSync },
    { kind: 'separator', key: 'remote-changes-divider' },
    {
      kind: 'item',
      label: 'Stage All Changes',
      disabled: isBusy || !hasUnstagedOrUntracked,
      onSelect: onStageAll
    },
    {
      kind: 'item',
      label: 'Unstage All Changes',
      disabled: isBusy || !hasStaged,
      onSelect: onUnstageAll
    },
    {
      kind: 'item',
      label: 'Discard All Changes',
      disabled: isBusy || !hasUnstagedOrUntracked,
      danger: true,
      onSelect: onDiscardAll
    }
  ]

  return (
    <div className="git-header">
      <span className="git-header-title">Source Control</span>
      <div className="git-header-actions">
        <button
          type="button"
          className="git-icon-btn"
          aria-label="Git 상태 새로고침"
          title="Git 상태 새로고침"
          disabled={!workspaceRootPath || isBusy}
          onClick={onRefresh}
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <div
          ref={moreMenu.containerRef}
          className="git-menu-anchor"
          onKeyDown={moreMenu.handleKeyDown}
        >
          <button
            ref={moreMenu.triggerRef}
            type="button"
            className="git-icon-btn"
            aria-label="더 보기"
            title="더 보기"
            aria-haspopup="menu"
            aria-expanded={moreMenu.isOpen}
            disabled={isMoreDisabled}
            onClick={() => moreMenu.setIsOpen((open) => !open)}
          >
            <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>

          {moreMenu.isOpen && (
            <div
              className="git-popover-menu git-more-menu"
              role="menu"
              aria-label="Git 패널 추가 작업"
            >
              {moreMenuEntries.map((entry) =>
                entry.kind === 'separator' ? (
                  <div key={entry.key} className="git-menu-separator" role="separator" />
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitem"
                    className={`git-popover-menu-item${entry.danger ? ' is-danger' : ''}`}
                    disabled={entry.disabled}
                    onClick={() => {
                      moreMenu.close()
                      entry.onSelect()
                    }}
                  >
                    {entry.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface GitBranchSubrowProps {
  workspaceRootPath: string | null
  status: GitStatus
  branches: readonly GitBranchInfo[]
  isBusy: boolean
  onCheckoutBranch: (branchName: string) => void
  onPush: () => void
  onSync: () => void
}

/**
 * Renders the 26px branch subrow with an immediate branch picker on the left and a remote Sync/Publish trigger on the right.
 */
function GitBranchSubrow({
  workspaceRootPath,
  status,
  branches,
  isBusy,
  onCheckoutBranch,
  onPush,
  onSync
}: GitBranchSubrowProps) {
  const currentBranch = status.branch
  const branchLabel = status.branch ?? (status.isDetached ? '(detached)' : 'HEAD')
  const isPickerDisabled = isBusy || branches.length === 0
  const branchMenu = useMenuPopover(isPickerDisabled, workspaceRootPath)
  const isRemoteDisabled = isBusy || status.isUnborn || status.isDetached

  const unpublishedTitle = status.isUnborn
    ? '커밋된 내역이 없어 원격 저장소에 게시할 수 없습니다.'
    : status.isDetached
      ? 'Detached HEAD 상태에서는 원격 동기화를 실행할 수 없습니다.'
      : '원격 저장소에 브랜치 게시 (Publish / Push)'

  return (
    <div className="git-branch-subrow">
      <div
        ref={branchMenu.containerRef}
        className="git-branch-picker-wrap"
        onKeyDown={branchMenu.handleKeyDown}
      >
        <button
          ref={branchMenu.triggerRef}
          type="button"
          className="git-branch-picker-btn"
          aria-label={`현재 브랜치 ${branchLabel}`}
          title={`브랜치 전환 (${branchLabel})`}
          aria-haspopup="menu"
          aria-expanded={branchMenu.isOpen}
          disabled={isPickerDisabled}
          onClick={() => branchMenu.setIsOpen((open) => !open)}
        >
          <GitBranch size={12} strokeWidth={1.75} className="git-branch-picker-icon" aria-hidden="true" />
          <span className="git-branch-picker-label">{branchLabel}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="git-branch-picker-chevron" aria-hidden="true" />
        </button>

        {branchMenu.isOpen && (
          <div className="git-popover-menu git-branch-menu" role="menu" aria-label="브랜치 선택">
            {branches.map((branch) => {
              const isCurrent = !status.isDetached && branch.name === currentBranch
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="menuitem"
                  className={`git-popover-menu-item git-branch-menu-item${isCurrent ? ' is-active' : ''}`}
                  title={branch.upstream ? `${branch.name} → ${branch.upstream}` : branch.name}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    branchMenu.close()
                    if (!isCurrent) {
                      onCheckoutBranch(branch.name)
                    }
                  }}
                >
                  <span className="git-branch-menu-check" aria-hidden="true">
                    {isCurrent ? <Check size={12} strokeWidth={2} /> : null}
                  </span>
                  <span className="git-branch-menu-name">{branch.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {status.hasUpstream ? (
        <button
          type="button"
          className="git-remote-status-btn"
          aria-label={`Sync (↓${status.behind} ↑${status.ahead})`}
          title={`원격 저장소와 동기화 (Sync · ↓${status.behind} ↑${status.ahead})`}
          disabled={isRemoteDisabled}
          onClick={onSync}
        >
          <span className="git-remote-status-counts">
            ↓{status.behind} ↑{status.ahead}
          </span>
        </button>
      ) : (
        <button
          type="button"
          className="git-remote-status-btn is-unpublished"
          aria-label="미게시 브랜치 게시 (Push)"
          title={unpublishedTitle}
          disabled={isRemoteDisabled}
          onClick={onPush}
        >
          <CloudUpload size={12} strokeWidth={1.75} aria-hidden="true" />
          <span>미게시</span>
        </button>
      )}
    </div>
  )
}

/**
 * Sidebar panel for the Git panel header ("Source Control"), 26px branch subrow, and collapsible Changes and Graph sections.
 */
export const GitSidebarPanel = memo(function GitSidebarPanel({
  workspaceRootPath,
  status,
  branchList,
  graphState,
  pendingAction,
  errorMessage,
  splitState,
  onDismissError,
  onRefresh,
  onChangeLogScope,
  onLoadMoreCommits,
  onToggleCommitDetail,
  onInitRepo,
  onStageFile,
  onStageAll,
  onUnstageFile,
  onUnstageAll,
  onDiscardFile,
  onDiscardAll,
  onCommit,
  onCheckoutBranch,
  onPull,
  onPush,
  onFetch,
  onSync,
  onOpenFileDiff,
  onToggleChangesCollapsed,
  onToggleGraphCollapsed,
  onResizeChangesRatio
}: GitSidebarPanelProps) {
  const [commitMessage, setCommitMessage] = useState('')
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setValidationMessage(null)
  }, [workspaceRootPath])

  const isBusy = pendingAction !== null
  const unstagedAndUntracked: GitChangedFile[] = status
    ? [...status.unstaged, ...status.untracked]
    : []
  const availableBranches = branchList?.branches ?? []
  const totalChangedCount = getGitChangedCount(status)
  const layout = computeGitSectionLayout(splitState)

  const submitCommit = async (): Promise<void> => {
    if (isBusy || !status?.isRepo || status.staged.length === 0 || status.hasConflicts) {
      return
    }
    const trimmed = commitMessage.trim()
    if (!trimmed) {
      setValidationMessage('커밋 메시지를 입력하세요.')
      return
    }
    setValidationMessage(null)
    const committed = await onCommit(trimmed)
    if (committed) {
      setCommitMessage('')
    }
  }

  const handleCommitFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submitCommit()
  }

  const handleCommitKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submitCommit()
    }
  }

  const renderNonRepoBody = () => {
    if (!workspaceRootPath) {
      return <p className="git-empty-text">워크스페이스를 먼저 열어주세요.</p>
    }

    if (!status) {
      return <p className="git-empty-text">Git 상태를 불러오는 중...</p>
    }

    return (
      <div className="git-nonrepo-box">
        <p className="git-empty-text">현재 폴더는 Git 저장소가 아닙니다.</p>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={isBusy}
          onClick={onInitRepo}
        >
          Git 저장소 초기화 (git init)
        </button>
      </div>
    )
  }

  return (
    <section className="git-sidebar" aria-label="Git 소스 제어">
      <GitPanelHeader
        workspaceRootPath={workspaceRootPath}
        isRepo={Boolean(status?.isRepo)}
        isBusy={isBusy}
        hasStaged={Boolean(status && status.staged.length > 0)}
        hasUnstagedOrUntracked={unstagedAndUntracked.length > 0}
        onRefresh={onRefresh}
        onPull={onPull}
        onPush={onPush}
        onFetch={onFetch}
        onSync={onSync}
        onStageAll={onStageAll}
        onUnstageAll={onUnstageAll}
        onDiscardAll={onDiscardAll}
      />

      {!workspaceRootPath || !status || !status.isRepo ? (
        <div className="git-body">
          <GitCommonBanners
            pendingAction={pendingAction}
            errorMessage={errorMessage}
            onDismissError={onDismissError}
          />
          {renderNonRepoBody()}
        </div>
      ) : (
        <>
          <GitBranchSubrow
            workspaceRootPath={workspaceRootPath}
            status={status}
            branches={availableBranches}
            isBusy={isBusy}
            onCheckoutBranch={onCheckoutBranch}
            onPush={onPush}
            onSync={onSync}
          />

          {(pendingAction || errorMessage) && (
            <div className="git-banners-area">
              <GitCommonBanners
                pendingAction={pendingAction}
                errorMessage={errorMessage}
                onDismissError={onDismissError}
              />
            </div>
          )}

          <div ref={splitContainerRef} className="git-split-container">
            <GitAccordionSection
              title="Changes"
              badgeCount={totalChangedCount}
              isExpanded={layout.showChangesBody}
              flexRatio={layout.changesFlexRatio}
              onToggle={onToggleChangesCollapsed}
            >
              <form className="git-commit-form" onSubmit={handleCommitFormSubmit}>
                <textarea
                  className="git-commit-input"
                  aria-label="커밋 메시지"
                  placeholder="커밋 메시지를 입력하세요 (Ctrl+Enter)"
                  rows={2}
                  value={commitMessage}
                  disabled={isBusy}
                  onChange={(event) => {
                    setCommitMessage(event.target.value)
                    if (validationMessage && event.target.value.trim()) {
                      setValidationMessage(null)
                    }
                  }}
                  onKeyDown={handleCommitKeyDown}
                />
                {validationMessage && <p className="git-validation-text">{validationMessage}</p>}
                {status.hasConflicts && (
                  <p className="git-validation-text">
                    병합 충돌 파일을 해결하고 Stage(+)한 후 커밋하세요.
                  </p>
                )}
                <button
                  type="submit"
                  className="btn btn-sm btn-primary git-commit-btn"
                  disabled={isBusy || status.staged.length === 0 || status.hasConflicts}
                >
                  Commit
                </button>
              </form>

              <GitFileSection
                title="스테이지됨"
                files={status.staged}
                emptyText="스테이지된 변경 사항 없음"
                bulkButtonText="전체 -"
                bulkAriaLabel="전체 Unstage"
                itemActionSymbol="-"
                itemActionTitle="Unstage"
                isBusy={isBusy}
                onBulkAction={onUnstageAll}
                onSelectFile={(file) => onOpenFileDiff(toGitDiffRequest('staged', file))}
                onItemAction={(file) => onUnstageFile(file.path, file.origPath)}
              />

              <GitFileSection
                title="변경 사항"
                files={unstagedAndUntracked}
                emptyText="변경된 파일 없음"
                bulkButtonText="전체 +"
                bulkAriaLabel="전체 Stage"
                itemActionSymbol="+"
                itemActionTitle="Stage"
                isBusy={isBusy}
                onBulkAction={onStageAll}
                onBulkDiscard={onDiscardAll}
                onSelectFile={(file) => onOpenFileDiff(toGitDiffRequest('unstaged', file))}
                onItemAction={(file) => onStageFile(file.path)}
                onDiscardFile={(file) => onDiscardFile(file.path)}
              />
            </GitAccordionSection>

            {layout.showResizer && (
              <GitSectionResizer
                changesHeightRatio={splitState.changesHeightRatio}
                containerRef={splitContainerRef}
                onResizeRatio={onResizeChangesRatio}
              />
            )}

            <GitAccordionSection
              title="Graph"
              headerActions={
                <GitGraphScopeToggle scope={graphState.scope} onChangeScope={onChangeLogScope} />
              }
              isExpanded={layout.showGraphBody}
              flexRatio={layout.graphFlexRatio}
              onToggle={onToggleGraphCollapsed}
            >
              <GitGraphSection
                isUnborn={status.isUnborn}
                graphState={graphState}
                onLoadMore={onLoadMoreCommits}
                onToggleCommitDetail={onToggleCommitDetail}
                onOpenFileDiff={onOpenFileDiff}
              />
            </GitAccordionSection>
          </div>
        </>
      )}
    </section>
  )
})
