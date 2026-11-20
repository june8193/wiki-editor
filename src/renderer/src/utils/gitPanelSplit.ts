import {
  ACCORDION_RESET_RATIO,
  clampSectionHeightRatio,
  computeTwoSectionLayout
} from './accordionSplit'

export const GIT_PANEL_DEFAULT_CHANGES_RATIO = ACCORDION_RESET_RATIO

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
  const clamped = clampSectionHeightRatio(nextRatio, GIT_PANEL_DEFAULT_CHANGES_RATIO)
  return state.changesHeightRatio === clamped ? state : { ...state, changesHeightRatio: clamped }
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
