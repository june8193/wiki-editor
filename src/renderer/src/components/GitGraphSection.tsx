import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleDot,
  Cloud,
  CloudDownload,
  Copy,
  GitBranch,
  RefreshCw,
  Tag,
  type LucideIcon
} from 'lucide-react'
import type {
  GitCommitDetail,
  GitDiffRequest,
  GitGraphCommit,
  GitLogScope
} from '@shared/git'
import type { GitCommitDetailState, GitGraphState } from '../hooks/useGitGraphLog'
import { toGitDiffRequest } from '../utils/gitFilePresentation'
import { normalizeGitGraphRefs, type GitGraphDisplayRef } from '../utils/gitGraphRefs'
import { GitChangedFileRow } from './GitChangedFileRow'
import {
  buildGitGraphConnectionPath,
  computeGitGraphLayout,
  GIT_GRAPH_PALETTE_SIZE,
  type GitGraphRow
} from '../utils/gitGraphLayout'

const GRAPH_LANE_WIDTH = 14
const GRAPH_ROW_HEIGHT = 24
const GRAPH_NODE_RADIUS = 3
const GRAPH_HEAD_RING_RADIUS = 5.5
const GRAPH_MERGE_DOT_RADIUS = 1.5

const LANE_FALLBACK_COLORS = [
  '#2563eb',
  '#16a34a',
  '#9333ea',
  '#d97706',
  '#db2777',
  '#0891b2'
] as const

/** Props for the Graph accordion header toolbar (`Auto`/`현재 브랜치` scope + `Fetch`/`Pull`/`Push`/`새로고침`). */
export interface GitGraphHeaderActionsProps {
  scope: GitLogScope
  isBusy: boolean
  isRefreshing: boolean
  onChangeScope: (nextScope: GitLogScope) => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onRefresh: () => void
}

/** Props for the Graph accordion body rendering commit graph rows and pagination. */
export interface GitGraphSectionProps {
  isUnborn: boolean
  graphState: GitGraphState
  onLoadMore: () => void
  onToggleCommitDetail: (commitHash: string) => void
  onOpenFileDiff: (request: GitDiffRequest) => void
}

function getLaneColor(colorIndex: number): string {
  const normalized =
    ((colorIndex % GIT_GRAPH_PALETTE_SIZE) + GIT_GRAPH_PALETTE_SIZE) % GIT_GRAPH_PALETTE_SIZE
  return `var(--git-graph-lane-${normalized}, ${LANE_FALLBACK_COLORS[normalized]})`
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

function formatGitCommitTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp)
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp
  }
  const year = parsed.getFullYear()
  const month = padTwo(parsed.getMonth() + 1)
  const day = padTwo(parsed.getDate())
  const hours = padTwo(parsed.getHours())
  const minutes = padTwo(parsed.getMinutes())
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

/** Formats hover tooltip text (`shortHash · authorName · 날짜·시간 · subject`) for a commit row. */
export function formatGitCommitTooltip(commit: GitGraphCommit): string {
  return `${commit.shortHash} · ${commit.authorName} · ${formatGitCommitTimestamp(commit.committedAt)} · ${commit.subject}`
}

function getDisplayRefKey(displayRef: GitGraphDisplayRef): string {
  return displayRef.kind === 'head' ? 'head' : `${displayRef.kind}:${displayRef.name}`
}

function GitGraphRefBadgeChip({
  variantClass,
  title,
  label,
  Icon,
  strokeWidth = 1.75
}: {
  variantClass: string
  title: string
  label: string
  Icon: LucideIcon
  strokeWidth?: number
}) {
  return (
    <span className={`git-ref-badge ${variantClass}`} title={title}>
      <Icon size={10} strokeWidth={strokeWidth} className="git-ref-icon" aria-hidden="true" />
      <span className="git-ref-label">{label}</span>
    </span>
  )
}

