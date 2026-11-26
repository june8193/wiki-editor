import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type { GitChangedFile, GitCommitDetail, GitDiffRequest } from '@shared/git'
import type { GitDetailState } from '../stores/GitSession'
import type { DiffTabOpenOptions } from '../stores/PaneTabStore'
import {
  formatGitTimestamp,
  forwardGitDiffOpen,
  type GitDiffTarget
} from '../utils/gitFilePresentation'
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
  onOpenFileDiff: (request: GitDiffRequest, options?: DiffTabOpenOptions) => void
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
            onSelectFile={(selectedFile, options) =>
              forwardGitDiffOpen(target, selectedFile, onOpenFileDiff, options)
            }
          />
        ))}
      </ul>
    </div>
  )
}

export interface GitCommitDetailPanelProps {
  shortHash: string
  detailState: GitDetailState<GitCommitDetail>
  onOpenFileDiff: (request: GitDiffRequest, options?: DiffTabOpenOptions) => void
}

/**
 * Renders read-only inline commit metadata, hash copy control, and changed files below a commit row.
 */
export function GitCommitDetailPanel({
  shortHash,
  detailState,
  onOpenFileDiff
}: GitCommitDetailPanelProps) {
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  async function handleCopyHash(hash: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return
    }
    try {
      await navigator.clipboard.writeText(hash)
      setCopiedHash(hash)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedHash((current) => (current === hash ? null : current))
        copyTimerRef.current = null
      }, 2000)
    } catch {
      // Clipboard writes can fail when permissions are unavailable.
    }
  }

  return (
    <GitDetailPanel
      ariaLabel={`${shortHash} 커밋 상세`}
      detailState={detailState}
      loadingText="커밋 상세를 불러오는 중..."
      renderLoaded={(loadedDetail) => {
        const isCopied = copiedHash === loadedDetail.hash
        const hasBody = loadedDetail.body.trim().length > 0
        return (
          <>
            <div className="git-commit-detail-top">
              <code className="git-commit-detail-hash" title={loadedDetail.hash}>
                {loadedDetail.shortHash}
              </code>
              <button
                type="button"
                className={`git-icon-btn git-commit-detail-copy-btn${isCopied ? ' is-copied' : ''}`}
                aria-label="해시 복사"
                title={isCopied ? '복사됨' : '전체 해시 복사'}
                onClick={() => void handleCopyHash(loadedDetail.hash)}
              >
                {isCopied ? (
                  <>
                    <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                    <span className="git-commit-detail-copy-status">복사됨</span>
                  </>
                ) : (
                  <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            </div>
            <div className="git-commit-detail-subject">{loadedDetail.subject}</div>
            {hasBody && <div className="git-commit-detail-body">{loadedDetail.body}</div>}
            <div className="git-commit-detail-meta">
              <span className="git-commit-detail-author">
                {loadedDetail.authorEmail
                  ? `${loadedDetail.authorName} <${loadedDetail.authorEmail}>`
                  : loadedDetail.authorName}
              </span>
              <span className="git-commit-detail-date">
                {formatGitTimestamp(loadedDetail.committedAt)}
              </span>
            </div>
            <GitDetailFilesList
              files={loadedDetail.files}
              target={{
                kind: 'commit',
                commitHash: loadedDetail.hash,
                shortHash: loadedDetail.shortHash
              }}
              onOpenFileDiff={onOpenFileDiff}
            />
          </>
        )
      }}
    />
  )
}
