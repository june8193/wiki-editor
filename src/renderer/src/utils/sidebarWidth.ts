export const LEFT_SIDEBAR_DEFAULT_WIDTH = 260
export const LEFT_SIDEBAR_MIN_WIDTH = 180
export const LEFT_SIDEBAR_MAX_WIDTH = 600
export const LEFT_SIDEBAR_MAX_WINDOW_RATIO = 0.5

export interface SidebarWidthBounds {
  min: number
  max: number
  defaultWidth: number
}

/**
 * Clamps a sidebar width into [bounds.min, bounds.max], falling back safely for non-finite inputs.
 */
export function clampSidebarWidth(width: number, bounds: SidebarWidthBounds): number {
  const effectiveMax = Math.max(bounds.min, bounds.max)
  const target = Number.isFinite(width)
    ? width
    : Number.isFinite(bounds.defaultWidth)
      ? bounds.defaultWidth
      : bounds.min
  return Math.min(effectiveMax, Math.max(bounds.min, target))
}

/**
 * Computes left sidebar minimum, dynamic maximum (min(600, windowWidth * 0.5)), and default width.
 */
export function getLeftSidebarWidthBounds(windowWidth: number): SidebarWidthBounds {
  const max = Number.isFinite(windowWidth)
    ? Math.max(
        LEFT_SIDEBAR_MIN_WIDTH,
        Math.min(LEFT_SIDEBAR_MAX_WIDTH, windowWidth * LEFT_SIDEBAR_MAX_WINDOW_RATIO)
      )
    : LEFT_SIDEBAR_MAX_WIDTH
  return {
    min: LEFT_SIDEBAR_MIN_WIDTH,
    max,
    defaultWidth: LEFT_SIDEBAR_DEFAULT_WIDTH
  }
}
