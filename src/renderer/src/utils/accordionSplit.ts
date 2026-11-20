export const ACCORDION_MIN_TOP_RATIO = 0.2
export const ACCORDION_MAX_TOP_RATIO = 0.8
export const ACCORDION_RATIO_STEP = 0.05
export const ACCORDION_RESET_RATIO = 0.5

export interface TwoSectionSplitLayout {
  showTopBody: boolean
  showBottomBody: boolean
  showResizer: boolean
  topFlexRatio: number | null
  bottomFlexRatio: number | null
}

/**
 * Clamps a two-section accordion height ratio into [0.2, 0.8], falling back cleanly for non-finite inputs.
 */
export function clampSectionHeightRatio(
  ratio: number,
  fallbackRatio = ACCORDION_RESET_RATIO
): number {
  if (!Number.isFinite(ratio)) {
    return fallbackRatio
  }
  return Math.min(ACCORDION_MAX_TOP_RATIO, Math.max(ACCORDION_MIN_TOP_RATIO, ratio))
}

/**
 * Applies a relative ratio delta and rounds away binary float drift before clamping into [0.2, 0.8].
 */
export function stepSectionHeightRatio(
  ratio: number,
  delta: number,
  fallbackRatio = ACCORDION_RESET_RATIO
): number {
  const base = clampSectionHeightRatio(ratio, fallbackRatio)
  const stepped = Math.round((base + delta) * 1000) / 1000
  return clampSectionHeightRatio(stepped, fallbackRatio)
}

/**
 * Converts a section height ratio into a clamped integer percentage in [20, 80].
 */
export function toSectionHeightPercent(
  ratio: number,
  fallbackRatio = ACCORDION_RESET_RATIO
): number {
  return Math.round(clampSectionHeightRatio(ratio, fallbackRatio) * 100)
}

/**
 * Computes accordion body visibility, resizer visibility, and flex growth ratios for two stacked sections.
 */
export function computeTwoSectionLayout(
  isTopCollapsed: boolean,
  isBottomCollapsed: boolean,
  topHeightRatio: number,
  fallbackRatio = ACCORDION_RESET_RATIO
): TwoSectionSplitLayout {
  const showTopBody = !isTopCollapsed
  const showBottomBody = !isBottomCollapsed

  if (showTopBody && showBottomBody) {
    const topFlexRatio = clampSectionHeightRatio(topHeightRatio, fallbackRatio)
    const bottomFlexRatio = Math.round((1 - topFlexRatio) * 1000) / 1000
    return {
      showTopBody: true,
      showBottomBody: true,
      showResizer: true,
      topFlexRatio,
      bottomFlexRatio
    }
  }

  return {
    showTopBody,
    showBottomBody,
    showResizer: false,
    topFlexRatio: showTopBody ? 1 : null,
    bottomFlexRatio: showBottomBody ? 1 : null
  }
}
