export const GIT_PANEL_DEFAULT_CHANGES_RATIO = 0.5
export const GIT_PANEL_MIN_CHANGES_RATIO = 0.2
export const GIT_PANEL_MAX_CHANGES_RATIO = 0.8
export const GIT_PANEL_CHANGES_RATIO_STEP = 0.05

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
  if (!Number.isFinite(ratio)) {
    return GIT_PANEL_DEFAULT_CHANGES_RATIO
  }
  return Math.min(GIT_PANEL_MAX_CHANGES_RATIO, Math.max(GIT_PANEL_MIN_CHANGES_RATIO, ratio))
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
  const base = clampChangesHeightRatio(ratio)
  const stepped = Math.round((base + delta) * 1000) / 1000
  return clampChangesHeightRatio(stepped)
}

/**
 * Converts a Changes section height ratio into a clamped integer percentage in [20, 80].
 */
export function toChangesHeightPercent(ratio: number): number {
  return Math.round(clampChangesHeightRatio(ratio) * 100)
}

/**
 * Computes accordion body visibility, resizer visibility, and flex growth ratios for Changes and Graph.
 */
export function computeGitSectionLayout(state: GitPanelSplitState): GitSectionLayout {
  const showChangesBody = !state.isChangesCollapsed
  const showGraphBody = !state.isGraphCollapsed

  if (showChangesBody && showGraphBody) {
    const changesFlexRatio = clampChangesHeightRatio(state.changesHeightRatio)
    const graphFlexRatio = Math.round((1 - changesFlexRatio) * 1000) / 1000
    return {
      showChangesBody: true,
      showGraphBody: true,
      showResizer: true,
      changesFlexRatio,
      graphFlexRatio
    }
  }

  return {
    showChangesBody,
    showGraphBody,
    showResizer: false,
    changesFlexRatio: showChangesBody ? 1 : null,
    graphFlexRatio: showGraphBody ? 1 : null
  }
}
