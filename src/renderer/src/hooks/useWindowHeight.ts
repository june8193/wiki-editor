import { useRef, useSyncExternalStore } from 'react'

const DEFAULT_FALLBACK_HEIGHT = 768

function subscribeWindowResize(callback: () => void): () => void {
  window.addEventListener('resize', callback)
  return () => window.removeEventListener('resize', callback)
}

function readValidWindowHeight(fallback: number): number {
  if (typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0) {
    return window.innerHeight
  }
  return fallback
}

/**
 * Tracks `window.innerHeight` across resize events while ignoring transient non-positive values.
 */
export function useWindowHeight(fallbackHeight = DEFAULT_FALLBACK_HEIGHT): number {
  const lastValidRef = useRef<number>(readValidWindowHeight(fallbackHeight))
  return useSyncExternalStore(subscribeWindowResize, () => {
    lastValidRef.current = readValidWindowHeight(lastValidRef.current)
    return lastValidRef.current
  })
}