function GitGraphRefBadgeItem({ displayRef }: { displayRef: GitGraphDisplayRef }) {
  if (displayRef.kind === 'head') {
    return (
      <GitGraphRefBadgeChip
        variantClass="is-head"
        title="HEAD (detached)"
        label="HEAD"
        Icon={CircleDot}
        strokeWidth={2}
      />
    )
  }

  if (displayRef.kind === 'branch') {
    const remoteTooltip = displayRef.syncedRemotes.join(', ')
    return (
      <span className="git-ref-branch-group">
        <GitGraphRefBadgeChip
          variantClass={`is-local-branch${displayRef.isCurrentHead ? ' is-current-head' : ''}`}
          title={displayRef.name}
          label={displayRef.name}
          Icon={displayRef.isCurrentHead ? CircleDot : GitBranch}
          strokeWidth={displayRef.isCurrentHead ? 2 : 1.75}
        />
        {displayRef.syncedRemotes.length > 0 && (
          <span
            className="git-ref-badge is-synced-remote"
            title={remoteTooltip}
            aria-label={`원격: ${remoteTooltip}`}
          >
            <Cloud size={10} strokeWidth={1.75} className="git-ref-icon" aria-hidden="true" />
          </span>
        )}
      </span>
    )
  }

  const isRemote = displayRef.kind === 'remote'
  return (
    <GitGraphRefBadgeChip
      variantClass={isRemote ? 'is-remote-branch' : 'is-tag'}
      title={displayRef.name}
      label={displayRef.name}
      Icon={isRemote ? Cloud : Tag}
    />
  )
}

function getLaneCenterX(col: number): number {
  return col * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
}

/**
 * Renders the VS Code scope toggle (`Auto` / `현재 브랜치`) and `Fetch`/`Pull`/`Push`/`새로고침`
 * icon toolbar on the Graph accordion header, separate from its collapse button.
 */
