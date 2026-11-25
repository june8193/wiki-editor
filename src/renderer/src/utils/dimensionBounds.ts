export interface DimensionBounds {
  min: number
  max: number
  defaultSize: number
}

/**
 * Clamps a numeric size into `[bounds.min, bounds.max]`, falling back safely for non-finite inputs.
 */
export function clampDimension(value: number, bounds: DimensionBounds): number {
  const effectiveMax = Math.max(bounds.min, bounds.max)
  const target = Number.isFinite(value)
    ? value
    : Number.isFinite(bounds.defaultSize)
      ? bounds.defaultSize
      : bounds.min
  return Math.min(effectiveMax, Math.max(bounds.min, target))
}

/**
 * Computes a dynamic upper bound from `viewportSize * ratio`, clamped to `[min, maxCap]`.
 */
export function computeDynamicDimensionMax(
  viewportSize: number,
  min: number,
  maxCap: number,
  ratio: number
): number {
  if (!Number.isFinite(viewportSize)) {
    return maxCap
  }
  return Math.max(min, Math.min(maxCap, viewportSize * ratio))
}
