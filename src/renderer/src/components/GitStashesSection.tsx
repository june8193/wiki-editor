import { memo } from 'react'
import { Plus } from 'lucide-react'
import type { GitDiffRequest, GitStashDetail, GitStashEntry } from '@shared/git'
import type { GitDetailState } from '../hooks/useGitDetailSelection'
import { formatGitTimestamp } from '../utils/gitFilePresentation'
import { GitDetailFilesList, GitDetailPanel } from './GitDetailPanel'

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
        className="git-stash-action-btn is-danger is-header"
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
  stashDetail: GitDetailState<GitStashDetail>
  isBusy: boolean
  onToggleStashDetail: (entry: GitStashEntry) => void
  onOpenFileDiff: (request: GitDiffRequest) => void
  onPopStash: (stashRef: string) => void
  onApplyStash: (stashRef: string) => void
  onDropStash: (stashRef: string) => void
}

/**
 * Renders the Stashes accordion body listing saved stashes with message, ref, formatted timestamp,
 * inline expandable changed-file list, and hover/focus-revealed `Pop` / `Apply` / `Drop` actions.
 */
export const GitStashesSection = memo(function GitStashesSection({
  stashes,
  stashDetail,
  isBusy,
  onToggleStashDetail,
  onOpenFileDiff,
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
        const isExpanded =
          stashDetail.status !== 'idle' && stashDetail.selectedHash === entry.hash
        const formattedTime = formatGitTimestamp(entry.createdAt)
        const tooltip = entry.branch
          ? `${entry.ref} (${entry.branch}) · ${formattedTime} · ${entry.message}`
          : `${entry.ref} · ${formattedTime} · ${entry.message}`

        return (
          <li
            key={`${entry.ref}:${entry.hash}`}
            className={`git-stash-item${isExpanded ? ' is-expanded' : ''}`}
            title={tooltip}
          >
            <div className="git-stash-row">
              <button
                type="button"
                className="git-stash-trigger"
                aria-expanded={isExpanded}
                onClick={() => onToggleStashDetail(entry)}
              >
                <span className="git-stash-main">
                  <span className="git-stash-message">{entry.message}</span>
                  <span className="git-stash-meta">
                    <span className="git-stash-ref">{entry.ref}</span>
                    <span aria-hidden="true">·</span>
                    <span className="git-stash-time">{formattedTime}</span>
                  </span>
                </span>
              </button>

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
            {isExpanded && (
              <GitDetailPanel
                className="git-detail git-stash-detail"
                ariaLabel={`${entry.ref} Stash 상세`}
                detailState={stashDetail}
                loadingText="Stash 상세를 불러오는 중..."
                renderLoaded={(loadedDetail) => (
                  <GitDetailFilesList
                    files={loadedDetail.files}
                    target={{ kind: 'stash', stashRef: entry.ref, stashHash: entry.hash }}
                    onOpenFileDiff={onOpenFileDiff}
                  />
                )}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
})
