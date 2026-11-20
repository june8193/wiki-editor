import { clampSectionHeightRatio } from './accordionSplit'

export const RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO = 0.35

export interface RightSidebarSplitState {
  isOutlineCollapsed: boolean
  isPropertiesCollapsed: boolean
  outlineHeightRatio: number
}

/**
 * Creates the default session-only split state for the right sidebar (35% Outline / 65% Properties).
 */
export function createDefaultRightSidebarSplitState(): RightSidebarSplitState {
  return {
    isOutlineCollapsed: false,
    isPropertiesCollapsed: false,
    outlineHeightRatio: RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO
  }
}

/**
 * Toggles the collapsed state of the top Document Outline accordion section.
 */
export function toggleRightSidebarOutlineCollapsed(
  state: RightSidebarSplitState
): RightSidebarSplitState {
  return { ...state, isOutlineCollapsed: !state.isOutlineCollapsed }
}

/**
 * Toggles the collapsed state of the bottom Document Properties accordion section.
 */
export function toggleRightSidebarPropertiesCollapsed(
  state: RightSidebarSplitState
): RightSidebarSplitState {
  return { ...state, isPropertiesCollapsed: !state.isPropertiesCollapsed }
}

/**
 * Updates the clamped Document Outline height ratio while preserving reference equality on no-ops.
 */
export function updateRightSidebarOutlineRatio(
  state: RightSidebarSplitState,
  nextRatio: number
): RightSidebarSplitState {
  const clamped = clampSectionHeightRatio(nextRatio, RIGHT_SIDEBAR_DEFAULT_OUTLINE_RATIO)
  return state.outlineHeightRatio === clamped ? state : { ...state, outlineHeightRatio: clamped }
}
