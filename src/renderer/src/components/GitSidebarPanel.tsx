import { memo, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { GitBranchList, GitChangedFile, GitStatus } from '@shared/git'

export interface GitSidebarPanelProps {
  workspaceRootPath: string | null
  status: GitStatus | null
  branchList: GitBranchList | null
  pendingAction: string | null
  errorMessage: string | null
  onDismissError: () => void
  onRefresh: () => void
  onInitRepo: () => void
  onStageFile: (path: string) => void
  onStageAll: () => void
  onUnstageFile: (path: string) => void
  onUnstageAll: () => void
  onCommit: (message: string) => Promise<boolean> | boolean
  onCheckoutBranch: (branchName: string) => void
  onPull: () => void
  onPush: () => void
  onSync: () => void
}

function formatGitFileLabel(file: GitChangedFile): string {
  return file.origPath ? `${file.origPath} → ${file.path}` : file.path
}

function getBadgeModifier(code: GitChangedFile['status']): string {
  return code === '?' ? 'untracked' : code.toLowerCase()
}

/**
 * Collapsible sidebar panel for workspace Git status, staging, committing, branch switching, and sync.
 */
export const GitSidebarPanel = memo(function GitSidebarPanel({
  workspaceRootPath,
  status,
  branchList,
  pendingAction,
  errorMessage,
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
  onSync
}: GitSidebarPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [validationMessage, setValidationMessage] = useState<string | null>(null)

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

  const renderBody = () => {
    if (!workspaceRootPath) {
      return <p className="git-empty-text">워크스페이스를 먼저 열어주세요.</p>
    }

    if (!status) {
      return <p className="git-empty-text">Git 상태를 불러오는 중...</p>
    }

    if (!status.isRepo) {
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
      <>
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

        <div className="git-section">
          <div className="git-section-header">
            <span className="git-section-title">스테이지됨 ({status.staged.length})</span>
            <button
              type="button"
              className="git-section-action-btn"
              aria-label="전체 Unstage"
              title="전체 Unstage"
              disabled={isBusy || status.staged.length === 0}
              onClick={onUnstageAll}
            >
              전체 -
            </button>
          </div>
          {status.staged.length === 0 ? (
            <p className="git-empty-subtext">스테이지된 변경 사항 없음</p>
          ) : (
            <ul className="git-file-list" role="list">
              {status.staged.map((file) => (
                <li key={`staged:${file.path}`} className="git-file-item">
                  <span className={`git-badge git-badge--${getBadgeModifier(file.status)}`}>
                    {file.status}
                  </span>
                  <span className="git-file-path" title={formatGitFileLabel(file)}>
                    {formatGitFileLabel(file)}
                  </span>
                  <button
                    type="button"
                    className="git-file-action-btn"
                    aria-label={`${file.path} Unstage`}
                    title="Unstage"
                    disabled={isBusy}
                    onClick={() => onUnstageFile(file.path)}
                  >
                    -
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="git-section">
          <div className="git-section-header">
            <span className="git-section-title">
              변경 사항 ({unstagedAndUntracked.length})
            </span>
            <button
              type="button"
              className="git-section-action-btn"
              aria-label="전체 Stage"
              title="전체 Stage"
              disabled={isBusy || unstagedAndUntracked.length === 0}
              onClick={onStageAll}
            >
              전체 +
            </button>
          </div>
          {unstagedAndUntracked.length === 0 ? (
            <p className="git-empty-subtext">변경된 파일 없음</p>
          ) : (
            <ul className="git-file-list" role="list">
              {unstagedAndUntracked.map((file) => (
                <li key={`change:${file.status}:${file.path}`} className="git-file-item">
                  <span className={`git-badge git-badge--${getBadgeModifier(file.status)}`}>
                    {file.status}
                  </span>
                  <span className="git-file-path" title={formatGitFileLabel(file)}>
                    {formatGitFileLabel(file)}
                  </span>
                  <button
                    type="button"
                    className="git-file-action-btn"
                    aria-label={`${file.path} Stage`}
                    title="Stage"
                    disabled={isBusy}
                    onClick={() => onStageFile(file.path)}
                  >
                    +
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </>
    )
  }

  return (
    <section className="git-sidebar" aria-label="Git 소스 제어">
      <div className="git-header">
        <button
          type="button"
          className="git-collapse-btn"
          aria-expanded={!isCollapsed}
          onClick={() => setIsCollapsed((prev) => !prev)}
        >
          <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
          <span>Git</span>
          {branchLabel && (
            <span className="git-branch-pill" aria-label={`현재 브랜치 ${branchLabel}`}>
              {branchLabel}
            </span>
          )}
          {status?.isRepo && (
            <span className="git-ab-pill" aria-label={`Ahead ${status.ahead} Behind ${status.behind}`}>
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </button>

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

      {!isCollapsed && (
        <div className="git-body">
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

          {renderBody()}
        </div>
      )}
    </section>
  )
})
