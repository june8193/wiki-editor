import { useWindowDimension } from './useWindowDimension'

const DEFAULT_FALLBACK_WIDTH = 1024

/**
 * Tracks `window.innerWidth` across resize events while ignoring transient non-positive values (e.g. minimized windows).
 */
export function useWindowWidth(fallbackWidth = DEFAULT_FALLBACK_WIDTH): number {
  return useWindowDimension(() => window.innerWidth, fallbackWidth)
}
