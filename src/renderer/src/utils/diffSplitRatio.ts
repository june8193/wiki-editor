import {
  DEFAULT_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  roundSplitRatio
} from '@shared/window'

export const DIFF_GUTTER_WIDTH_PX = 48
export const DIFF_MIN_CODE_WIDTH_PX = 60
export const DIFF_MIN_SIDE_WIDTH_PX = DIFF_GUTTER_WIDTH_PX + DIFF_MIN_CODE_WIDTH_PX

export interface DiffSplitRatioBounds {
  min: number
  max: number
}

export interface DiffSplitColumnWidths {
  effectiveRatio: number
  leftCodeWidth: string
  rightCodeWidth: string
}

/**
 * Returns `[min, max]` split ratio bounds for a side-by-side diff table, tightening
 * `[0.15, 0.85]` when the table is narrow so both sides retain at least `DIFF_MIN_SIDE_WIDTH_PX`.
 */
export function getDiffSplitRatioBounds(tableWidth?: number): DiffSplitRatioBounds {
  if (typeof tableWidth !== 'number' || !Number.isFinite(tableWidth) || tableWidth <= 0) {
    return { min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO }
  }
  if (tableWidth <= DIFF_MIN_SIDE_WIDTH_PX * 2) {
    return { min: DEFAULT_SPLIT_RATIO, max: DEFAULT_SPLIT_RATIO }
  }
  const minSideRatio = DIFF_MIN_SIDE_WIDTH_PX / tableWidth
  return {
    min: Math.max(MIN_SPLIT_RATIO, minSideRatio),
    max: Math.min(MAX_SPLIT_RATIO, 1 - minSideRatio)
  }
}

/**
 * Clamps and rounds a side-by-side diff split ratio within safe bounds for `tableWidth`.
 */
export function clampDiffSplitRatio(ratio: number, tableWidth?: number): number {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_SPLIT_RATIO
  }
  const { min, max } = getDiffSplitRatioBounds(tableWidth)
  return roundSplitRatio(Math.min(max, Math.max(min, ratio)))
}

/**
 * Computes CSS `<col>` widths for left and right code columns in side-by-side diff mode.
 */
export function getDiffSplitColumnWidths(
  ratio: number,
  tableWidth?: number
): DiffSplitColumnWidths {
  const effectiveRatio = clampDiffSplitRatio(ratio, tableWidth)
  const leftPct = roundSplitRatio(effectiveRatio * 100)
  const rightPct = roundSplitRatio((1 - effectiveRatio) * 100)
  return {
    effectiveRatio,
    leftCodeWidth: `calc(${leftPct}% - ${DIFF_GUTTER_WIDTH_PX}px)`,
    rightCodeWidth: `calc(${rightPct}% - ${DIFF_GUTTER_WIDTH_PX}px)`
  }
}
