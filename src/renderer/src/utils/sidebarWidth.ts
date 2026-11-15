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
 * Clamps a sidebar width into [minWidth, maxWidth], falling back safely for non-finite inputs.
 */
export function clampSidebarWidth(
  width: number,
  minWidth: number,
  maxWidth: number,
  fallbackWidth = minWidth
): number {
  const effectiveMax = Math.max(minWidth, maxWidth)
  const target = Number.isFinite(width)
    ? width
    : Number.isFinite(fallbackWidth)
      ? fallbackWidth
      : minWidth
  return Math.min(effectiveMax, Math.max(minWidth, target))
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

/**
 * Clamps a left sidebar width against the bounds derived from the current window width.
 */
export function clampLeftSidebarWidth(width: number, windowWidth: number): number {
  const bounds = getLeftSidebarWidthBounds(windowWidth)
  return clampSidebarWidth(width, bounds.min, bounds.max, bounds.defaultWidth)
}
