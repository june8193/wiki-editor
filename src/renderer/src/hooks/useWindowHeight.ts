import { useWindowDimension } from './useWindowDimension'

const DEFAULT_FALLBACK_HEIGHT = 768

/**
 * Tracks `window.innerHeight` across resize events while ignoring transient non-positive values.
 */
export function useWindowHeight(fallbackHeight = DEFAULT_FALLBACK_HEIGHT): number {
  return useWindowDimension(() => window.innerHeight, fallbackHeight)
}
