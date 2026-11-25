export const TERMINAL_DEFAULT_HEIGHT = 240
export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT = 640
export const TERMINAL_MAX_WINDOW_RATIO = 0.7

export interface TerminalHeightBounds {
  min: number
  max: number
  defaultHeight: number
}

/**
 * Clamps a terminal panel height into [bounds.min, bounds.max], falling back safely for non-finite inputs.
 */
export function clampTerminalHeight(height: number, bounds: TerminalHeightBounds): number {
  const effectiveMax = Math.max(bounds.min, bounds.max)
  const target = Number.isFinite(height)
    ? height
    : Number.isFinite(bounds.defaultHeight)
      ? bounds.defaultHeight
      : bounds.min
  return Math.min(effectiveMax, Math.max(bounds.min, Math.round(target)))
}

/**
 * Computes terminal panel minimum, dynamic maximum (70% of window height, capped at 640px), and default height.
 */
export function getTerminalHeightBounds(windowHeight: number): TerminalHeightBounds {
  const max = Number.isFinite(windowHeight)
    ? Math.max(
        TERMINAL_MIN_HEIGHT,
        Math.min(TERMINAL_MAX_HEIGHT, Math.floor(windowHeight * TERMINAL_MAX_WINDOW_RATIO))
      )
    : TERMINAL_MAX_HEIGHT
  return {
    min: TERMINAL_MIN_HEIGHT,
    max,
    defaultHeight: TERMINAL_DEFAULT_HEIGHT
  }
}
