import { describe, expect, it } from 'vitest'
import type { GitGraphCommit, GitRefBadge } from '@shared/git'
import {
  buildGitGraphConnectionPath,
  computeGitGraphLayout,
  GIT_GRAPH_PALETTE_SIZE
} from './gitGraphLayout'

function makeCommit(
  hash: string,
  parents: string[],
  refs: GitRefBadge[] = []
): GitGraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    subject: `commit ${hash}`,
    authorName: 'Tester',
    committedAt: '2026-11-15T12:00:00+09:00',
    refs
  }
}

describe('gitGraphLayout', () => {
  it('returns empty layout for empty commit list', () => {
    expect(computeGitGraphLayout([])).toEqual({
      rows: [],
      maxLanes: 0
    })
  })

  it('computes single-lane linear layout with HEAD marker and root termination', () => {
    const commits = [
      makeCommit('c3', ['c2'], [
        { name: 'HEAD', kind: 'head', isCurrentHead: true },
        { name: 'main', kind: 'local-branch', isCurrentHead: true }
      ]),
      makeCommit('c2', ['c1']),
      makeCommit('c1', [])
    ]

    const layout = computeGitGraphLayout(commits)
    expect(layout.maxLanes).toBe(1)
    expect(layout.rows).toHaveLength(3)

    expect(layout.rows[0]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isHead: true,
      isMerge: false,
      hasIncoming: false,
      activeLanes: [0],
      passThroughCols: [],
      connections: [{ fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' }],
      laneCount: 1
    })

    expect(layout.rows[1]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isHead: false,
      isMerge: false,
      hasIncoming: true,
      activeLanes: [0],
      passThroughCols: [],
      connections: [{ fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' }],
      laneCount: 1
    })

    expect(layout.rows[2]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isHead: false,
      isMerge: false,
      hasIncoming: true,
      activeLanes: [0],
      passThroughCols: [],
      connections: [],
      laneCount: 1
    })
  })

  it('assigns parallel lanes for unmerged branches converging onto a shared ancestor', () => {
    const commits = [
      makeCommit('f1', ['c1'], [{ name: 'feature', kind: 'local-branch' }]),
      makeCommit('m1', ['c1'], [{ name: 'main', kind: 'local-branch', isCurrentHead: true }]),
      makeCommit('c1', [])
    ]

    const layout = computeGitGraphLayout(commits)
    expect(layout.maxLanes).toBe(2)

    expect(layout.rows[0]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      hasIncoming: false,
      connections: [{ fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' }]
    })

    // m1 starts a new branch tip in lane 1 (isCurrentHead marks HEAD even without separate 'head' ref)
    // while lane 0 passes straight down toward c1, and m1's branch curves back into lane 0
    expect(layout.rows[1]).toMatchObject({
      nodeCol: 1,
      colorIndex: 1,
      isHead: true,
      hasIncoming: false,
      activeLanes: [0, 1],
      passThroughCols: [{ col: 0, colorIndex: 0 }],
      connections: [{ fromCol: 1, toCol: 0, colorIndex: 1, kind: 'branch' }],
      laneCount: 2
    })

    expect(layout.rows[2]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isHead: false,
      hasIncoming: true,
      activeLanes: [0],
      passThroughCols: [],
      connections: [],
      laneCount: 1
    })
  })

  it('lays out 2-parent merge commits with distinct lane colors and clean rejoin', () => {
    const commits = [
      makeCommit('merge', ['main1', 'feat1'], [{ name: 'HEAD', kind: 'head', isCurrentHead: true }]),
      makeCommit('main1', ['base']),
      makeCommit('feat1', ['base']),
      makeCommit('base', [])
    ]

    const layout = computeGitGraphLayout(commits)
    expect(layout.maxLanes).toBe(2)

    expect(layout.rows[0]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isHead: true,
      isMerge: true,
      hasIncoming: false,
      connections: [
        { fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' },
        { fromCol: 0, toCol: 1, colorIndex: 1, kind: 'merge' }
      ],
      laneCount: 2
    })

    expect(layout.rows[1]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isMerge: false,
      hasIncoming: true,
      activeLanes: [0, 1],
      passThroughCols: [{ col: 1, colorIndex: 1 }],
      connections: [{ fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' }],
      laneCount: 2
    })

    expect(layout.rows[2]).toMatchObject({
      nodeCol: 1,
      colorIndex: 1,
      hasIncoming: true,
      activeLanes: [0, 1],
      passThroughCols: [{ col: 0, colorIndex: 0 }],
      connections: [{ fromCol: 1, toCol: 0, colorIndex: 1, kind: 'branch' }],
      laneCount: 2
    })

    expect(layout.rows[3]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      hasIncoming: true,
      activeLanes: [0],
      passThroughCols: [],
      connections: [],
      laneCount: 1
    })
  })

  it('supports 3-parent octopus merges and preserves open parent lanes past the page boundary', () => {
    const commits = [
      makeCommit('oct', ['p1', 'p2', 'p3']),
      makeCommit('p1', ['outside-page-ancestor'])
    ]

    const layout = computeGitGraphLayout(commits)
    expect(layout.maxLanes).toBe(3)

    expect(layout.rows[0]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      isMerge: true,
      connections: [
        { fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' },
        { fromCol: 0, toCol: 1, colorIndex: 1, kind: 'merge' },
        { fromCol: 0, toCol: 2, colorIndex: 2, kind: 'merge' }
      ],
      laneCount: 3
    })

    // p1 sits on lane 0 with its open parent connection extending past the page bottom,
    // while p2 and p3 remain open pass-through lanes extending past the page bottom
    expect(layout.rows[1]).toMatchObject({
      nodeCol: 0,
      colorIndex: 0,
      hasIncoming: true,
      activeLanes: [0, 1, 2],
      passThroughCols: [
        { col: 1, colorIndex: 1 },
        { col: 2, colorIndex: 2 }
      ],
      connections: [{ fromCol: 0, toCol: 0, colorIndex: 0, kind: 'straight' }],
      laneCount: 3
    })
  })

  it('cycles color indices within palette bounds and builds straight and curved SVG connection paths', () => {
    const manyTips = Array.from({ length: GIT_GRAPH_PALETTE_SIZE + 2 }, (_, idx) =>
      makeCommit(`tip-${idx}`, ['missing-root'])
    )

    const layout = computeGitGraphLayout(manyTips)
    expect(layout.rows[0].colorIndex).toBe(0)
    expect(layout.rows[GIT_GRAPH_PALETTE_SIZE].colorIndex).toBe(0)
    expect(layout.rows[GIT_GRAPH_PALETTE_SIZE + 1].colorIndex).toBe(1)

    expect(buildGitGraphConnectionPath(0, 0, 14, 32)).toBe('M 7 16 L 7 32')
    expect(buildGitGraphConnectionPath(0, 1, 14, 32)).toBe('M 7 16 C 7 24, 21 24, 21 32')
  })
})
