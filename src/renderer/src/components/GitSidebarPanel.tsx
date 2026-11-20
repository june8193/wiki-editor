import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
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
import { type DismissReason, useDismissable } from '../hooks/useDismissable'
import type { GitGraphState } from '../hooks/useGitGraphLog'
import { toGitDiffRequest } from '../utils/gitFilePresentation'
import type { GitChangesGroupKey, GitChangesViewState } from '../utils/gitChangesView'
import { computeTwoSectionLayout, type TwoSectionSplitState } from '../utils/accordionSplit'
import {
  formatGitCommitPlaceholder,
  getGitBranchLabel,
  getGitPrimaryActionState,
  type GitCommitActionMode
} from '../utils/gitPrimaryAction'
import { GitChangesFileGroups, GitChangesHeaderActions } from './GitChangesSection'
import { GitGraphHeaderActions, GitGraphSection } from './GitGraphSection'
import { HorizontalSectionResizer } from './HorizontalSectionResizer'
import {
  type AccordionSectionClassNames,
  SidebarAccordionSection
} from './SidebarAccordionSection'

const GIT_ACCORDION_CLASS_NAMES: AccordionSectionClassNames = {
  body: 'git-accordion-body'
}

const COMMIT_INPUT_MAX_HEIGHT_PX = 120

const COMMIT_ACTION_MENU_ITEMS: ReadonlyArray<{ mode: GitCommitActionMode; label: string }> = [
  { mode: 'commit', label: 'Commit' },
  { mode: 'commit-push', label: 'Commit & Push' },
  { mode: 'commit-sync', label: 'Commit & Sync' }
]

export interface GitSidebarPanelProps {
  workspaceRootPath: string | null
  status: GitStatus | null
  branchList: GitBranchList | null
  graphState: GitGraphState
  pendingAction: string | null
  errorMessage: string | null
  splitState: TwoSectionSplitState
  changesViewState: GitChangesViewState
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
  onCommit: (message: string, mode?: GitCommitActionMode) => Promise<boolean> | boolean
  onCheckoutBranch: (branchName: string) => void
  onPull: () => void
  onPush: () => void
  onFetch: () => void
  onSync: () => void
  onOpenFileDiff: (request: GitDiffRequest) => void
  onOpenWorkspaceFile: (repoRelativePath: string) => void
  onToggleChangesCollapsed: () => void
  onToggleGraphCollapsed: () => void
  onResizeChangesRatio: (nextRatio: number) => void
  onToggleChangesViewMode: () => void
  onToggleChangesGroupCollapsed: (group: GitChangesGroupKey) => void
  onToggleChangesTreeDirCollapsed: (dirKey: string) => void
}

/**
 * Manages popover open/close state with outside-click/Escape dismissal and workspace/disabled resets.
 */