export const GitGraphHeaderActions = memo(function GitGraphHeaderActions({
  scope,
  isBusy,
  isRefreshing,
  onChangeScope,
  onFetch,
  onPull,
  onPush,
  onRefresh
}: GitGraphHeaderActionsProps) {
  const isCurrentScope = scope === 'current'
  const nextScope: GitLogScope = isCurrentScope ? 'all' : 'current'
  const scopeLabel = isCurrentScope ? '현재 브랜치' : 'Auto'
  const scopeTitle = isCurrentScope
    ? '표시 범위: 현재 브랜치 (클릭하여 Auto로 전환)'
    : '표시 범위: Auto (전체 브랜치 · 클릭하여 현재 브랜치로 전환)'

  const actionItems = [
    {
      key: 'fetch',
      label: 'Fetch',
      title: '원격 변경 사항 가져오기 (Fetch)',
      disabled: isBusy,
      onClick: onFetch,
      Icon: CloudDownload
    },
    {
      key: 'pull',
      label: 'Pull',
      title: '원격 변경 사항 받아오기 (Pull)',
      disabled: isBusy,
      onClick: onPull,
      Icon: ArrowDown
    },
    {
      key: 'push',
      label: 'Push',
      title: '원격 저장소로 Push',
      disabled: isBusy,
      onClick: onPush,
      Icon: ArrowUp
    },
    {
      key: 'refresh',
      label: '그래프 새로고침',
      title: '커밋 그래프 새로고침',
      disabled: isBusy || isRefreshing,
      onClick: onRefresh,
      Icon: RefreshCw
    }
  ] as const

  return (
    <div className="git-accordion-actions">
      <button
        type="button"
        className={`git-graph-scope-btn${isCurrentScope ? ' is-current' : ''}`}
        title={scopeTitle}
        onClick={() => onChangeScope(nextScope)}
      >
        {scopeLabel}
      </button>
      {actionItems.map(({ key, label, title, disabled, onClick, Icon }) => (
        <button
          key={key}
          type="button"
          className="git-icon-btn"
          aria-label={label}
          title={title}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
})

const GitGraphLaneSvg = memo(function GitGraphLaneSvg({
  row,
  maxLanes
}: {
  row: GitGraphRow
  maxLanes: number
}) {
  const svgWidth = Math.max(maxLanes, 1) * GRAPH_LANE_WIDTH
  const midY = GRAPH_ROW_HEIGHT / 2
  const nodeX = getLaneCenterX(row.nodeCol)
  const nodeColor = getLaneColor(row.colorIndex)

  return (
    <svg
      className="git-graph-svg"
      width={svgWidth}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${svgWidth} ${GRAPH_ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.passThroughCols.map((lane) => {
        const x = getLaneCenterX(lane.col)
        return (
          <line
            key={`pass-${lane.col}`}
            x1={x}
            y1={0}
            x2={x}
            y2={GRAPH_ROW_HEIGHT}
            stroke={getLaneColor(lane.colorIndex)}
            strokeWidth={1.75}
            strokeLinecap="round"
          />
        )
      })}

      {row.hasIncoming && (
        <line
          x1={nodeX}
          y1={0}
          x2={nodeX}
          y2={midY}
          stroke={nodeColor}
          strokeWidth={1.75}
          strokeLinecap="round"
        />
      )}

      {row.connections.map((conn) => (
        <path
          key={`conn-${conn.fromCol}-${conn.toCol}-${conn.kind}`}
          d={buildGitGraphConnectionPath(
            conn.fromCol,
            conn.toCol,
            GRAPH_LANE_WIDTH,
            GRAPH_ROW_HEIGHT
          )}
          fill="none"
          stroke={getLaneColor(conn.colorIndex)}
          strokeWidth={1.75}
          strokeLinecap="round"
        />
      ))}

      {row.isHead && (
        <circle
          className="git-graph-head-ring"
          cx={nodeX}
          cy={midY}
          r={GRAPH_HEAD_RING_RADIUS}
          fill="none"
          stroke={nodeColor}
          strokeWidth={1.5}
        />
      )}

      <circle
        className={`git-graph-node${row.isHead ? ' is-head' : ''}${row.isMerge ? ' is-merge' : ''}`}
        cx={nodeX}
        cy={midY}
        r={GRAPH_NODE_RADIUS}
        fill={nodeColor}
      />

      {row.isMerge && (
        <circle
          className="git-graph-merge-dot"
          cx={nodeX}
          cy={midY}
          r={GRAPH_MERGE_DOT_RADIUS}
        />
      )}
    </svg>
  )
})

function GitCommitDetailFiles({
  detail,
  onOpenFileDiff
}: {
  detail: GitCommitDetail
  onOpenFileDiff: (request: GitDiffRequest) => void
}) {
  if (detail.files.length === 0) {
    return <p className="git-commit-detail-empty-files">변경된 파일이 없습니다.</p>
  }

  return (
    <div className="git-commit-detail-files-section">
      <div className="git-commit-detail-files-header">변경된 파일 ({detail.files.length})</div>
      <ul className="git-file-list git-commit-detail-files" aria-label="변경된 파일" role="list">
        {detail.files.map((file) => (
          <GitChangedFileRow
            key={`${file.status}:${file.origPath ?? ''}:${file.path}`}
            file={file}
            displayMode="list"
            onSelectFile={(selectedFile) =>
              onOpenFileDiff(
                toGitDiffRequest(
                  {
                    kind: 'commit',
                    commitHash: detail.hash,
                    shortHash: detail.shortHash
                  },
                  selectedFile
                )
              )
            }
          />
        ))}
      </ul>
    </div>
  )
}

interface GitCommitDetailPanelProps {
  shortHash: string
  detailState: GitCommitDetailState
  onOpenFileDiff: (request: GitDiffRequest) => void
}

/**
 * Renders read-only inline commit metadata, hash copy control, and changed files below a row.
 */
function GitCommitDetailPanel({
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

  const loadedDetail = detailState.status === 'loaded' ? detailState.detail : null
  const isCopied = loadedDetail !== null && copiedHash === loadedDetail.hash
  const hasBody = loadedDetail !== null && loadedDetail.body.trim().length > 0

  return (
    <div
      className="git-commit-detail"
      role="region"
      aria-label={`${shortHash} 커밋 상세`}
      // Clear inherited commit-row tooltip while hovering inside the expanded detail box.
      title=""
    >
      {detailState.status === 'loading' && (
        <p className="git-commit-detail-status">커밋 상세를 불러오는 중...</p>
      )}
      {detailState.status === 'error' && (
        <p className="git-commit-detail-error" role="alert">
          {detailState.errorMessage}
        </p>
      )}
      {loadedDetail && (
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
              {formatGitCommitTimestamp(loadedDetail.committedAt)}
            </span>
          </div>
          <GitCommitDetailFiles detail={loadedDetail} onOpenFileDiff={onOpenFileDiff} />
        </>
      )}
    </div>
  )
}

/**
 * Renders the Graph accordion body with commit SVG lanes, ref badges, metadata, inline details, and pagination.
 */
export const GitGraphSection = memo(function GitGraphSection({
  isUnborn,
  graphState,
  onLoadMore,
  onToggleCommitDetail,
  onOpenFileDiff
}: GitGraphSectionProps) {
  const { commits, hasMore, isLoading, isLoadingMore, errorMessage, commitDetail } = graphState
  const layout = useMemo(() => computeGitGraphLayout(commits), [commits])

  if (isLoading && commits.length === 0) {
    return <p className="git-empty-subtext">커밋 히스토리를 불러오는 중...</p>
  }

  if (errorMessage && commits.length === 0) {
    return (
      <p className="git-graph-error" role="alert">
        {errorMessage}
      </p>
    )
  }

  if (commits.length === 0) {
    return (
      <p className="git-empty-subtext">
        {isUnborn ? '아직 커밋된 내역이 없습니다.' : '표시할 커밋 히스토리가 없습니다.'}
      </p>
    )
  }

  return (
    <div className="git-graph-content">
      {errorMessage && (
        <p className="git-graph-error" role="alert">
          {errorMessage}
        </p>
      )}
      <ul className="git-graph-list" aria-label="커밋 그래프">
        {layout.rows.map((row) => {
          const isExpanded =
            commitDetail.status !== 'idle' && commitDetail.selectedHash === row.commit.hash
          const displayRefs = normalizeGitGraphRefs(row.commit.refs)

          return (
            <li
              key={row.commit.hash}
              className={`git-graph-item${row.isHead ? ' is-head' : ''}${isExpanded ? ' is-expanded' : ''}`}
              title={formatGitCommitTooltip(row.commit)}
            >
              <button
                type="button"
                className="git-graph-row-btn"
                aria-expanded={isExpanded}
                onClick={() => onToggleCommitDetail(row.commit.hash)}
              >
                <GitGraphLaneSvg row={row} maxLanes={layout.maxLanes} />
                <div className="git-graph-commit-info">
                  <span className="git-graph-subject">{row.commit.subject}</span>
                  <span className="git-graph-author">{row.commit.authorName}</span>
                  {displayRefs.length > 0 && (
                    <span className="git-graph-refs">
                      {displayRefs.map((displayRef) => (
                        <GitGraphRefBadgeItem
                          key={getDisplayRefKey(displayRef)}
                          displayRef={displayRef}
                        />
                      ))}
                    </span>
                  )}
                </div>
              </button>
              {isExpanded && (
                <GitCommitDetailPanel
                  shortHash={row.commit.shortHash}
                  detailState={commitDetail}
                  onOpenFileDiff={onOpenFileDiff}
                />
              )}
            </li>
          )
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="git-graph-load-more-btn"
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? '불러오는 중...' : '더 보기'}
        </button>
      )}
    </div>
  )
})
