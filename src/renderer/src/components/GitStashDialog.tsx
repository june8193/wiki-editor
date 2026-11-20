import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  collectGitStatusPaths,
  collectGitUnstagedPaths,
  type GitStashCreateOptions,
  type GitStatus
} from '@shared/git'
import { ModalDialog } from './ModalDialog'

export interface GitStashDialogProps {
  status: GitStatus
  initialScope: 'unstaged' | 'all'
  isBusy?: boolean
  onSubmit: (options: GitStashCreateOptions) => void | Promise<void>
  onClose: () => void
}

function resolveInitialScope(
  status: GitStatus,
  requestedScope: 'unstaged' | 'all'
): 'unstaged' | 'all' {
  if (requestedScope === 'all') {
    return 'all'
  }
  const unstagedCount = collectGitUnstagedPaths(status, true).length
  const allCount = collectGitStatusPaths(status, true).length
  return unstagedCount > 0 || allCount === 0 ? 'unstaged' : 'all'
}

/**
 * Lightweight modal dialog for creating a Git stash with an optional message, scope selection,
 * and untracked file inclusion toggle.
 */
export function GitStashDialog({
  status,
  initialScope,
  isBusy = false,
  onSubmit,
  onClose
}: GitStashDialogProps) {
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)
  const [scope, setScope] = useState<'unstaged' | 'all'>(() =>
    resolveInitialScope(status, initialScope)
  )

  const messageInputRef = useRef<HTMLInputElement | null>(null)

  const unstagedCount = collectGitUnstagedPaths(status, includeUntracked).length
  const allCount = collectGitStatusPaths(status, includeUntracked).length
  const activeCount = scope === 'unstaged' ? unstagedCount : allCount
  const canSubmit = !isBusy && activeCount > 0

  useEffect(() => {
    messageInputRef.current?.focus()
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canSubmit) {
      return
    }
    const trimmedMessage = message.trim()
    void onSubmit({
      scope,
      ...(trimmedMessage ? { message: trimmedMessage } : {}),
      includeUntracked
    })
  }

  const handleMessageKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault()
    }
  }

  return (
    <ModalDialog
      dialogClassName="git-stash-dialog"
      ariaLabelledBy="git-stash-dialog-title"
      autoFocusDialog={false}
      isDismissDisabled={isBusy}
      onClose={onClose}
    >
      <h3 id="git-stash-dialog-title" className="modal-title">
        Stash 생성
      </h3>
      <form className="git-stash-dialog-form" onSubmit={handleSubmit}>
        <div className="git-stash-dialog-field">
          <label htmlFor="git-stash-message-input" className="git-stash-dialog-label">
            메시지 (선택)
          </label>
          <input
            ref={messageInputRef}
            id="git-stash-message-input"
            type="text"
            className="git-stash-dialog-input"
            value={message}
            disabled={isBusy}
            placeholder="보관할 작업 내용을 입력하세요 (비워두면 기본 메시지 사용)"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleMessageKeyDown}
          />
        </div>

        <fieldset className="git-stash-dialog-fieldset">
          <legend className="git-stash-dialog-label">보관 범위</legend>
          <div className="git-stash-scope-option">
            <input
              id="git-stash-scope-unstaged"
              type="radio"
              name="git-stash-scope"
              value="unstaged"
              checked={scope === 'unstaged'}
              disabled={isBusy || unstagedCount === 0}
              onChange={() => setScope('unstaged')}
            />
            <label htmlFor="git-stash-scope-unstaged">Changes만 보관 (Staged 유지)</label>
            <span className="git-stash-scope-count">({unstagedCount}건)</span>
          </div>
          <div className="git-stash-scope-option">
            <input
              id="git-stash-scope-all"
              type="radio"
              name="git-stash-scope"
              value="all"
              checked={scope === 'all'}
              disabled={isBusy || allCount === 0}
              onChange={() => setScope('all')}
            />
            <label htmlFor="git-stash-scope-all">전체 보관 (Staged 포함)</label>
            <span className="git-stash-scope-count">({allCount}건)</span>
          </div>
        </fieldset>

        <div className="git-stash-checkbox-row">
          <input
            id="git-stash-include-untracked"
            type="checkbox"
            checked={includeUntracked}
            disabled={isBusy}
            onChange={(event) => setIncludeUntracked(event.target.checked)}
          />
          <label htmlFor="git-stash-include-untracked">미추적 파일(?) 포함</label>
        </div>

        {activeCount === 0 && (
          <p className="git-stash-dialog-hint" role="status">
            선택한 범위에 Stash할 변경 사항이 없습니다.
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" disabled={isBusy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            Stash 생성
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}
