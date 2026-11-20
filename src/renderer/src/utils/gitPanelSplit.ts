import {
  ACCORDION_MAX_TOP_RATIO,
  ACCORDION_MIN_TOP_RATIO,
  ACCORDION_RATIO_STEP,
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  computeTwoSectionLayout,
  stepSectionHeightRatio,
  toSectionHeightPercent
} from './accordionSplit'

export const GIT_PANEL_DEFAULT_CHANGES_RATIO = ACCORDION_RESET_RATIO
export const GIT_PANEL_MIN_CHANGES_RATIO = ACCORDION_MIN_TOP_RATIO
export const GIT_PANEL_MAX_CHANGES_RATIO = ACCORDION_MAX_TOP_RATIO
export const GIT_PANEL_CHANGES_RATIO_STEP = ACCORDION_RATIO_STEP

export interface GitPanelSplitState {
  isChangesCollapsed: boolean
  isGraphCollapsed: boolean
  changesHeightRatio: number
}

export interface GitSectionLayout {
  showChangesBody: boolean
  showGraphBody: boolean
  showResizer: boolean
  changesFlexRatio: number | null
  graphFlexRatio: number | null
}

/**
 * Creates the default session-only split state for the Git panel accordions.
 */
export function createDefaultGitPanelSplitState(): GitPanelSplitState {
  return {
    isChangesCollapsed: false,
    isGraphCollapsed: false,
    changesHeightRatio: GIT_PANEL_DEFAULT_CHANGES_RATIO
  }
}

/**
 * Clamps the Changes section height ratio into [0.2, 0.8], falling back to 0.5 for non-finite inputs.
 */
export function clampChangesHeightRatio(ratio: number): number {
  return clampSectionHeightRatio(ratio, GIT_PANEL_DEFAULT_CHANGES_RATIO)
}

/**
 * Toggles the collapsed state of the Changes accordion section.
 */
export function toggleGitChangesCollapsed(state: GitPanelSplitState): GitPanelSplitState {
  return { ...state, isChangesCollapsed: !state.isChangesCollapsed }
}

/**
 * Toggles the collapsed state of the Graph accordion section.
 */
export function toggleGitGraphCollapsed(state: GitPanelSplitState): GitPanelSplitState {
  return { ...state, isGraphCollapsed: !state.isGraphCollapsed }
}

/**
 * Returns an updated split state with a clamped Changes height ratio, preserving reference equality on no-ops.
 */
export function updateChangesHeightRatio(
  state: GitPanelSplitState,
  nextRatio: number
): GitPanelSplitState {
  const clamped = clampChangesHeightRatio(nextRatio)
  return state.changesHeightRatio === clamped ? state : { ...state, changesHeightRatio: clamped }
}

/**
 * Applies a relative ratio delta and rounds away binary float drift before clamping into [0.2, 0.8].
 */
export function stepChangesHeightRatio(ratio: number, delta: number): number {
  return stepSectionHeightRatio(ratio, delta, GIT_PANEL_DEFAULT_CHANGES_RATIO)
}

/**
 * Converts a Changes section height ratio into a clamped integer percentage in [20, 80].
 */
export function toChangesHeightPercent(ratio: number): number {
  return toSectionHeightPercent(ratio, GIT_PANEL_DEFAULT_CHANGES_RATIO)
}

/**
 * Computes accordion body visibility, resizer visibility, and flex growth ratios for Changes and Graph.
 */
export function computeGitSectionLayout(state: GitPanelSplitState): GitSectionLayout {
  const layout = computeTwoSectionLayout(
    state.isChangesCollapsed,
    state.isGraphCollapsed,
    state.changesHeightRatio,
    GIT_PANEL_DEFAULT_CHANGES_RATIO
  )
  return {
    showChangesBody: layout.showTopBody,
    showGraphBody: layout.showBottomBody,
    showResizer: layout.showResizer,
    changesFlexRatio: layout.topFlexRatio,
    graphFlexRatio: layout.bottomFlexRatio
  }
}
