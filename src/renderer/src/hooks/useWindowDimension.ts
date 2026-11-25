import { useRef, useSyncExternalStore } from 'react'

function subscribeWindowResize(callback: () => void): () => void {
  window.addEventListener('resize', callback)
  return () => window.removeEventListener('resize', callback)
}

function readPositiveDimension(readValue: () => number, fallback: number): number {
  if (typeof window !== 'undefined') {
    const value = readValue()
    if (Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return fallback
}

/**
 * Tracks a positive `window` viewport dimension across resize events,
 * ignoring transient non-positive values (e.g. minimized windows).
 */
export function useWindowDimension(readValue: () => number, fallback: number): number {
  const lastValidRef = useRef<number>(readPositiveDimension(readValue, fallback))
  return useSyncExternalStore(subscribeWindowResize, () => {
    lastValidRef.current = readPositiveDimension(readValue, lastValidRef.current)
    return lastValidRef.current
  })
}
