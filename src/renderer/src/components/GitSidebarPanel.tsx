import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import type { GitBranchList, GitChangedFile, GitStatus } from '@shared/git'
import { computeGitSectionLayout, type GitPanelSplitState } from '../utils/gitPanelSplit'
import { GitSectionResizer } from './GitSectionResizer'

export interface GitSidebarPanelProps {
  workspaceRootPath: string | null
  status: GitStatus | null
  branchList: GitBranchList | null
  pendingAction: string | null
  errorMessage: string | null
  splitState: GitPanelSplitState
  onDismissError: () => void
  onRefresh: () => void
  onInitRepo: () => void
  onStageFile: (path: string) => void
  onStageAll: () => void
  onUnstageFile: (path: string, origPath?: string) => void
  onUnstageAll: () => void
  onCommit: (message: string) => Promise<boolean> | boolean
  onCheckoutBranch: (branchName: string) => void
  onPull: () => void
  onPush: () => void
  onSync: () => void
  onToggleChangesCollapsed: () => void
  onToggleGraphCollapsed: () => void
  onResizeChangesRatio: (nextRatio: number) => void
}

function formatGitFileLabel(file: GitChangedFile): string {
  return file.origPath ? `${file.origPath} → ${file.path}` : file.path
}

function getBadgeModifier(code: GitChangedFile['status']): string {
  return code === '?' ? 'untracked' : code.toLowerCase()
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
  onItemAction: (file: GitChangedFile) => void
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
  onItemAction
}: GitFileSectionProps) {
  return (
    <div className="git-section">
      <div className="git-section-header">
        <span className="git-section-title">
          {title} ({files.length})
        </span>
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
      {files.length === 0 ? (
        <p className="git-empty-subtext">{emptyText}</p>
      ) : (
        <ul className="git-file-list" role="list">
          {files.map((file) => (
            <li key={`${itemActionTitle}:${file.status}:${file.path}`} className="git-file-item">
              <span className={`git-badge git-badge--${getBadgeModifier(file.status)}`}>
                {file.status}
              </span>
              <span className="git-file-path" title={formatGitFileLabel(file)}>
                {formatGitFileLabel(file)}
              </span>
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
  isExpanded: boolean
  flexRatio: number | null
  className: string
  bodyClassName: string
  onToggle: () => void
  children: ReactNode
}

function GitAccordionSection({
  title,
  badgeCount,
  isExpanded,
  flexRatio,
  className,
  bodyClassName,
  onToggle,
  children
}: GitAccordionSectionProps) {
  return (
    <section
      className={`git-accordion-section ${className}${isExpanded ? '' : ' is-collapsed'}`}
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
      </div>
      {isExpanded && <div className={`git-accordion-body ${bodyClassName}`}>{children}</div>}
    </section>
  )
}

/**
 * Sidebar panel for workspace Git common controls and collapsible Changes and Graph sections.
 */
export const GitSidebarPanel = memo(function GitSidebarPanel({
  workspaceRootPath,
  status,
  branchList,
  pendingAction,
  errorMessage,
  splitState,
  onDismissError,
  onRefresh,
  onInitRepo,
  onStageFile,
  onStageAll,
  onUnstageFile,
  onUnstageAll,
  onCommit,
  onCheckoutBranch,
  onPull,
  onPush,
  onSync,
  onToggleChangesCollapsed,
  onToggleGraphCollapsed,
  onResizeChangesRatio
}: GitSidebarPanelProps) {
  const [commitMessage, setCommitMessage] = useState('')
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  const currentBranch = status?.branch ?? branchList?.current ?? ''
  const [selectedBranch, setSelectedBranch] = useState(currentBranch)

  useEffect(() => {
    setSelectedBranch(currentBranch)
  }, [currentBranch, workspaceRootPath])

  useEffect(() => {
    setValidationMessage(null)
  }, [workspaceRootPath])

  const isBusy = pendingAction !== null
  const unstagedAndUntracked: GitChangedFile[] = status
    ? [...status.unstaged, ...status.untracked]
    : []
  const availableBranches = branchList?.branches ?? []
  const branchLabel = status?.isRepo
    ? status.branch ?? (status.isDetached ? '(detached)' : 'HEAD')
    : null
  const totalChangedCount = status?.isRepo
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0
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
      <div className="git-header">
        <div className="git-header-title-group">
          <span className="git-header-title">Git</span>
          {branchLabel && (
            <span className="git-branch-pill" aria-label={`현재 브랜치 ${branchLabel}`}>
              {branchLabel}
            </span>
          )}
          {status?.isRepo && (
            <span
              className="git-ab-pill"
              aria-label={`Ahead ${status.ahead} Behind ${status.behind}`}
            >
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </div>

        <button
          type="button"
          className="btn btn-sm"
          aria-label="Git 상태 새로고침"
          title="Git 상태 새로고침"
          disabled={!workspaceRootPath || isBusy}
          onClick={onRefresh}
        >
          ↻
        </button>
      </div>

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
          <div className="git-common-area">
            <GitCommonBanners
              pendingAction={pendingAction}
              errorMessage={errorMessage}
              onDismissError={onDismissError}
            />

            <div className="git-branch-bar">
              <select
                className="git-branch-select"
                aria-label="브랜치 선택"
                value={selectedBranch}
                disabled={isBusy || availableBranches.length === 0}
                onChange={(event) => setSelectedBranch(event.target.value)}
              >
                {(!currentBranch || status.isDetached) && <option value="">(detached HEAD)</option>}
                {availableBranches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                aria-label="브랜치 전환"
                disabled={isBusy || !selectedBranch || selectedBranch === currentBranch}
                onClick={() => onCheckoutBranch(selectedBranch)}
              >
                전환
              </button>
            </div>

            <div className="git-remote-actions">
              <button type="button" className="btn btn-sm" disabled={isBusy} onClick={onPull}>
                Pull
              </button>
              <button type="button" className="btn btn-sm" disabled={isBusy} onClick={onPush}>
                Push
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={isBusy}
                onClick={onSync}
              >
                Sync
              </button>
            </div>
          </div>

          <div ref={splitContainerRef} className="git-split-container">
            <GitAccordionSection
              title="Changes"
              badgeCount={totalChangedCount}
              isExpanded={layout.showChangesBody}
              flexRatio={layout.changesFlexRatio}
              className="git-changes-section"
              bodyClassName="git-changes-body"
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
                onItemAction={(file) => onStageFile(file.path)}
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
              isExpanded={layout.showGraphBody}
              flexRatio={layout.graphFlexRatio}
              className="git-graph-section"
              bodyClassName="git-graph-body"
              onToggle={onToggleGraphCollapsed}
            >
              <p className="git-empty-subtext">
                {status.isUnborn ? '아직 커밋된 내역이 없습니다.' : '표시할 커밋 히스토리가 없습니다.'}
              </p>
            </GitAccordionSection>
          </div>
        </>
      )}
    </section>
  )
})
