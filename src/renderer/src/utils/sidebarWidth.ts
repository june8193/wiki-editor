import { clampDimension, computeDynamicDimensionMax } from './dimensionBounds'

export const LEFT_SIDEBAR_DEFAULT_WIDTH = 260
export const LEFT_SIDEBAR_MIN_WIDTH = 180
export const LEFT_SIDEBAR_MAX_WIDTH = 600
export const LEFT_SIDEBAR_MAX_WINDOW_RATIO = 0.5

export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 240
export const RIGHT_SIDEBAR_MIN_WIDTH = 180
export const RIGHT_SIDEBAR_MAX_WIDTH = 500

export interface SidebarWidthBounds {
  min: number
  max: number
  defaultWidth: number
}

export const RIGHT_SIDEBAR_WIDTH_BOUNDS: SidebarWidthBounds = {
  min: RIGHT_SIDEBAR_MIN_WIDTH,
  max: RIGHT_SIDEBAR_MAX_WIDTH,
  defaultWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH
}

/**
 * Clamps a sidebar width into [bounds.min, bounds.max], falling back safely for non-finite inputs.
 */
export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  return clampDimension(width, {
    min: bounds.min,
    max: bounds.max,
    defaultSize: bounds.defaultWidth
  })
}

/**
 * Computes left sidebar minimum, dynamic maximum (min(600, windowWidth * 0.5)), and default width.
 */
export function getLeftSidebarWidthBounds(windowWidth: number): SidebarWidthBounds {
  return {
    min: LEFT_SIDEBAR_MIN_WIDTH,
    max: computeDynamicDimensionMax(
      windowWidth,
      LEFT_SIDEBAR_MIN_WIDTH,
      LEFT_SIDEBAR_MAX_WIDTH,
      LEFT_SIDEBAR_MAX_WINDOW_RATIO
    ),
    defaultWidth: LEFT_SIDEBAR_DEFAULT_WIDTH
  }
}
