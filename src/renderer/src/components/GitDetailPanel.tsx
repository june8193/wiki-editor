import type { ReactNode } from 'react'
import type { GitChangedFile, GitDiffRequest } from '@shared/git'
import type { GitDetailState } from '../hooks/useGitDetailSelection'
import { toGitDiffRequest, type GitDiffTarget } from '../utils/gitFilePresentation'
import { GitChangedFileRow } from './GitChangedFileRow'

/**
 * Renders the shared expandable detail box shell (region, loading, error, and loaded content)
 * for inline Commit and Stash detail panels.
 */
export function GitDetailPanel<TDetail>({
  className = 'git-detail',
  ariaLabel,
  detailState,
  loadingText,
  renderLoaded
}: {
  className?: string
  ariaLabel: string
  detailState: GitDetailState<TDetail>
  loadingText: string
  renderLoaded: (detail: TDetail) => ReactNode
}) {
  return (
    <div
      className={className}
      role="region"
      aria-label={ariaLabel}
      // Clear inherited row tooltip while hovering inside the expanded detail box.
      title=""
    >
      {detailState.status === 'loading' && <p className="git-detail-status">{loadingText}</p>}
      {detailState.status === 'error' && (
        <p className="git-detail-error" role="alert">
          {detailState.errorMessage}
        </p>
      )}
      {detailState.status === 'loaded' && renderLoaded(detailState.detail)}
    </div>
  )
}

/**
 * Renders the shared inline changed-files list inside expanded Commit and Stash detail panels.
 */
export function GitDetailFilesList({
  files,
  target,
  onOpenFileDiff
}: {
  files: readonly GitChangedFile[]
  target: GitDiffTarget
  onOpenFileDiff: (request: GitDiffRequest) => void
}) {
  if (files.length === 0) {
    return <p className="git-detail-empty-files">변경된 파일이 없습니다.</p>
  }

  return (
    <div className="git-detail-files-section">
      <div className="git-detail-files-header">변경된 파일 ({files.length})</div>
      <ul className="git-file-list git-detail-files" aria-label="변경된 파일" role="list">
        {files.map((file) => (
          <GitChangedFileRow
            key={`${file.status}:${file.origPath ?? ''}:${file.path}`}
            file={file}
            displayMode="list"
            onSelectFile={(selectedFile) => onOpenFileDiff(toGitDiffRequest(target, selectedFile))}
          />
        ))}
      </ul>
    </div>
  )
}
