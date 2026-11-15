import type { GitGraphCommit } from '@shared/git'

/** Number of distinct cyclic lane colors rendered by the commit graph SVG. */
export const GIT_GRAPH_PALETTE_SIZE = 6

/** Edge connecting a commit node to a parent lane slot across a row boundary. */
export interface GitGraphConnection {
  fromCol: number
  toCol: number
  colorIndex: number
  kind: 'straight' | 'branch' | 'merge'
}

/** Computed lane geometry for one commit row in the Graph section. */
export interface GitGraphRow {
  commit: GitGraphCommit
  nodeCol: number
  colorIndex: number
  isHead: boolean
  isMerge: boolean
  hasIncoming: boolean
  /** Cyclic palette color index per column active at this row; null marks an intermediate freed slot. */
  activeLanes: ReadonlyArray<number | null>
  passThroughCols: ReadonlyArray<{ col: number; colorIndex: number }>
  connections: readonly GitGraphConnection[]
}

/** Complete lane layout across a rendered page of commits. */
export interface GitGraphLayout {
  rows: readonly GitGraphRow[]
  maxLanes: number
}

interface ActiveLaneSlot {
  expectedHash: string
  colorIndex: number
}

function findExpectedLane(
  lanes: ReadonlyArray<ActiveLaneSlot | null>,
  hash: string
): number {
  return lanes.findIndex((slot) => slot?.expectedHash === hash)
}

function allocateLaneSlot(lanes: Array<ActiveLaneSlot | null>): number {
  const emptyCol = lanes.findIndex((slot) => slot === null)
  if (emptyCol !== -1) {
    return emptyCol
  }
  lanes.push(null)
  return lanes.length - 1
}

function trimTrailingNulls(values: ReadonlyArray<number | null>): Array<number | null> {
  const result = [...values]
  while (result.length > 0 && result[result.length - 1] === null) {
    result.pop()
  }
  return result
}

function isCommitHead(commit: GitGraphCommit): boolean {
  return commit.refs.some((ref) => ref.kind === 'head' || ref.isCurrentHead === true)
}

/**
 * Computes branch lanes, color indices, pass-through lines, and parent curves
 * for commits in topological display order (newest to oldest).
 */
export function computeGitGraphLayout(commits: readonly GitGraphCommit[]): GitGraphLayout {
  if (commits.length === 0) {
    return { rows: [], maxLanes: 0 }
  }

  const lanes: Array<ActiveLaneSlot | null> = []
  let nextColorCounter = 0

  const takeNextColor = (): number => {
    const color = nextColorCounter % GIT_GRAPH_PALETTE_SIZE
    nextColorCounter += 1
    return color
  }

  const rows: GitGraphRow[] = []
  let maxLanes = 0

  for (const commit of commits) {
    const existingCol = findExpectedLane(lanes, commit.hash)
    const hasIncoming = existingCol !== -1
    const nodeCol = hasIncoming ? existingCol : allocateLaneSlot(lanes)
    const nodeColor = hasIncoming && lanes[nodeCol] ? lanes[nodeCol].colorIndex : takeNextColor()

    const passThroughCols: Array<{ col: number; colorIndex: number }> = []
    for (let col = 0; col < lanes.length; col += 1) {
      const slot = lanes[col]
      if (col !== nodeCol && slot !== null) {
        passThroughCols.push({ col, colorIndex: slot.colorIndex })
      }
    }

    // Consume current commit from its slot before wiring outgoing parent lanes.
    lanes[nodeCol] = null

    const connections: GitGraphConnection[] = []
    const [firstParent, ...extraParents] = commit.parents

    if (firstParent !== undefined) {
      const existingParentCol = findExpectedLane(lanes, firstParent)
      if (existingParentCol !== -1) {
        connections.push({
          fromCol: nodeCol,
          toCol: existingParentCol,
          colorIndex: nodeColor,
          kind: 'branch'
        })
      } else {
        lanes[nodeCol] = { expectedHash: firstParent, colorIndex: nodeColor }
        connections.push({
          fromCol: nodeCol,
          toCol: nodeCol,
          colorIndex: nodeColor,
          kind: 'straight'
        })
      }
    }

    for (const parentHash of extraParents) {
      const existingParentCol = findExpectedLane(lanes, parentHash)
      if (existingParentCol !== -1) {
        const targetSlot = lanes[existingParentCol]
        connections.push({
          fromCol: nodeCol,
          toCol: existingParentCol,
          colorIndex: targetSlot ? targetSlot.colorIndex : nodeColor,
          kind: 'merge'
        })
        continue
      }

      const branchCol = allocateLaneSlot(lanes)
      const branchColor = takeNextColor()
      lanes[branchCol] = { expectedHash: parentHash, colorIndex: branchColor }
      connections.push({
        fromCol: nodeCol,
        toCol: branchCol,
        colorIndex: branchColor,
        kind: 'merge'
      })
    }

    const rowLanes: Array<number | null> = lanes.map((slot) => (slot ? slot.colorIndex : null))
    while (rowLanes.length <= nodeCol) {
      rowLanes.push(null)
    }
    rowLanes[nodeCol] = nodeColor

    const activeLanes = trimTrailingNulls(rowLanes)
    if (activeLanes.length > maxLanes) {
      maxLanes = activeLanes.length
    }

    rows.push({
      commit,
      nodeCol,
      colorIndex: nodeColor,
      isHead: isCommitHead(commit),
      isMerge: commit.parents.length > 1,
      hasIncoming,
      activeLanes,
      passThroughCols,
      connections
    })
  }

  return { rows, maxLanes }
}

/**
 * Builds an SVG `<path d="..." />` string from a commit node center at `fromCol`
 * down to the bottom edge of the row at `toCol`.
 */
export function buildGitGraphConnectionPath(
  fromCol: number,
  toCol: number,
  laneWidth: number,
  rowHeight: number
): string {
  const x1 = fromCol * laneWidth + laneWidth / 2
  const x2 = toCol * laneWidth + laneWidth / 2
  const midY = rowHeight / 2

  if (fromCol === toCol) {
    return `M ${x1} ${midY} L ${x1} ${rowHeight}`
  }

  const controlY = (midY + rowHeight) / 2
  return `M ${x1} ${midY} C ${x1} ${controlY}, ${x2} ${controlY}, ${x2} ${rowHeight}`
}
