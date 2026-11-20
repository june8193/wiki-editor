import { memo } from 'react'
import { Plus } from 'lucide-react'
import type { GitStashEntry } from '@shared/git'
import { formatGitTimestamp } from '../utils/gitFilePresentation'

export interface GitStashesHeaderActionsProps {
  hasChanges: boolean
  stashCount: number
  isBusy: boolean
  onOpenStashDialog: () => void
  onClearStashes: () => void
}

/**
 * Renders the Stashes accordion header toolbar (`+` Stash dialog trigger and `Clear All`).
 */
export const GitStashesHeaderActions = memo(function GitStashesHeaderActions({
  hasChanges,
  stashCount,
  isBusy,
  onOpenStashDialog,
  onClearStashes
}: GitStashesHeaderActionsProps) {
  return (
    <div className="git-accordion-actions">
      <button
        type="button"
        className="git-icon-btn"
        aria-label="새 Stash 만들기"
        title="새 Stash 만들기"
        disabled={isBusy || !hasChanges}
        onClick={onOpenStashDialog}
      >
        <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="git-stash-header-clear-btn"
        title="모든 Stash 삭제 (Clear All)"
        disabled={isBusy || stashCount === 0}
        onClick={onClearStashes}
      >
        Clear All
      </button>
    </div>
  )
})

export interface GitStashesSectionProps {
  stashes: readonly GitStashEntry[]
  isBusy: boolean
  onPopStash: (stashRef: string) => void
  onApplyStash: (stashRef: string) => void
  onDropStash: (stashRef: string) => void
}

/**
 * Renders the Stashes accordion body listing saved stashes with message, ref, formatted timestamp,
 * and hover/focus-revealed `Pop` / `Apply` / `Drop` actions.
 */
export const GitStashesSection = memo(function GitStashesSection({
  stashes,
  isBusy,
  onPopStash,
  onApplyStash,
  onDropStash
}: GitStashesSectionProps) {
  if (stashes.length === 0) {
    return <p className="git-empty-text">보관된 Stash가 없습니다.</p>
  }

  return (
    <ul className="git-stash-list" role="list" aria-label="Stash 목록">
      {stashes.map((entry) => {
        const formattedTime = formatGitTimestamp(entry.createdAt)
        const tooltip = entry.branch
          ? `${entry.ref} (${entry.branch}) · ${formattedTime} · ${entry.message}`
          : `${entry.ref} · ${formattedTime} · ${entry.message}`

        return (
          <li key={`${entry.ref}:${entry.hash}`} className="git-stash-item" title={tooltip}>
            <div className="git-stash-row">
              <div className="git-stash-main">
                <span className="git-stash-message">{entry.message}</span>
                <span className="git-stash-meta">
                  <span className="git-stash-ref">{entry.ref}</span>
                  <span aria-hidden="true">·</span>
                  <span className="git-stash-time">{formattedTime}</span>
                </span>
              </div>

              <div className="git-stash-actions">
                <button
                  type="button"
                  className="git-stash-action-btn"
                  aria-label={`${entry.ref} Pop`}
                  title="Pop (복원 후 목록에서 제거)"
                  disabled={isBusy}
                  onClick={() => onPopStash(entry.ref)}
                >
                  Pop
                </button>
                <button
                  type="button"
                  className="git-stash-action-btn"
                  aria-label={`${entry.ref} Apply`}
                  title="Apply (복원 · 목록 유지)"
                  disabled={isBusy}
                  onClick={() => onApplyStash(entry.ref)}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="git-stash-action-btn is-danger"
                  aria-label={`${entry.ref} Drop`}
                  title="Drop (영구 삭제)"
                  disabled={isBusy}
                  onClick={() => onDropStash(entry.ref)}
                >
                  Drop
                </button>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
})
