import { clampDimension, computeDynamicDimensionMax } from './dimensionBounds'

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
  return Math.round(
    clampDimension(height, {
      min: bounds.min,
      max: bounds.max,
      defaultSize: bounds.defaultHeight
    })
  )
}

/**
 * Computes terminal panel minimum, dynamic maximum (70% of window height, capped at 640px), and default height.
 */
export function getTerminalHeightBounds(windowHeight: number): TerminalHeightBounds {
  return {
    min: TERMINAL_MIN_HEIGHT,
    max: Math.floor(
      computeDynamicDimensionMax(
        windowHeight,
        TERMINAL_MIN_HEIGHT,
        TERMINAL_MAX_HEIGHT,
        TERMINAL_MAX_WINDOW_RATIO
      )
    ),
    defaultHeight: TERMINAL_DEFAULT_HEIGHT
  }
}
