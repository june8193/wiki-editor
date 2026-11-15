import { memo, useMemo } from 'react'
import type { GitGraphCommit, GitLogScope, GitRefBadge, GitRefKind } from '@shared/git'
import {
  buildGitGraphConnectionPath,
  computeGitGraphLayout,
  GIT_GRAPH_PALETTE_SIZE,
  type GitGraphRow
} from '../utils/gitGraphLayout'

const GRAPH_LANE_WIDTH = 14
const GRAPH_ROW_HEIGHT = 28
const GRAPH_NODE_RADIUS = 3.5
const GRAPH_HEAD_RING_RADIUS = 6
const GRAPH_MERGE_DOT_RADIUS = 1.6

const LANE_FALLBACK_COLORS = [
  '#2563eb',
  '#16a34a',
  '#9333ea',
  '#d97706',
  '#db2777',
  '#0891b2'
] as const

const SCOPE_OPTIONS: ReadonlyArray<{ value: GitLogScope; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'current', label: '현재 브랜치' }
]

const REF_KIND_CLASS: Record<GitRefKind, string> = {
  head: 'is-head',
  'local-branch': 'is-local-branch',
  'remote-branch': 'is-remote-branch',
  tag: 'is-tag'
}

/** Props for the Graph section header filter toggle (`전체` / `현재 브랜치`). */
export interface GitGraphScopeToggleProps {
  scope: GitLogScope
  onChangeScope: (nextScope: GitLogScope) => void
}

/** Props for the Graph accordion body rendering commit graph rows and pagination. */
export interface GitGraphSectionProps {
  isUnborn: boolean
  commits: readonly GitGraphCommit[]
  hasMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  errorMessage: string | null
  onLoadMore: () => void
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

function getRefBadgeClassName(ref: GitRefBadge): string {
  const kindClass = REF_KIND_CLASS[ref.kind]
  const currentHeadClass =
    ref.kind === 'local-branch' && ref.isCurrentHead ? ' is-current-head' : ''
  return `git-ref-badge ${kindClass}${currentHeadClass}`
}

function getLaneCenterX(col: number): number {
  return col * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
}

/**
 * Filter toggle rendered in the Graph accordion header without nesting inside its collapse button.
 */
export const GitGraphScopeToggle = memo(function GitGraphScopeToggle({
  scope,
  onChangeScope
}: GitGraphScopeToggleProps) {
  return (
    <div className="git-graph-scope-toggle" role="group" aria-label="브랜치 필터">
      {SCOPE_OPTIONS.map((option) => {
        const isActive = scope === option.value
        return (
          <button
            key={option.value}
            type="button"
            className={`git-graph-scope-btn${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            onClick={() => onChangeScope(option.value)}
          >
            {option.label}
          </button>
        )
      })}
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

/**
 * Renders the Graph accordion body with commit SVG lanes, ref badges, metadata, and pagination.
 */
export const GitGraphSection = memo(function GitGraphSection({
  isUnborn,
  commits,
  hasMore,
  isLoading,
  isLoadingMore,
  errorMessage,
  onLoadMore
}: GitGraphSectionProps) {
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
        {layout.rows.map((row) => (
          <li
            key={row.commit.hash}
            className={`git-graph-item${row.isHead ? ' is-head' : ''}`}
            title={formatGitCommitTooltip(row.commit)}
          >
            <GitGraphLaneSvg row={row} maxLanes={layout.maxLanes} />
            <div className="git-graph-commit-info">
              <div className="git-graph-commit-primary">
                {row.commit.refs.length > 0 && (
                  <span className="git-graph-refs">
                    {row.commit.refs.map((ref) => (
                      <span
                        key={`${ref.kind}:${ref.name}`}
                        className={getRefBadgeClassName(ref)}
                      >
                        {ref.name}
                      </span>
                    ))}
                  </span>
                )}
                <span className="git-graph-subject">{row.commit.subject}</span>
              </div>
              <span className="git-graph-author">{row.commit.authorName}</span>
            </div>
          </li>
        ))}
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