function useMenuPopover(isDisabled: boolean, resetKey: string | null) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback((reason?: DismissReason): void => {
    setIsOpen(false)
    if (reason === 'escape' && containerRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus()
    }
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

  return { isOpen, setIsOpen, close, containerRef, triggerRef }
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

type GitMoreMenuEntry =
  | { kind: 'separator'; key: string }
  | {
      kind: 'item'
      label: string
      disabled: boolean
      danger?: boolean
      onSelect: () => void
    }

interface GitPanelHeaderProps {
  workspaceRootPath: string | null
  isRefreshDisabled: boolean
  isMoreDisabled: boolean
  onRefresh: () => void
  moreMenuEntries: readonly GitMoreMenuEntry[]
}

/**
 * Renders the top Git panel header with refresh and the overflow (...) actions menu.
 */
function GitPanelHeader({
  workspaceRootPath,
  isRefreshDisabled,
  isMoreDisabled,
  onRefresh,
  moreMenuEntries
}: GitPanelHeaderProps) {
  const moreMenu = useMenuPopover(isMoreDisabled, workspaceRootPath)

  return (
    <div className="git-header">
      <span className="git-header-title">Source Control</span>
      <div className="git-header-actions">
        <button
          type="button"
          className="git-icon-btn"
          aria-label="Git 상태 새로고침"
          title="Git 상태 새로고침"
          disabled={isRefreshDisabled}
          onClick={onRefresh}
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <div ref={moreMenu.containerRef} className="git-menu-anchor">
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
              className="tree-context-menu git-popover-menu git-more-menu"
              role="menu"
              aria-label="Git 패널 추가 작업"
            >
              {moreMenuEntries.map((entry) =>
                entry.kind === 'separator' ? (
                  <div key={entry.key} className="context-menu-separator" role="separator" />
                ) : (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitem"
                    className={`context-menu-item git-popover-menu-item${entry.danger ? ' is-danger' : ''}`}
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
  const branchLabel = getGitBranchLabel(status)
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
      <div ref={branchMenu.containerRef} className="git-branch-picker-wrap">
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
          <div className="tree-context-menu git-popover-menu git-branch-menu" role="menu" aria-label="브랜치 선택">
            {branches.map((branch) => {
              const isCurrent = !status.isDetached && branch.name === currentBranch
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="menuitem"
                  className={`context-menu-item git-popover-menu-item git-branch-menu-item${isCurrent ? ' is-active' : ''}`}
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

function useGitCommitInputState(
  workspaceRootPath: string | null,
  status: GitStatus | null,
  isBusy: boolean,
  onCommit: (message: string, mode?: GitCommitActionMode) => Promise<boolean> | boolean
) {
  const [commitMessage, setCommitMessage] = useState('')
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const commitInFlightRef = useRef(false)

  const primaryAction = getGitPrimaryActionState(status)
  const isCommitMode = primaryAction.kind === 'commit'
  const isCommitDisabled = isBusy || !isCommitMode || primaryAction.disabled

  useEffect(() => {
    setValidationMessage(null)
  }, [workspaceRootPath])

  useEffect(() => {
    if (!isCommitMode || primaryAction.disabled) {
      setValidationMessage(null)
    }
  }, [isCommitMode, primaryAction.kind === 'commit' ? primaryAction.disabled : false])

  const submitCommit = useCallback(
    async (mode: GitCommitActionMode = 'commit'): Promise<void> => {
      if (
        commitInFlightRef.current ||
        isBusy ||
        primaryAction.kind !== 'commit' ||
        primaryAction.disabled
      ) {
        return
      }
      const trimmed = commitMessage.trim()
      if (!trimmed) {
        setValidationMessage('커밋 메시지를 입력하세요.')
        return
      }
      setValidationMessage(null)
      commitInFlightRef.current = true
      try {
        const committed = await onCommit(trimmed, mode)
        if (committed) {
          setCommitMessage('')
        }
      } finally {
        commitInFlightRef.current = false
      }
    },
    [commitMessage, isBusy, onCommit, primaryAction]
  )

  const handleMessageChange = useCallback(
    (nextValue: string): void => {
      setCommitMessage(nextValue)
      if (validationMessage && nextValue.trim()) {
        setValidationMessage(null)
      }
    },
    [validationMessage]
  )

  return {
    commitMessage,
    validationMessage,
    primaryAction,
    isCommitDisabled,
    submitCommit,
    handleMessageChange
  }
}

type GitCommitInputController = ReturnType<typeof useGitCommitInputState>

interface GitCommitFormProps {
  workspaceRootPath: string | null
  status: GitStatus
  isBusy: boolean
  commitInput: GitCommitInputController
  onPush: () => void
  onSync: () => void
}

/**
 * Renders the 1-line auto-resizing commit input and smart primary CTA (`Commit ▾` / `Publish Branch` / `Sync Changes`).
 */
function GitCommitForm({
  workspaceRootPath,
  status,
  isBusy,
  commitInput,
  onPush,
  onSync
}: GitCommitFormProps) {
  const {
    commitMessage,
    validationMessage,
    primaryAction,
    isCommitDisabled,
    submitCommit,
    handleMessageChange
  } = commitInput
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null)
  const commitMenu = useMenuPopover(isCommitDisabled, workspaceRootPath)
  const branchLabel = getGitBranchLabel(status)

  useLayoutEffect(() => {
    const input = commitInputRef.current
    if (!input) return
    input.style.height = 'auto'
    if (input.scrollHeight > 0) {
      input.style.height = `${Math.min(input.scrollHeight, COMMIT_INPUT_MAX_HEIGHT_PX)}px`
    }
  }, [commitMessage, status.isRepo])

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submitCommit('commit')
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submitCommit('commit')
    }
  }

  return (
    <form className="git-commit-form" onSubmit={handleFormSubmit}>
      <textarea
        ref={commitInputRef}
        className="git-commit-input"
        aria-label="커밋 메시지"
        placeholder={formatGitCommitPlaceholder(branchLabel)}
        rows={1}
        value={commitMessage}
        disabled={isBusy}
        onChange={(event) => handleMessageChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
      />
      {validationMessage && <p className="git-validation-text">{validationMessage}</p>}
      {status.hasConflicts && (
        <p className="git-validation-text">
          병합 충돌 파일을 해결하고 Stage(+)한 후 커밋하세요.
        </p>
      )}
      {primaryAction.kind === 'publish' ? (
        <button
          type="button"
          className="btn btn-sm btn-primary git-commit-btn"
          title="원격 저장소에 브랜치 게시 (Publish / Push)"
          disabled={isBusy}
          onClick={onPush}
        >
          <CloudUpload size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="git-commit-btn-label">Publish Branch</span>
        </button>
      ) : primaryAction.kind === 'sync' ? (
        <button
          type="button"
          className="btn btn-sm btn-primary git-commit-btn"
          title={`원격 저장소와 동기화 (Sync · ↓${primaryAction.behind} ↑${primaryAction.ahead})`}
          disabled={isBusy}
          onClick={onSync}
        >
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="git-commit-btn-label">
            Sync Changes {primaryAction.behind}↓ {primaryAction.ahead}↑
          </span>
        </button>
      ) : (
        <div ref={commitMenu.containerRef} className="git-commit-split-wrap">
          <button
            type="submit"
            className="btn btn-sm btn-primary git-commit-split-main"
            disabled={isCommitDisabled}
          >
            <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="git-commit-btn-label">Commit</span>
          </button>
          <button
            ref={commitMenu.triggerRef}
            type="button"
            className="btn btn-sm btn-primary git-commit-split-toggle"
            aria-label="커밋 작업 더 보기"
            title="커밋 작업 더 보기"
            aria-haspopup="menu"
            aria-expanded={commitMenu.isOpen}
            disabled={isCommitDisabled}
            onClick={() => commitMenu.setIsOpen((open) => !open)}
          >
            <ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {commitMenu.isOpen && (
            <div
              className="tree-context-menu git-popover-menu git-commit-menu"
              role="menu"
              aria-label="커밋 옵션"
            >
              {COMMIT_ACTION_MENU_ITEMS.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  role="menuitem"
                  className="context-menu-item git-popover-menu-item"
                  disabled={isCommitDisabled}
                  onClick={() => {
                    commitMenu.close()
                    void submitCommit(item.mode)
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </form>
  )
}

/**
 * Sidebar panel for the Git panel header, 26px branch subrow, and collapsible Changes and Graph sections.
 */
export const GitSidebarPanel = memo(function GitSidebarPanel({
  workspaceRootPath,
  status,
  branchList,
  graphState,
  pendingAction,
  errorMessage,
  splitState,
  changesViewState,
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
  onOpenWorkspaceFile,
  onToggleChangesCollapsed,
  onToggleGraphCollapsed,
  onResizeChangesRatio,
  onToggleChangesViewMode,
  onToggleChangesGroupCollapsed,
  onToggleChangesTreeDirCollapsed
}: GitSidebarPanelProps) {
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  const isBusy = pendingAction !== null
  const commitInput = useGitCommitInputState(workspaceRootPath, status, isBusy, onCommit)
  const unstagedAndUntracked: GitChangedFile[] = status
    ? [...status.unstaged, ...status.untracked]
    : []
  const availableBranches = branchList?.branches ?? []
  const totalChangedCount = getGitChangedCount(status)
  const layout = computeTwoSectionLayout(splitState)

  const handleHeaderCommit = (): void => {
    if (splitState.isTopCollapsed && !commitInput.commitMessage.trim()) {
      onToggleChangesCollapsed()
    }
    void commitInput.submitCommit('commit')
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

  const hasStaged = Boolean(status && status.staged.length > 0)
  const hasUnstagedOrUntracked = unstagedAndUntracked.length > 0
  const moreMenuEntries: readonly GitMoreMenuEntry[] = [
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
    <section className="git-sidebar" aria-label="Git 소스 제어">
      <GitPanelHeader
        workspaceRootPath={workspaceRootPath}
        isRefreshDisabled={!workspaceRootPath || isBusy}
        isMoreDisabled={!workspaceRootPath || !status?.isRepo || isBusy}
        onRefresh={onRefresh}
        moreMenuEntries={moreMenuEntries}
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
            <SidebarAccordionSection
              title="Changes"
              badge={<span className="git-accordion-badge">{totalChangedCount}</span>}
              headerActions={
                <GitChangesHeaderActions
                  viewMode={changesViewState.viewMode}
                  isBusy={isBusy}
                  isCommitDisabled={commitInput.isCommitDisabled}
                  onToggleViewMode={onToggleChangesViewMode}
                  onHeaderCommit={handleHeaderCommit}
                  onRefresh={onRefresh}
                />
              }
              isExpanded={layout.showTopBody}
              flexRatio={layout.topFlexRatio}
              classNames={GIT_ACCORDION_CLASS_NAMES}
              onToggle={onToggleChangesCollapsed}
            >
              <GitCommitForm
                workspaceRootPath={workspaceRootPath}
                status={status}
                isBusy={isBusy}
                commitInput={commitInput}
                onPush={onPush}
                onSync={onSync}
              />

              <GitChangesFileGroups
                stagedFiles={status.staged}
                unstagedAndUntracked={unstagedAndUntracked}
                viewState={changesViewState}
                isBusy={isBusy}
                repoRoot={status.repoRoot}
                workspaceRootPath={workspaceRootPath}
                onToggleGroupCollapsed={onToggleChangesGroupCollapsed}
                onToggleTreeDir={onToggleChangesTreeDirCollapsed}
                onStageAll={onStageAll}
                onUnstageAll={onUnstageAll}
                onDiscardAll={onDiscardAll}
                onSelectStagedFile={(file) => onOpenFileDiff(toGitDiffRequest('staged', file))}
                onSelectWorkingFile={(file) => onOpenFileDiff(toGitDiffRequest('unstaged', file))}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onStageFile={(file) => onStageFile(file.path)}
                onUnstageFile={(file) => onUnstageFile(file.path, file.origPath)}
                onDiscardFile={(file) => onDiscardFile(file.path)}
              />
            </SidebarAccordionSection>

            {layout.showResizer && (
              <HorizontalSectionResizer
                ratio={splitState.topHeightRatio}
                containerRef={splitContainerRef}
                ariaLabel="Git 섹션 높이 조절"
                bodyClassName="is-resizing-git-sections"
                onResizeRatio={onResizeChangesRatio}
              />
            )}

            <SidebarAccordionSection
              title="Graph"
              headerActions={
                <GitGraphHeaderActions
                  scope={graphState.scope}
                  isBusy={isBusy}
                  isRefreshing={graphState.isLoading}
                  onChangeScope={onChangeLogScope}
                  onFetch={onFetch}
                  onPull={onPull}
                  onPush={onPush}
                  onRefresh={onRefresh}
                />
              }
              isExpanded={layout.showBottomBody}
              flexRatio={layout.bottomFlexRatio}
              classNames={GIT_ACCORDION_CLASS_NAMES}
              onToggle={onToggleGraphCollapsed}
            >
              <GitGraphSection
                isUnborn={status.isUnborn}
                graphState={graphState}
                onLoadMore={onLoadMoreCommits}
                onToggleCommitDetail={onToggleCommitDetail}
                onOpenFileDiff={onOpenFileDiff}
              />
            </SidebarAccordionSection>
          </div>
        </>
      )}
    </section>
  )
})
