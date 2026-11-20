import { memo } from 'react'
import type { GitStashEntry } from '@shared/git'
import { formatGitTimestamp } from '../utils/gitFilePresentation'

export interface GitStashesSectionProps {
  stashes: readonly GitStashEntry[]
  isBusy: boolean
  onPopStash: (stashRef: string) => void
  onApplyStash: (stashRef: string) => void
}

/**
 * Renders the Stashes accordion body listing saved stashes with message, ref, formatted timestamp,
 * and hover/focus-revealed `Pop` / `Apply` restore actions.
 */
export const GitStashesSection = memo(function GitStashesSection({
  stashes,
  isBusy,
  onPopStash,
  onApplyStash
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
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
})
